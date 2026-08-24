use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub ts: i64,
    pub stream: String, // "out" | "err" | "sys"
    pub text: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// process.rs 의 핵심 로직(do_start/do_stop)이 AppHandle 대신 이걸로 로그를 내보내게 해서,
/// 실제 Tauri 앱 없이(tauri::test::MockRuntime 없이) 순수 Rust 테스트로 검증 가능하게 함.
pub trait LogEmitter: Clone + Send + 'static {
    fn emit_log(&self, id: &str, lines: Vec<LogLine>);
    /// 테스트 더블은 관심 없으면 기본(no-op) 그대로 둬도 됨.
    fn emit_status_started(&self, _id: &str, _pid: u32) {}
    fn emit_status_exited(&self, _id: &str, _code: Option<i32>) {}
}

impl<R: Runtime> LogEmitter for AppHandle<R> {
    fn emit_log(&self, id: &str, lines: Vec<LogLine>) {
        emit_log(self, id, lines);
    }

    fn emit_status_started(&self, id: &str, pid: u32) {
        let _ = self.emit("status", serde_json::json!({ "id": id, "kind": "started", "pid": pid }));
    }

    fn emit_status_exited(&self, id: &str, code: Option<i32>) {
        let _ = self.emit("status", serde_json::json!({ "id": id, "kind": "exited", "code": code }));
    }
}

pub fn emit_log<R: Runtime>(app: &AppHandle<R>, id: &str, lines: Vec<LogLine>) {
    if lines.is_empty() {
        return;
    }
    let _ = app.emit("log", serde_json::json!({ "id": id, "lines": lines }));
}

pub fn sys_line<E: LogEmitter>(emitter: &E, id: &str, text: impl Into<String>) {
    emitter.emit_log(
        id,
        vec![LogLine {
            ts: now_ms(),
            stream: "sys".into(),
            text: text.into(),
        }],
    );
}

/// Windows Java 는 stdout 이 MS949(EUC-KR) 인 경우가 흔해 UTF-8 디코딩 실패 시 폴백.
pub fn decode_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, _) = encoding_rs::EUC_KR.decode(bytes);
            cow.into_owned()
        }
    }
}

/// ANSI 색상/커서 이스케이프 시퀀스 제거.
pub fn strip_ansi(input: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
    RE.replace_all(input, "").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_color_codes() {
        let input = "\x1b[32mOK\x1b[0m done";
        assert_eq!(strip_ansi(input), "OK done");
    }

    #[test]
    fn leaves_plain_text_untouched() {
        assert_eq!(strip_ansi("plain line"), "plain line");
    }

    #[test]
    fn decodes_valid_utf8_as_is() {
        assert_eq!(decode_bytes("한글 로그".as_bytes()), "한글 로그");
    }

    #[test]
    fn falls_back_to_euc_kr_on_invalid_utf8() {
        let (bytes, _, had_errors) = encoding_rs::EUC_KR.encode("한글 로그 MS949");
        assert!(!had_errors);
        assert_eq!(decode_bytes(&bytes), "한글 로그 MS949");
    }
}
