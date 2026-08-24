use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::config::ConfigState;
use crate::logutil::{decode_bytes, now_ms, strip_ansi, sys_line, LogEmitter, LogLine};

// Arc 로 감싸 do_start/do_stop 에 값으로 넘길 수 있게 함 (Tauri State 는 invoke 수명에 묶여 스레드로 못 들고 감).
#[derive(Clone)]
pub struct ProcState(pub Arc<Mutex<HashMap<String, u32>>>);

impl ProcState {
    pub fn new() -> Self {
        ProcState(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[cfg(windows)]
pub fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn no_window(_cmd: &mut Command) {}

fn find_service(cfg: &ConfigState, id: &str) -> Option<crate::config::ServiceConfig> {
    cfg.0.lock().unwrap().services.iter().find(|s| s.id == id).cloned()
}

fn is_running(proc: &ProcState, id: &str) -> bool {
    proc.0.lock().unwrap().contains_key(id)
}

fn taskkill_pid(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    no_window(&mut cmd);
    let _ = cmd.output();
}

/// stdout/stderr 리더 스레드: 줄 단위로 디코딩+ANSI 제거 후 배치 채널로 전달.
fn reader_thread(mut stream: impl Read + Send + 'static, stream_name: &'static str, tx: mpsc::Sender<LogLine>) {
    std::thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                        let mut line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                        line_bytes.pop(); // remove '\n'
                        if line_bytes.last() == Some(&b'\r') {
                            line_bytes.pop();
                        }
                        let text = strip_ansi(&decode_bytes(&line_bytes));
                        if tx
                            .send(LogLine {
                                ts: now_ms(),
                                stream: stream_name.into(),
                                text,
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if !buf.is_empty() {
            let text = strip_ansi(&decode_bytes(&buf));
            let _ = tx.send(LogLine {
                ts: now_ms(),
                stream: stream_name.into(),
                text,
            });
        }
    });
}

/// 50ms 또는 200줄마다 배치로 log 이벤트 emit.
fn batch_thread<E: LogEmitter>(emitter: E, id: String, rx: mpsc::Receiver<LogLine>) {
    std::thread::spawn(move || {
        let mut batch: Vec<LogLine> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    batch.push(line);
                    if batch.len() >= 200 {
                        emitter.emit_log(&id, std::mem::take(&mut batch));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !batch.is_empty() {
                        emitter.emit_log(&id, std::mem::take(&mut batch));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !batch.is_empty() {
                        emitter.emit_log(&id, std::mem::take(&mut batch));
                    }
                    break;
                }
            }
        }
    });
}

/// 핵심 프로세스 관리 로직. AppHandle 이 아니라 LogEmitter + ProcState/ConfigState 값만 필요해서
/// 실제 Tauri 앱 없이도(tauri::test::MockRuntime 없이) 순수 Rust 테스트로 검증 가능.
pub fn do_start<E: LogEmitter>(emitter: &E, proc: &ProcState, cfg: &ConfigState, id: &str) -> Result<u32, String> {
    if is_running(proc, id) {
        return Err(format!("{id} already running"));
    }
    let service = find_service(cfg, id).ok_or_else(|| format!("unknown service {id}"))?;
    // 프론트에서 이미 폴더 없는 서비스는 Start 버튼을 막지만, 방어적으로 한 번 더 - cwd 가 비면
    // current_dir("") 가 무슨 디렉터리를 대상으로 할지 불명확해서 아예 spawn 자체를 막는다.
    if service.cwd.trim().is_empty() {
        return Err(format!("{id}: 폴더가 설정되지 않았습니다"));
    }
    let command_str = crate::config::effective_command(&service)
        .ok_or_else(|| format!("{id} has no command (git-only service)"))?;

    let mut cmd = Command::new("cmd");
    cmd.args(["/C", &command_str]);
    cmd.current_dir(&service.cwd);
    cmd.envs(service.env.clone());
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let pid = child.id();
    proc.0.lock().unwrap().insert(id.to_string(), pid);
    emitter.emit_status_started(id, pid);

    sys_line(emitter, id, format!("▶ start: {command_str}  ({})", service.cwd));

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let (tx, rx) = mpsc::channel::<LogLine>();
    reader_thread(stdout, "out", tx.clone());
    reader_thread(stderr, "err", tx.clone());
    drop(tx);
    batch_thread(emitter.clone(), id.to_string(), rx);

    let emitter2 = emitter.clone();
    let proc2 = proc.clone();
    let id2 = id.to_string();
    std::thread::spawn(move || {
        let status = child.wait();
        let code = match status {
            Ok(s) => s.code(),
            Err(_) => None,
        };
        proc2.0.lock().unwrap().remove(&id2);
        let code_text = code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        sys_line(&emitter2, &id2, format!("■ exited (code {code_text})"));
        emitter2.emit_status_exited(&id2, code);
    });

    // nginx 는 런처(cmd /C nginx.exe)가 데몬화 직후 곧장 종료돼 위 "■ exited" 로그만 남고 실제로
    // 떴는지 알 수 없음 - 별도로 포트를 최대 5초 폴링해서 결과를 명확한 sys 줄로 남김.
    if service.kind.as_deref() == Some("nginx") {
        if let Some(port) = service.port {
            let emitter3 = emitter.clone();
            let id3 = id.to_string();
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut open = crate::port::port_is_open(port);
                while !open && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(300));
                    open = crate::port::port_is_open(port);
                }
                if open {
                    sys_line(&emitter3, &id3, format!("nginx 기동 확인 (port {port})"));
                } else {
                    sys_line(&emitter3, &id3, format!("port {port} 이 열리지 않음 — error.log 확인"));
                }
            });
        }
    }

    Ok(pid)
}

/// nginx 의 정석 종료: `<cwd>\nginx.exe -s stop` (마스터가 워커까지 정리).
/// 워커 프로세스만 taskkill 하면 마스터가 새 워커를 다시 살려서 이 방법을 먼저 시도해야 함.
/// PATH 검색을 피하려고 cwd 안의 정확한 실행파일 경로를 지정(다른 nginx 인스턴스를 잘못 건드리지 않게).
/// 실행 실패(파일 없음 등)는 무시하고 이후 포트 기반 폴백에 맡김.
fn nginx_graceful_stop<E: LogEmitter>(emitter: &E, id: &str, cwd: &str) {
    let exe = std::path::Path::new(cwd).join("nginx.exe");
    sys_line(emitter, id, "nginx -s stop 시도".to_string());
    let mut cmd = Command::new(&exe);
    cmd.args(["-s", "stop"]);
    cmd.current_dir(cwd);
    no_window(&mut cmd);
    match cmd.output() {
        Ok(out) if out.status.success() => {
            sys_line(emitter, id, "nginx -s stop 완료".to_string());
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            sys_line(emitter, id, format!("nginx -s stop 실패: {err}"));
        }
        Err(e) => {
            sys_line(emitter, id, format!("nginx -s stop 실행 불가({e}) → 포트 기반 종료로 진행"));
        }
    }
}

/// 포트 기반 taskkill 로도 안 닫히면(마스터가 워커를 계속 되살리는 경우) 최후 수단으로 이미지명 전체 종료.
fn nginx_force_kill_all<E: LogEmitter>(emitter: &E, id: &str) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/T", "/IM", "nginx.exe"]);
    no_window(&mut cmd);
    let _ = cmd.output();
    sys_line(emitter, id, "여전히 안 닫힘 → taskkill /F /T /IM nginx.exe 로 강제 종료".to_string());
}

/// taskkill 후 포트가 안 닫히면(gradle daemon fork) 포트 소유 PID 를 찾아 강제 종료.
/// 추적되는 pid 가 없어도(nginx 처럼 시작 직후 데몬화되어 ProcState 에서 곧 빠지는 경우)
/// 설정된 포트가 열려 있으면 포트 기반 kill 로 폴백해서 진행한다.
/// nginx 는 taskkill 전에 `-s stop` 정석 종료부터 시도(①), 그래도 안 닫히면 기존 포트 폴백(②③)에
/// 이어 이미지명 전체 강제 종료(④)까지 단계적으로 진행한다.
pub fn do_stop<E: LogEmitter>(emitter: &E, proc: &ProcState, cfg: &ConfigState, id: &str) -> Result<(), String> {
    let service = find_service(cfg, id);
    let port = service.as_ref().and_then(|s| s.port);
    let is_nginx = service.as_ref().map(|s| s.kind.as_deref() == Some("nginx")).unwrap_or(false);
    let tracked_pid = proc.0.lock().unwrap().get(id).copied();

    let considered_running = tracked_pid.is_some() || port.map(crate::port::port_is_open).unwrap_or(false);
    if !considered_running {
        return Err(format!("{id} not running"));
    }

    // ① nginx 는 다른 무엇보다 정석 종료(-s stop)부터 - cwd 없으면 "<cwd>\nginx.exe" 경로를 만들 수
    // 없으니(빈 경로가 무슨 디렉터리를 뜻할지 불명확) 건너뛰고 바로 아래 taskkill/포트 폴백으로.
    if is_nginx {
        if let Some(s) = &service {
            if !s.cwd.trim().is_empty() {
                nginx_graceful_stop(emitter, id, &s.cwd);
            }
        }
    }

    match tracked_pid {
        Some(pid) => taskkill_pid(pid),
        None => sys_line(emitter, id, "추적 PID 없음 → 포트/정석 종료로 진행".to_string()),
    }

    // ②③ 포트가 여전히 열려있으면(최대 5초 대기) 포트 기반 taskkill 폴백.
    if let Some(port) = port {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut still_open = crate::port::port_is_open(port);
        while still_open && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
            still_open = crate::port::port_is_open(port);
        }
        if still_open {
            let pids = crate::port::port_pids(port);
            for p in &pids {
                taskkill_pid(*p);
            }
            if !pids.is_empty() {
                let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ");
                sys_line(emitter, id, format!("port {port} still busy → killed PID {list}"));
            }
            // ④ nginx 는 워커만 taskkill 하면 마스터가 되살릴 수 있어 최후 수단으로 이미지명 전체 종료.
            if is_nginx && crate::port::port_is_open(port) {
                nginx_force_kill_all(emitter, id);
            }
        }
    }
    Ok(())
}

pub fn do_restart<E: LogEmitter>(emitter: &E, proc: &ProcState, cfg: &ConfigState, id: &str) -> Result<u32, String> {
    do_stop(emitter, proc, cfg, id)?;
    let deadline = Instant::now() + Duration::from_secs(6);
    while is_running(proc, id) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
    }
    do_start(emitter, proc, cfg, id)
}

// (async) 로 메인 스레드 밖(스레드풀)에서 실행 — start/stop 는 프로세스 spawn·포트 대기(최대 5~6초)로 블로킹 가능.
// pid 는 "started" 이벤트가 주 경로지만, 프론트에서 즉시 반영할 수 있게 반환값으로도 준다.
#[tauri::command(async)]
pub fn start_service(app: AppHandle, id: String) -> Result<u32, String> {
    let proc = app.state::<ProcState>().inner().clone();
    let cfg = app.state::<ConfigState>().inner().clone();
    do_start(&app, &proc, &cfg, &id)
}

#[tauri::command(async)]
pub fn stop_service(app: AppHandle, id: String) -> Result<(), String> {
    let proc = app.state::<ProcState>().inner().clone();
    let cfg = app.state::<ConfigState>().inner().clone();
    do_stop(&app, &proc, &cfg, &id)
}

#[tauri::command(async)]
pub fn restart_service(app: AppHandle, id: String) -> Result<u32, String> {
    let proc = app.state::<ProcState>().inner().clone();
    let cfg = app.state::<ConfigState>().inner().clone();
    do_restart(&app, &proc, &cfg, &id)
}

#[tauri::command(async)]
pub fn running_pids(app: AppHandle) -> HashMap<String, u32> {
    app.state::<ProcState>().0.lock().unwrap().clone()
}

#[tauri::command(async)]
pub fn stop_all_and_exit(app: AppHandle) {
    let proc: State<'_, ProcState> = app.state::<ProcState>();
    let cfg = app.state::<ConfigState>().inner().clone();
    let ids: Vec<String> = proc.0.lock().unwrap().keys().cloned().collect();
    let proc_owned = proc.inner().clone();
    let handles: Vec<_> = ids
        .into_iter()
        .map(|id| {
            let app2 = app.clone();
            let proc2 = proc_owned.clone();
            let cfg2 = cfg.clone();
            std::thread::spawn(move || {
                let _ = do_stop(&app2, &proc2, &cfg2, &id);
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
    app.exit(0);
}

#[tauri::command]
pub fn force_exit(app: AppHandle) {
    app.exit(0);
}

/// 실제 프로세스/포트 동작 통합테스트. node 로 가짜 서비스를 spawn 해서 검증 (Tauri 앱 없이 순수 Rust 로 동작).
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::config::{AppConfig, ServiceConfig};
    use crate::logutil::LogLine as LL;
    use std::sync::mpsc::channel;

    // 테스트용 LogEmitter: 이벤트를 실제로 emit 하는 대신 채널/공유 벡터로 모음. Tauri AppHandle 불필요.
    #[derive(Clone)]
    struct TestEmitter {
        tx: mpsc::Sender<(String, Vec<LL>)>,
        started: Arc<Mutex<Vec<(String, u32)>>>,
    }
    impl TestEmitter {
        fn new(tx: mpsc::Sender<(String, Vec<LL>)>) -> Self {
            TestEmitter { tx, started: Arc::new(Mutex::new(Vec::new())) }
        }
    }
    impl LogEmitter for TestEmitter {
        fn emit_log(&self, id: &str, lines: Vec<LL>) {
            let _ = self.tx.send((id.to_string(), lines));
        }
        fn emit_status_started(&self, id: &str, pid: u32) {
            self.started.lock().unwrap().push((id.to_string(), pid));
        }
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    // --noport 를 주면 포트는 열지 않고 로그만 찍음 (gradle 래퍼처럼 "추적되는 PID != 실제 포트 소유자" 재현용).
    fn write_fake_service(dir: &std::path::Path) -> std::path::PathBuf {
        let script = r#"
const net = require('net');
const port = Number(process.argv[2]);
const noPort = process.argv.includes('--noport');
if (!noPort) {
  const server = net.createServer((sock) => sock.end());
  server.listen(port, '127.0.0.1', () => console.log(`[INFO] listening on ${port}`));
}
let n = 0;
setInterval(() => {
  n++;
  console.log(`[INFO] 한글 로그 tick ${n}`);
  if (n % 5 === 0) console.error(`[ERROR] sample stderr line ${n}`);
}, 150);
"#;
        let path = dir.join("fake_service.js");
        std::fs::write(&path, script).unwrap();
        path
    }

    fn make_config(svc: ServiceConfig) -> ConfigState {
        ConfigState::new(AppConfig {
            services: vec![svc],
            start_stagger_ms: 100,
            git_fetch_interval_sec: 300,
            max_log_lines: 5000,
            kind_order: vec!["backend".into(), "frontend".into(), "lib".into(), "nginx".into()],
            pull_mode: "rebase".into(),
        })
    }

    fn wait_until(mut cond: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if cond() {
                return true;
            }
            if Instant::now() >= deadline {
                return cond();
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn do_start_refuses_when_cwd_is_empty() {
        // 프론트에서 이미 Start 버튼을 막지만 방어적으로 한 번 더 - spawn 자체를 절대 시도하면 안 됨(current_dir("")
        // 가 무슨 디렉터리를 대상으로 할지 불명확). 프로세스가 실제로 안 떴는지(ProcState 비어있음)까지 확인.
        let svc = ServiceConfig {
            id: "empty-cwd".into(),
            name: "EmptyCwd".into(),
            cwd: "".into(),
            command: Some("node fake_service.js 12345".into()),
            port: Some(free_port()),
            env: Default::default(),
            kind: Some("backend".into()),
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new();
        let (tx, _rx) = channel();
        let emitter = TestEmitter::new(tx);

        let result = do_start(&emitter, &proc, &cfg, "empty-cwd");
        assert!(result.is_err(), "cwd 없이는 절대 시작되면 안 됨");
        assert!(proc.0.lock().unwrap().is_empty(), "spawn 자체가 안 됐으니 추적 중인 프로세스도 없어야 함");
    }

    #[test]
    fn start_stop_opens_and_closes_port() {
        let tmp = std::env::temp_dir().join(format!("lbm-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        write_fake_service(&tmp);
        let port = free_port();

        // 파일명만 참조(절대경로를 따옴표로 감싸면 cmd /C 재인용 규칙과 충돌해서 --
        // Rust Command 의 인자 자동 이스케이프가 cmd.exe 의 quote-stripping 규칙과 안 맞음).
        // 실제 config.json 커맨드도 항상 이런 단순 형태(예: gradlew.bat bootRun ...).
        let svc = ServiceConfig {
            id: "t1".into(),
            name: "T1".into(),
            cwd: tmp.to_string_lossy().to_string(),
            command: Some(format!("node fake_service.js {port}")),
            port: Some(port),
            env: Default::default(),
            kind: None,
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new();
        let (tx, _rx) = channel();
        let emitter = TestEmitter::new(tx);

        let started_pid = do_start(&emitter, &proc, &cfg, "t1").expect("start should succeed");
        assert!(started_pid > 0, "do_start should return a real pid");
        assert!(wait_until(|| crate::port::port_is_open(port), Duration::from_secs(5)), "port should open after start");
        assert!(proc.0.lock().unwrap().contains_key("t1"));
        {
            let started = emitter.started.lock().unwrap();
            assert_eq!(started.len(), 1, "exactly one status:started event should have been emitted");
            assert_eq!(started[0].0, "t1");
            assert!(started[0].1 > 0, "status:started event should carry a real pid");
        }

        do_stop(&emitter, &proc, &cfg, "t1").expect("stop should succeed");
        assert!(wait_until(|| !crate::port::port_is_open(port), Duration::from_secs(5)), "port should close after stop");
        assert!(
            wait_until(|| !proc.0.lock().unwrap().contains_key("t1"), Duration::from_secs(3)),
            "pid should be removed from map after exit"
        );
    }

    #[test]
    fn stop_falls_back_to_port_kill_when_tracked_pid_is_not_the_real_holder() {
        // gradle daemon 처럼, 앱이 추적하는 PID 가 실제 포트를 쥔 프로세스가 아닌 상황 재현.
        let tmp = std::env::temp_dir().join(format!("lbm-test-fb-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = write_fake_service(&tmp);
        let port = free_port();

        // 실제로 포트를 쥐는 프로세스는 테스트가 직접 띄움 (앱의 추적 대상이 아님, taskkill /PID 로는 못 건드림).
        let mut real_holder = std::process::Command::new("node")
            .arg(&script)
            .arg(port.to_string())
            .current_dir(&tmp)
            .spawn()
            .expect("spawn real port holder");
        assert!(wait_until(|| crate::port::port_is_open(port), Duration::from_secs(5)), "real holder should open port");

        // 앱이 추적하는 프로세스는 포트를 안 여는 래퍼. (파일명만 참조하는 이유는 위 테스트 주석 참고)
        let svc = ServiceConfig {
            id: "t2".into(),
            name: "T2".into(),
            cwd: tmp.to_string_lossy().to_string(),
            command: Some(format!("node fake_service.js {port} --noport")),
            port: Some(port),
            env: Default::default(),
            kind: None,
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new();
        let (tx, rx) = channel();
        let emitter = TestEmitter::new(tx);

        do_start(&emitter, &proc, &cfg, "t2").expect("start should succeed");
        assert!(wait_until(|| proc.0.lock().unwrap().contains_key("t2"), Duration::from_secs(3)));
        let started_snapshot = emitter.started.lock().unwrap().clone();
        let tracked_pid = proc.0.lock().unwrap()["t2"];
        assert_eq!(started_snapshot, vec![("t2".to_string(), tracked_pid)]);

        do_stop(&emitter, &proc, &cfg, "t2").expect("stop should succeed");
        assert!(
            wait_until(|| !crate::port::port_is_open(port), Duration::from_secs(6)),
            "port should eventually close via the fallback kill"
        );

        // 그냥 포트가 닫힌 게 아니라 "still busy → killed PID" 폴백 분기를 실제로 탔는지 증명.
        let mut saw_fallback = false;
        while let Ok((_id, lines)) = rx.try_recv() {
            if lines.iter().any(|l| l.text.contains("still busy")) {
                saw_fallback = true;
            }
        }
        assert!(saw_fallback, "fallback kill sys log line should have been emitted");

        let _ = real_holder.kill();
        let _ = real_holder.wait();
    }

    #[test]
    fn stop_uses_port_fallback_when_id_was_never_tracked() {
        // nginx 처럼 시작 직후 데몬화되어 ProcState 에 전혀 등록되지 않은(or 이미 빠진) 상황 재현:
        // do_start 를 거치지 않고 테스트가 직접 포트를 여는 프로세스를 띄운 뒤 do_stop 만 호출.
        let tmp = std::env::temp_dir().join(format!("lbm-test-untracked-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = write_fake_service(&tmp);
        let port = free_port();

        let mut real_holder = std::process::Command::new("node")
            .arg(&script)
            .arg(port.to_string())
            .current_dir(&tmp)
            .spawn()
            .expect("spawn real port holder");
        assert!(wait_until(|| crate::port::port_is_open(port), Duration::from_secs(5)));

        // kind 를 nginx 로 두지 않음(None) - 이 테스트는 "kind 조건이 아니라 상태 조건" 인 일반 포트 폴백
        // 메커니즘 자체를 검증하는 목적이라, 별도의 nginx -s stop 시도 경로는 안 타게 함.
        let svc = ServiceConfig {
            id: "nx".into(),
            name: "NX".into(),
            cwd: tmp.to_string_lossy().to_string(),
            command: Some("some.exe".into()),
            port: Some(port),
            env: Default::default(),
            kind: None,
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new(); // 빈 맵 — 이 id 는 한 번도 추적된 적 없음
        let (tx, rx) = channel();
        let emitter = TestEmitter::new(tx);

        do_stop(&emitter, &proc, &cfg, "nx").expect("port-based stop should succeed even without a tracked pid");
        assert!(wait_until(|| !crate::port::port_is_open(port), Duration::from_secs(5)));

        let mut saw_fallback = false;
        while let Ok((_id, lines)) = rx.try_recv() {
            if lines.iter().any(|l| l.text.contains("추적 PID 없음")) {
                saw_fallback = true;
            }
        }
        assert!(saw_fallback, "포트 기반 종료 sys 로그가 남아야 함");

        let _ = real_holder.wait();
    }

    #[test]
    fn stop_errors_when_untracked_and_port_closed() {
        let svc = ServiceConfig {
            id: "nx2".into(),
            name: "NX2".into(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            command: Some("some.exe".into()),
            port: Some(free_port()), // 아무도 안 여는 포트
            env: Default::default(),
            kind: None,
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new();
        let (tx, _rx) = channel();
        let emitter = TestEmitter::new(tx);

        assert!(do_stop(&emitter, &proc, &cfg, "nx2").is_err());
    }

    // 이하 nginx 전용 종료 시퀀스 테스트. 안전 주의: 실제 PC 에 진짜 nginx.exe 가 떠 있을 수 있으므로,
    // 여기서는 절대 nginx_force_kill_all(taskkill /IM nginx.exe, 전역 명령) 분기에 도달하지 않게
    // "포트는 처음부터 끝까지 안 열림" 상황만 구성한다. nginx_graceful_stop 은 cwd 안의 정확한
    // "<cwd>\nginx.exe" 절대경로만 실행하므로(PATH 검색 없음) 테스트 임시폴더에 그 파일이 없으면
    // 항상 안전하게 실패("파일 없음")하고 넘어간다 - 실제 시스템 nginx 를 절대 건드리지 않음.
    #[test]
    fn nginx_stop_tries_graceful_stop_first_and_never_reaches_force_kill_all() {
        let tmp = std::env::temp_dir().join(format!("lbm-test-nginx-graceful-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = write_fake_service(&tmp);
        let port = free_port(); // 아무도 열지 않을 포트(닫힌 채로 유지)

        // taskkill_pid 에게 진짜(하지만 무해한, 테스트가 직접 소유한) PID 를 주기 위해 --noport 로 띄움.
        let mut tracked = std::process::Command::new("node")
            .arg(&script)
            .arg(port.to_string())
            .arg("--noport")
            .current_dir(&tmp)
            .spawn()
            .expect("spawn tracked process");
        let tracked_pid = tracked.id();

        let svc = ServiceConfig {
            id: "nx3".into(),
            name: "NX3".into(),
            cwd: tmp.to_string_lossy().to_string(),
            command: Some("nginx.exe".into()),
            port: Some(port),
            env: Default::default(),
            kind: Some("nginx".into()),
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new();
        proc.0.lock().unwrap().insert("nx3".to_string(), tracked_pid);
        let (tx, rx) = channel();
        let emitter = TestEmitter::new(tx);

        do_stop(&emitter, &proc, &cfg, "nx3").expect("stop should succeed via tracked pid path");

        let mut saw_graceful_attempt = false;
        let mut saw_force_kill_all = false;
        while let Ok((_id, lines)) = rx.try_recv() {
            for l in &lines {
                if l.text.contains("nginx -s stop 시도") {
                    saw_graceful_attempt = true;
                }
                if l.text.contains("taskkill /F /T /IM nginx.exe") {
                    saw_force_kill_all = true;
                }
            }
        }
        assert!(saw_graceful_attempt, "nginx -s stop 시도 로그가 남아야 함");
        assert!(!saw_force_kill_all, "포트가 원래 닫혀있던 상황에서는 전역 강제종료까지 가면 안 됨");

        let _ = tracked.wait();
    }

    #[test]
    fn nginx_stop_skips_graceful_stop_when_cwd_is_empty_but_still_stops_via_taskkill() {
        // cwd 가 없으면 "<cwd>\nginx.exe" 경로를 만들 수 없어(빈 경로가 무슨 디렉터리인지 불명확) -s stop
        // 시도 자체를 건너뛰고, 그래도 추적 PID 기반 taskkill 로는 정상 종료돼야 함.
        let tmp = std::env::temp_dir().join(format!("lbm-test-nginx-emptycwd-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = write_fake_service(&tmp);
        let port = free_port();

        let mut tracked = std::process::Command::new("node")
            .arg(&script)
            .arg(port.to_string())
            .arg("--noport")
            .current_dir(&tmp)
            .spawn()
            .expect("spawn tracked process");
        let tracked_pid = tracked.id();

        let svc = ServiceConfig {
            id: "nx-empty".into(),
            name: "NXEmpty".into(),
            cwd: "".into(),
            command: Some("nginx.exe".into()),
            port: Some(port),
            env: Default::default(),
            kind: Some("nginx".into()),
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new();
        proc.0.lock().unwrap().insert("nx-empty".to_string(), tracked_pid);
        let (tx, rx) = channel();
        let emitter = TestEmitter::new(tx);

        do_stop(&emitter, &proc, &cfg, "nx-empty").expect("stop should still succeed via tracked pid");

        let mut saw_graceful_attempt = false;
        while let Ok((_id, lines)) = rx.try_recv() {
            for l in &lines {
                if l.text.contains("nginx -s stop 시도") {
                    saw_graceful_attempt = true;
                }
            }
        }
        assert!(!saw_graceful_attempt, "cwd 없으면 -s stop 시도 자체를 건너뛰어야 함");

        let _ = tracked.wait();
    }

    #[test]
    fn stop_without_port_uses_plain_taskkill_tree_kill() {
        // 프론트 dev 서버처럼 포트를 선택 입력으로 비워둔 서비스는 do_stop 이 포트 대기/폴백 블록을
        // 아예 안 타고 taskkill 트리 kill 만으로 끝나야 함 - 실제로 프로세스가 죽는지까지 확인.
        let tmp = std::env::temp_dir().join(format!("lbm-test-noport-stop-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let script = write_fake_service(&tmp);
        let port = free_port();

        let mut tracked = std::process::Command::new("node")
            .arg(&script)
            .arg(port.to_string())
            .arg("--noport")
            .current_dir(&tmp)
            .spawn()
            .expect("spawn tracked process");
        let tracked_pid = tracked.id();

        let svc = ServiceConfig {
            id: "fe1".into(),
            name: "FE1".into(),
            cwd: tmp.to_string_lossy().to_string(),
            command: Some("npm run dev".into()),
            port: None,
            env: Default::default(),
            kind: Some("frontend".into()),
            short: None,
            include_in_all: true,
        };
        let cfg = make_config(svc);
        let proc = ProcState::new();
        proc.0.lock().unwrap().insert("fe1".to_string(), tracked_pid);
        let (tx, _rx) = channel();
        let emitter = TestEmitter::new(tx);

        do_stop(&emitter, &proc, &cfg, "fe1").expect("stop should succeed via plain taskkill even without a port");

        assert!(
            wait_until(|| matches!(tracked.try_wait(), Ok(Some(_))), Duration::from_secs(5)),
            "taskkill 로 프로세스가 실제로 종료돼야 함"
        );
    }
}
