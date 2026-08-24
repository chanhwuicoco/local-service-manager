use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::logutil::sys_line;
use crate::process::no_window;

fn tcp_connect_open(addr: SocketAddr) -> bool {
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// IPv4 loopback(127.0.0.1) 을 먼저 보고, 닫혀 있으면 IPv6 loopback([::1])도 확인한다.
/// 최신 Node/Vite 등 dev 서버가 IPv6 전용으로 바인딩되는 경우(127.0.0.1 은 닫히고 [::1] 만
/// LISTENING)가 흔한데, IPv4 만 보면 실제로 떠 있는 서비스가 빨간불(중지)로 오판됨.
/// 순차 확인이지만 각각 200ms 타임아웃이라 서비스당 최악의 경우도 400ms 를 넘지 않음.
pub fn port_is_open(port: u16) -> bool {
    let v4: SocketAddr = ([127, 0, 0, 1], port).into();
    if tcp_connect_open(v4) {
        return true;
    }
    let v6: SocketAddr = (std::net::Ipv6Addr::LOCALHOST, port).into();
    tcp_connect_open(v6)
}

/// `netstat -ano` 출력(IPv4 "TCP" + IPv6 "TCP6" 행 모두 포함, `-p tcp` 로 필터링하면 IPv6 행이
/// 통째로 빠짐)에서 LISTENING 상태인 포트의 PID 목록 추출. IPv6 주소는 `[::1]:8090`/`[::]:8090`
/// 형태라 `:port` suffix 매칭 자체는 IPv4/IPv6 공통으로 그대로 동작함.
pub fn parse_netstat_pids(output: &str, port: u16) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        if cols[0] != "TCP" && cols[0] != "TCP6" {
            continue;
        }
        if cols[3] != "LISTENING" {
            continue;
        }
        if !cols[1].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

fn netstat_output() -> String {
    let mut cmd = Command::new("netstat");
    // -p tcp 로 필터링하면 Windows 는 IPv4 "TCP" 행만 주고 IPv6 "TCP6" 행은 통째로 빠뜨림 -
    // 필터 없이 -ano 만 써서 TCP/TCP6/UDP/UDP6 를 다 받고, 파싱 단계에서 TCP/TCP6 만 골라낸다.
    cmd.args(["-ano"]);
    no_window(&mut cmd);
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => String::new(),
    }
}

// 포트별로 스레드를 띄워 병렬로 확인(순차면 닫힌 포트마다 누적됨). port_is_open 자체가 IPv4 실패 시
// IPv6 도 재시도하므로 포트 1개당 최악 400ms(200ms+200ms) - 포트 간은 병렬이라 전체 소요는 그대로 최악 400ms.
// (async) 라 이 함수 자체도 메인 스레드가 아닌 별도 스레드에서 실행됨.
#[tauri::command(async)]
pub fn check_ports(ports: Vec<u16>) -> HashMap<u16, bool> {
    let results: Mutex<HashMap<u16, bool>> = Mutex::new(HashMap::with_capacity(ports.len()));
    std::thread::scope(|scope| {
        for &port in &ports {
            let results = &results;
            scope.spawn(move || {
                let open = port_is_open(port);
                results.lock().unwrap().insert(port, open);
            });
        }
    });
    results.into_inner().unwrap()
}

#[tauri::command(async)]
pub fn port_pids(port: u16) -> Vec<u32> {
    parse_netstat_pids(&netstat_output(), port)
}

/// kill_port 커맨드의 실제 로직. AppHandle 대신 LogEmitter + ProcState/ConfigState 값만 필요해서
/// process.rs 의 do_start/do_stop 과 같은 패턴으로 Tauri 앱 없이 순수 Rust 테스트로 검증 가능.
/// nginx 는 일반 taskkill(워커만 죽여 마스터가 되살리는 오동작 위험)이 아니라 do_stop 의 전용
/// 종료 시퀀스(-s stop 우선)로 라우팅한다 - 프론트에서 이미 Kill Port 버튼을 숨겼지만 방어적으로 한 번 더 막음.
pub fn do_kill_port<E: crate::logutil::LogEmitter>(
    emitter: &E,
    proc: &crate::process::ProcState,
    cfg: &crate::config::ConfigState,
    id: &str,
    port: u16,
) {
    let is_nginx = cfg
        .0
        .lock()
        .unwrap()
        .services
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.kind.as_deref() == Some("nginx"))
        .unwrap_or(false);
    if is_nginx {
        let _ = crate::process::do_stop(emitter, proc, cfg, id);
        return;
    }

    let pids = port_pids(port);
    for p in &pids {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &p.to_string(), "/T", "/F"]);
        no_window(&mut cmd);
        let _ = cmd.output();
    }
    if pids.is_empty() {
        sys_line(emitter, id, format!("port {port}: no LISTENING pid found"));
    } else {
        let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ");
        sys_line(emitter, id, format!("kill port {port} → killed PID {list}"));
    }
}

#[tauri::command(async)]
pub fn kill_port(app: AppHandle, id: String, port: u16) {
    let proc = app.state::<crate::process::ProcState>().inner().clone();
    let cfg = app.state::<crate::config::ConfigState>().inner().clone();
    do_kill_port(&app, &proc, &cfg, &id, port);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:8082           0.0.0.0:0              LISTENING       18455
  TCP    127.0.0.1:8082         127.0.0.1:51000        ESTABLISHED     18455
  TCP    [::]:8082              [::]:0                 LISTENING       18455
  TCP    0.0.0.0:18082          0.0.0.0:0              LISTENING       9999
";

    #[test]
    fn parses_listening_pid_for_exact_port() {
        assert_eq!(parse_netstat_pids(SAMPLE, 8082), vec![18455]);
    }

    #[test]
    fn ignores_established_lines() {
        // 8082 은 LISTENING 한 줄만 있어야 함 (ESTABLISHED 제외, [::] 중복 pid 제거)
        assert_eq!(parse_netstat_pids(SAMPLE, 8082).len(), 1);
    }

    #[test]
    fn does_not_match_longer_port_as_substring() {
        let pids = parse_netstat_pids(SAMPLE, 18082);
        assert_eq!(pids, vec![9999]);
    }

    #[test]
    fn returns_empty_for_unknown_port() {
        assert!(parse_netstat_pids(SAMPLE, 9999).is_empty());
    }

    // 실측 버그 재현용 샘플: 최신 Vite/Node dev 서버가 IPv4(127.0.0.1)는 안 열고 IPv6([::1])에만
    // 바인딩된 경우 - Windows netstat 은 이런 행의 Proto 를 "TCP" 가 아니라 "TCP6" 로 표기한다.
    const SAMPLE_IPV6_ONLY: &str = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP6   [::1]:8090             [::]:0                 LISTENING       20211
  TCP6   [::]:8090              [::]:0                 LISTENING       20211
  UDP    0.0.0.0:8090           *:*                                    5555
";

    #[test]
    fn parses_tcp6_listening_pid_when_bound_ipv6_only() {
        assert_eq!(parse_netstat_pids(SAMPLE_IPV6_ONLY, 8090), vec![20211]);
    }

    #[test]
    fn ignores_udp_rows_that_lack_a_state_column() {
        // UDP 행은 State 컬럼이 없어 총 4열 - cols.len() < 5 로 자연히 걸러져야 함.
        assert!(!parse_netstat_pids(SAMPLE_IPV6_ONLY, 8090).contains(&5555));
    }

    fn free_v4_port() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind free ipv4 port");
        listener.local_addr().unwrap().port()
        // listener 가 여기서 drop 되며 포트가 즉시 반납됨.
    }

    #[test]
    fn port_is_open_detects_ipv6_only_listener() {
        // 실측 버그 재현: 127.0.0.1 은 전혀 열지 않고 IPv6 loopback([::1])에만 바인딩된 리스너를
        // 실제로 띄워서, 종전엔(IPv4 만 봄) 놓쳤을 상황을 port_is_open 이 open 으로 판정하는지 확인.
        let listener = std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0)).expect("bind ipv6-only listener");
        let port = listener.local_addr().unwrap().port();
        assert!(port_is_open(port), "IPv6 전용 리스너도 open 으로 판정돼야 함(폴백 확인)");
        drop(listener);
    }

    #[test]
    fn port_is_open_false_when_both_v4_and_v6_are_closed() {
        let port = free_v4_port();
        assert!(!port_is_open(port));
    }

    #[test]
    fn port_pids_finds_real_ipv6_only_listener_via_real_netstat() {
        // 합성 fixture 가 아니라 실제 OS netstat.exe 를 통한 종단 검증 - 이 테스트 프로세스 자신이
        // IPv6 전용으로 리슨하는 실제 소켓을 열고, 실제 PID(std::process::id())가 조회되는지 확인.
        // (실측 결과: 이 환경의 Windows netstat 은 IPv6 행도 Proto 를 "TCP6" 가 아니라 "TCP"로 표기하고
        // 주소만 [::1]:port 형태 - 그래서 진짜 원인은 -p tcp 필터가 이 행을 통째로 빠뜨리는 것이었음.)
        let listener = std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0)).expect("bind ipv6-only listener");
        let port = listener.local_addr().unwrap().port();
        let my_pid = std::process::id();

        let mut found = false;
        for _ in 0..15 {
            if parse_netstat_pids(&netstat_output(), port).contains(&my_pid) {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(found, "실제 netstat 에서 IPv6 전용 리스너의 PID 를 찾아야 함(-p tcp 필터 제거 확인)");
        drop(listener);
    }

    // do_kill_port 라우팅 테스트용 최소 로그 더블. process.rs live_tests 의 TestEmitter 와 같은 목적이지만
    // 그쪽은 mod 안에 비공개라 재사용이 안 돼(파일 간 테스트 헬퍼 미공유가 이 코드베이스의 기존 패턴) 여기 별도로 둠.
    #[derive(Clone)]
    struct TestEmitter {
        lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }
    impl TestEmitter {
        fn new() -> Self {
            TestEmitter { lines: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())) }
        }
        fn contains(&self, needle: &str) -> bool {
            self.lines.lock().unwrap().iter().any(|t| t.contains(needle))
        }
    }
    impl crate::logutil::LogEmitter for TestEmitter {
        fn emit_log(&self, _id: &str, lines: Vec<crate::logutil::LogLine>) {
            let mut store = self.lines.lock().unwrap();
            for l in lines {
                store.push(l.text);
            }
        }
    }

    fn make_config(svc: crate::config::ServiceConfig) -> crate::config::ConfigState {
        crate::config::ConfigState::new(crate::config::AppConfig {
            services: vec![svc],
            start_stagger_ms: 100,
            git_fetch_interval_sec: 300,
            max_log_lines: 5000,
            kind_order: vec!["backend".into(), "frontend".into(), "lib".into(), "nginx".into()],
            pull_mode: "rebase".into(),
        })
    }

    fn svc(id: &str, kind: Option<&str>, port: Option<u16>) -> crate::config::ServiceConfig {
        crate::config::ServiceConfig {
            id: id.into(),
            name: id.into(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            command: None,
            port,
            env: HashMap::new(),
            kind: kind.map(|k| k.to_string()),
            short: None,
            include_in_all: true,
        }
    }

    #[test]
    fn do_kill_port_routes_nginx_service_to_dedicated_stop_sequence_not_plain_taskkill() {
        // 안전 근거: nginx_graceful_stop 은 "<cwd>\nginx.exe" 정확한 경로만 실행(PATH 검색 없음)하는데
        // 테스트 cwd(temp_dir)엔 그 파일이 없어 항상 안전하게 실패하고 넘어감 - 실제 시스템 nginx 는 절대 안 건드림.
        // port 는 None 으로 둬서 do_stop 의 포트 폴백(대기 루프)까지도 안 타고 taskkill_pid 로 바로 끝나게 함.
        let mut tracked = Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1", ">NUL"])
            .spawn()
            .expect("spawn harmless tracked process");
        let tracked_pid = tracked.id();

        let cfg = make_config(svc("nx", Some("nginx"), None));
        let proc = crate::process::ProcState::new();
        proc.0.lock().unwrap().insert("nx".to_string(), tracked_pid);
        let emitter = TestEmitter::new();

        do_kill_port(&emitter, &proc, &cfg, "nx", 19999);

        assert!(emitter.contains("nginx -s stop 시도"), "nginx 는 kill_port 호출이어도 -s stop 정석 종료부터 시도해야 함");
        assert!(!emitter.contains("kill port"), "일반 taskkill 경로(kill port ... → killed PID ...) 로 새면 안 됨");
        assert!(!emitter.contains("no LISTENING pid found"), "일반 경로 메시지가 섞이면 안 됨");

        let _ = tracked.wait();
    }

    #[test]
    fn do_kill_port_uses_plain_taskkill_path_for_non_nginx_kind() {
        let cfg = make_config(svc("be", Some("backend"), Some(19998)));
        let proc = crate::process::ProcState::new();
        let emitter = TestEmitter::new();

        // 19998 은 아무도 안 듣는 포트 - 기존 일반 경로(port_pids 조회) 그대로 타는지만 확인.
        do_kill_port(&emitter, &proc, &cfg, "be", 19998);

        assert!(emitter.contains("no LISTENING pid found"), "비 nginx 는 기존 포트 기반 taskkill 경로를 그대로 타야 함");
        assert!(!emitter.contains("nginx -s stop"), "nginx 전용 시퀀스가 섞이면 안 됨");
    }
}
