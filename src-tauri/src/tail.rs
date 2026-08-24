use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::logutil::{decode_bytes, now_ms, strip_ansi, LogEmitter, LogLine};

const MISSING_RETRY: Duration = Duration::from_millis(2000);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 파일 하나의 tail 진행 상태(폴링 사이 유지). 마지막 줄이 개행 없이 끝나면 leftover 에 보관.
#[derive(Default)]
pub struct TailFileState {
    pos: u64,
    started: bool,
    leftover: Vec<u8>,
}

/// 파일을 한 번 폴링해 새로 추가된 완결 줄들을 반환하는 순수 함수 — 스레드/타이머 없이 테스트 가능.
/// - 파일이 없으면 빈 벡터(다음 폴링에 재시도).
/// - 첫 호출은 현재 EOF 위치만 기록하고 빈 벡터를 반환(기존 내용은 덤프하지 않음).
/// - 파일 크기가 이전보다 줄었으면(rotate/truncate) 처음부터 다시 읽음.
pub fn tail_step(path: &Path, state: &mut TailFileState) -> Vec<String> {
    let Ok(meta) = fs::metadata(path) else { return Vec::new() };
    let len = meta.len();

    if !state.started {
        state.pos = len;
        state.started = true;
        return Vec::new();
    }
    if len < state.pos {
        state.pos = 0;
        state.leftover.clear();
    }
    if len <= state.pos {
        return Vec::new();
    }

    let Ok(mut f) = fs::File::open(path) else { return Vec::new() };
    if f.seek(SeekFrom::Start(state.pos)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    state.pos += buf.len() as u64;
    state.leftover.extend_from_slice(&buf);

    let mut lines = Vec::new();
    while let Some(idx) = state.leftover.iter().position(|&b| b == b'\n') {
        let mut line_bytes: Vec<u8> = state.leftover.drain(..=idx).collect();
        line_bytes.pop(); // '\n' 제거
        if line_bytes.last() == Some(&b'\r') {
            line_bytes.pop();
        }
        lines.push(strip_ansi(&decode_bytes(&line_bytes)));
    }
    lines
}

/// 서비스 id -> 실행 중인 tail 스레드들의 중지 플래그. save_config 시 전체 재구성(중지 후 재시작)에 사용.
pub struct TailRegistry(pub Mutex<HashMap<String, Vec<Arc<AtomicBool>>>>);

impl TailRegistry {
    pub fn new() -> Self {
        TailRegistry(Mutex::new(HashMap::new()))
    }
}

fn spawn_one<E: LogEmitter>(emitter: E, id: String, path: PathBuf, stream: &'static str, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut state = TailFileState::default();
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let exists = path.is_file();
            let lines = if exists { tail_step(&path, &mut state) } else { Vec::new() };
            if !lines.is_empty() {
                let now = now_ms();
                let batch: Vec<LogLine> = lines
                    .into_iter()
                    .map(|text| LogLine { ts: now, stream: stream.into(), text })
                    .collect();
                emitter.emit_log(&id, batch);
            }
            std::thread::sleep(if exists { POLL_INTERVAL } else { MISSING_RETRY });
        }
    });
}

/// cwd 절대/상대 경로 판단: 상대경로면 cwd 기준으로 합침.
fn resolve_relative(cwd: &Path, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    }
}

/// conf/nginx.conf 의 error_log/access_log 지시자로 실제 tail 대상 경로를 결정.
/// conf 가 없거나 파싱 실패하면 기존 관례 경로(logs/error.log, logs/access.log)로 폴백.
fn resolve_log_paths(cwd: &str) -> (PathBuf, PathBuf) {
    let dir = Path::new(cwd);
    let conf_text = fs::read_to_string(dir.join("conf/nginx.conf")).ok();
    let error_path = conf_text
        .as_deref()
        .and_then(crate::inspect::parse_nginx_error_log_path)
        .map(|p| resolve_relative(dir, &p))
        .unwrap_or_else(|| dir.join("logs/error.log"));
    let access_path = conf_text
        .as_deref()
        .and_then(crate::inspect::parse_nginx_access_log_path)
        .map(|p| resolve_relative(dir, &p))
        .unwrap_or_else(|| dir.join("logs/access.log"));
    (error_path, access_path)
}

/// nginx 서비스 목록 기준으로 error.log("err")/access.log("out") tail 스레드를 전체 재구성.
/// 기존 스레드를 전부 중지시키고 새로 시작하는 단순한 방식 — 서비스가 안 바뀌어도 tail 위치가
/// EOF 로 리셋되지만(짧은 공백 가능) 구현이 단순하고 항상 최신 서비스 목록과 일치함이 보장됨.
pub fn reconcile<E: LogEmitter + 'static>(emitter: E, registry: &TailRegistry, nginx_services: &[(String, String)]) {
    let mut map = registry.0.lock().unwrap();
    for (_, stops) in map.drain() {
        for stop in stops {
            stop.store(true, Ordering::Relaxed);
        }
    }
    for (id, cwd) in nginx_services {
        let (error_path, access_path) = resolve_log_paths(cwd);
        let stop_err = Arc::new(AtomicBool::new(false));
        let stop_out = Arc::new(AtomicBool::new(false));
        spawn_one(emitter.clone(), id.clone(), error_path, "err", stop_err.clone());
        spawn_one(emitter.clone(), id.clone(), access_path, "out", stop_out.clone());
        map.insert(id.clone(), vec![stop_err, stop_out]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logutil::LogLine as LL;
    use std::sync::mpsc;

    #[test]
    fn resolve_log_paths_falls_back_to_logs_dir_when_no_conf() {
        let tmp = std::env::temp_dir().join(format!("lbm-resolve-{}-nofallback", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let (err, acc) = resolve_log_paths(&tmp.to_string_lossy());
        assert_eq!(err, tmp.join("logs/error.log"));
        assert_eq!(acc, tmp.join("logs/access.log"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_log_paths_uses_conf_relative_paths() {
        let tmp = std::env::temp_dir().join(format!("lbm-resolve-{}-rel", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("conf")).unwrap();
        std::fs::write(
            tmp.join("conf/nginx.conf"),
            "error_log logs/custom-error.log warn;\naccess_log logs/custom-access.log main;\n",
        )
        .unwrap();
        let (err, acc) = resolve_log_paths(&tmp.to_string_lossy());
        assert_eq!(err, tmp.join("logs/custom-error.log"));
        assert_eq!(acc, tmp.join("logs/custom-access.log"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_log_paths_uses_conf_absolute_path_as_is() {
        let tmp = std::env::temp_dir().join(format!("lbm-resolve-{}-abs", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("conf")).unwrap();
        let abs_log = std::env::temp_dir().join("lbm-abs-error.log");
        std::fs::write(
            tmp.join("conf/nginx.conf"),
            format!("error_log {} ;\n", abs_log.to_string_lossy().replace('\\', "/")),
        )
        .unwrap();
        let (err, _acc) = resolve_log_paths(&tmp.to_string_lossy());
        // 절대경로면 cwd 와 합치지 않고 그대로 써야 함.
        assert_eq!(err.to_string_lossy().replace('\\', "/"), abs_log.to_string_lossy().replace('\\', "/"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn first_poll_records_eof_without_emitting_existing_content() {
        let tmp = std::env::temp_dir().join(format!("lbm-tail-{}-a", std::process::id()));
        std::fs::write(&tmp, "old line 1\nold line 2\n").unwrap();
        let mut state = TailFileState::default();
        let lines = tail_step(&tmp, &mut state);
        assert!(lines.is_empty(), "첫 폴링은 기존 내용을 덤프하면 안 됨");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn appended_lines_are_emitted_on_next_poll() {
        let tmp = std::env::temp_dir().join(format!("lbm-tail-{}-b", std::process::id()));
        std::fs::write(&tmp, "old line\n").unwrap();
        let mut state = TailFileState::default();
        tail_step(&tmp, &mut state); // 첫 폴링: EOF 위치만 기록

        let mut f = std::fs::OpenOptions::new().append(true).open(&tmp).unwrap();
        use std::io::Write;
        writeln!(f, "new line 1").unwrap();
        writeln!(f, "new line 2").unwrap();
        drop(f);

        let lines = tail_step(&tmp, &mut state);
        assert_eq!(lines, vec!["new line 1".to_string(), "new line 2".to_string()]);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn incomplete_line_without_newline_is_held_until_next_poll() {
        let tmp = std::env::temp_dir().join(format!("lbm-tail-{}-c", std::process::id()));
        std::fs::write(&tmp, "").unwrap();
        let mut state = TailFileState::default();
        tail_step(&tmp, &mut state);

        std::fs::write(&tmp, "partial-no-newline").unwrap();
        let lines = tail_step(&tmp, &mut state);
        assert!(lines.is_empty(), "개행 없는 줄은 아직 완결되지 않았으므로 보류");

        let mut f = std::fs::OpenOptions::new().append(true).open(&tmp).unwrap();
        use std::io::Write;
        writeln!(f).unwrap();
        drop(f);
        let lines2 = tail_step(&tmp, &mut state);
        assert_eq!(lines2, vec!["partial-no-newline".to_string()]);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn truncated_file_reseeks_from_start() {
        let tmp = std::env::temp_dir().join(format!("lbm-tail-{}-d", std::process::id()));
        std::fs::write(&tmp, "aaaaaaaaaa\n").unwrap();
        let mut state = TailFileState::default();
        tail_step(&tmp, &mut state); // EOF 기록 (pos = 11)

        // rotate/truncate: 더 짧은 새 내용으로 교체.
        std::fs::write(&tmp, "short\n").unwrap();
        let lines = tail_step(&tmp, &mut state);
        assert_eq!(lines, vec!["short".to_string()], "파일이 줄면 처음부터 다시 읽어야 함");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn missing_file_returns_empty_and_does_not_error() {
        let tmp = std::env::temp_dir().join(format!("lbm-tail-{}-missing", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let mut state = TailFileState::default();
        assert!(tail_step(&tmp, &mut state).is_empty());
        assert!(tail_step(&tmp, &mut state).is_empty());
    }

    #[derive(Clone)]
    struct TestEmitter {
        tx: mpsc::Sender<(String, Vec<LL>)>,
    }
    impl LogEmitter for TestEmitter {
        fn emit_log(&self, id: &str, lines: Vec<LL>) {
            let _ = self.tx.send((id.to_string(), lines));
        }
    }

    #[test]
    fn reconcile_starts_and_stops_threads_matching_service_list() {
        let tmp = std::env::temp_dir().join(format!("lbm-tail-reconcile-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("logs")).unwrap();
        std::fs::write(tmp.join("logs/error.log"), "").unwrap();

        let (tx, rx) = mpsc::channel();
        let emitter = TestEmitter { tx };
        let registry = TailRegistry::new();

        let cwd = tmp.to_string_lossy().to_string();
        reconcile(emitter.clone(), &registry, &[("nx".to_string(), cwd.clone())]);
        assert_eq!(registry.0.lock().unwrap().len(), 1);

        // 실제로 append 하면 err 스트림으로 emit 되는지 확인 (폴링 주기 대기).
        std::thread::sleep(Duration::from_millis(700));
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(tmp.join("logs/error.log")).unwrap();
            use std::io::Write;
            writeln!(f, "[error] boom").unwrap();
        }
        let mut saw = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Ok((id, lines)) = rx.recv_timeout(Duration::from_millis(200)) {
                if id == "nx" && lines.iter().any(|l| l.stream == "err" && l.text.contains("boom")) {
                    saw = true;
                    break;
                }
            }
        }
        assert!(saw, "error.log 에 append 한 줄이 err 스트림으로 emit 되어야 함");

        // 빈 목록으로 재구성하면 등록이 비워짐(스레드 중지 신호).
        reconcile(emitter, &registry, &[]);
        assert_eq!(registry.0.lock().unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
