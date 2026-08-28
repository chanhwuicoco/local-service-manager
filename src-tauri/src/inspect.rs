use std::fs;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortCandidate {
    pub port: u16,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DirInfo {
    pub has_gradlew: bool,
    pub has_mvnw: bool,
    pub has_gradle_build: bool,
    pub has_package_json: bool,
    pub npm_has_dev: bool,
    pub npm_has_start: bool,
    pub has_nginx_exe: bool,
    pub suggested_command: Option<String>,
    pub port_candidates: Vec<PortCandidate>,
    pub git_branch: Option<String>,
}

/// 감지된 빌드 도구 우선순위(nginx.exe > gradle > maven > npm)로 실행 명령 제안. 순수 함수라 테스트하기 쉬움.
/// nginx.exe 는 폴더 루트에 있으면 다른 무엇보다 확실한 신호라 최우선.
/// gradle 제안 문자열은 프론트 "백엔드" 유형 프리셋과 항상 동일하게 고정.
pub fn suggest_command(
    has_gradlew: bool,
    has_mvnw: bool,
    has_package_json: bool,
    npm_has_dev: bool,
    has_nginx_exe: bool,
) -> Option<String> {
    if has_nginx_exe {
        Some("nginx.exe".into())
    } else if has_gradlew {
        // gradlew bootRun 은 서비스마다 Gradle 데몬 JVM 이 상주 - jar 빌드 후 java -jar 로 실행하면
        // 앱 JVM 하나만 남음(process.rs 의 && 체인 + {jar} 치환이 해석).
        Some("gradlew.bat bootJar --no-daemon && java -jar {jar} --spring.profiles.active=local".into())
    } else if has_mvnw {
        Some("mvnw.cmd spring-boot:run".into())
    } else if has_package_json {
        Some(if npm_has_dev { "npm run dev".into() } else { "npm start".into() })
    } else {
        None
    }
}

/// package.json 텍스트에서 scripts.<key> 존재 여부.
pub fn npm_scripts_has(package_json_text: &str, key: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(package_json_text)
        .ok()
        .and_then(|v| v.get("scripts")?.get(key).map(|_| ()))
        .is_some()
}

/// yml `server:` 블록 아래 들여쓰기된 `port:` 값(nested) 추출.
pub fn parse_yaml_nested_port(text: &str) -> Option<String> {
    let mut in_server = false;
    let mut server_indent: usize = 0;
    for raw_line in text.lines() {
        let no_comment = raw_line.split('#').next().unwrap_or("");
        if no_comment.trim().is_empty() {
            continue;
        }
        let indent = no_comment.len() - no_comment.trim_start().len();
        let trimmed = no_comment.trim();
        if in_server && indent <= server_indent {
            in_server = false;
        }
        if !in_server {
            if trimmed == "server:" {
                in_server = true;
                server_indent = indent;
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("port:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// yml 한 줄짜리 `server.port: 8080` 형태(inline) 추출.
pub fn parse_yaml_inline_port(text: &str) -> Option<String> {
    for raw_line in text.lines() {
        let no_comment = raw_line.split('#').next().unwrap_or("");
        let trimmed = no_comment.trim();
        if let Some(rest) = trimmed.strip_prefix("server.port:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// application.properties 의 `server.port=8080` 추출.
pub fn parse_properties_port(text: &str) -> Option<String> {
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with('#') || trimmed.starts_with('!') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("server.port=") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// .env 의 `PORT=8080` 추출.
pub fn parse_env_port(text: &str) -> Option<String> {
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("PORT=") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// "${PORT:8080}" 같은 플레이스홀더는 기본값을, 순수 숫자는 그대로 파싱.
pub fn resolve_port_value(raw: &str) -> Option<u16> {
    let raw = raw.trim().trim_matches('"').trim_matches('\'');
    if let Some(inner) = raw.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
        let default_part = inner.split(':').nth(1)?;
        return default_part.trim().parse().ok();
    }
    raw.parse().ok()
}

pub fn extract_port_from_yaml(text: &str) -> Option<u16> {
    parse_yaml_nested_port(text)
        .or_else(|| parse_yaml_inline_port(text))
        .and_then(|s| resolve_port_value(&s))
}

pub fn extract_port_from_properties(text: &str) -> Option<u16> {
    parse_properties_port(text).and_then(|s| resolve_port_value(&s))
}

/// application-local.* 이 있으면 목록 맨 앞으로 (원래 순서는 유지되는 stable sort).
pub fn sort_candidates_local_first(mut candidates: Vec<PortCandidate>) -> Vec<PortCandidate> {
    candidates.sort_by_key(|c| !c.source.contains("local"));
    candidates
}

/// conf/nginx.conf 의 `listen` 지시자에서 포트 후보 추출(중복 제거). 커버하는 형태:
/// `listen 80;`, `listen 127.0.0.1:8080;`, `listen 8080 default_server;`, `listen [::]:80;`,
/// 줄 주석(`# ...`)은 무시. IP/IPv6 접두사는 건너뛰고 순수 포트 숫자만 뽑음.
pub fn parse_nginx_conf_ports(text: &str) -> Vec<u16> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"listen\s+(?:[\d.]+:|\[[^\]]+\]:)?(\d+)").unwrap()
    });
    let mut seen = std::collections::HashSet::new();
    let mut ports = Vec::new();
    for raw_line in text.lines() {
        let no_comment = raw_line.split('#').next().unwrap_or("");
        for cap in RE.captures_iter(no_comment) {
            if let Ok(port) = cap[1].parse::<u16>() {
                if seen.insert(port) {
                    ports.push(port);
                }
            }
        }
    }
    ports
}

/// error_log/access_log 지시자에서 로그 파일 경로만 추출("off" 나 값 없음은 None).
/// 두 번째 인자(로그레벨/포맷 이름 등, 예: `error_log path warn;`)는 무시하고 첫 토큰(경로)만 취함.
fn parse_nginx_log_path(text: &str, directive: &str) -> Option<String> {
    for raw_line in text.lines() {
        let no_comment = raw_line.split('#').next().unwrap_or("").trim();
        let Some(rest) = no_comment.strip_prefix(directive) else { continue };
        // "error_log_custom" 같은 다른 지시자 오탐 방지 - 지시자 다음은 반드시 공백이어야 함.
        if !rest.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let path = rest.trim().split_whitespace().next().unwrap_or("").trim_end_matches(';');
        if path.is_empty() || path.eq_ignore_ascii_case("off") {
            continue;
        }
        return Some(path.to_string());
    }
    None
}

pub fn parse_nginx_error_log_path(text: &str) -> Option<String> {
    parse_nginx_log_path(text, "error_log")
}

pub fn parse_nginx_access_log_path(text: &str) -> Option<String> {
    parse_nginx_log_path(text, "access_log")
}

fn scan_nginx_conf(dir: &Path) -> Vec<PortCandidate> {
    let Ok(text) = fs::read_to_string(dir.join("conf/nginx.conf")) else { return Vec::new() };
    parse_nginx_conf_ports(&text)
        .into_iter()
        .map(|port| PortCandidate { port, source: "nginx.conf".into() })
        .collect()
}

/// package.json scripts 안의 `--port N` / `-p N` 패턴에서 포트 후보 추출(간단한 수준, 스크립트별 첫 매치만).
/// 예: `"dev": "vite --port 3001"`, `"start": "next dev -p 3000"`.
pub fn parse_package_json_script_ports(package_json_text: &str) -> Vec<PortCandidate> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?:--port|-p)\s+(\d+)").unwrap());
    let Ok(v) = serde_json::from_str::<serde_json::Value>(package_json_text) else { return Vec::new() };
    let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut candidates = Vec::new();
    for (key, val) in scripts {
        let Some(script) = val.as_str() else { continue };
        let Some(cap) = RE.captures(script) else { continue };
        if let Ok(port) = cap[1].parse::<u16>() {
            if seen.insert(port) {
                candidates.push(PortCandidate { port, source: format!("package.json({key})") });
            }
        }
    }
    candidates
}

/// vite.config.* 의 `server: { port: N }` 같은 단순한 형태에서 포트 하나만 추출(간단한 수준, 못 찾으면 None).
pub fn parse_vite_config_port(text: &str) -> Option<u16> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"port\s*:\s*(\d+)").unwrap());
    RE.captures(text).and_then(|c| c[1].parse::<u16>().ok())
}

fn scan_frontend_ports(dir: &Path) -> Vec<PortCandidate> {
    let mut candidates = Vec::new();
    if let Ok(text) = fs::read_to_string(dir.join("package.json")) {
        candidates.extend(parse_package_json_script_ports(&text));
    }
    // vite.config 변형 중 처음 발견되는 파일 하나만 사용(여러 개 동시에 있는 경우는 드묾).
    for name in ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"] {
        if let Ok(text) = fs::read_to_string(dir.join(name)) {
            if let Some(port) = parse_vite_config_port(&text) {
                candidates.push(PortCandidate { port, source: name.to_string() });
            }
            break;
        }
    }
    candidates
}

fn scan_ports(dir: &Path) -> Vec<PortCandidate> {
    let mut candidates = Vec::new();
    let resources = dir.join("src/main/resources");
    if let Ok(entries) = fs::read_dir(&resources) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_str().unwrap_or("").to_string();
            if !name.starts_with("application") {
                continue;
            }
            let is_yaml = name.ends_with(".yml") || name.ends_with(".yaml");
            let is_props = name.ends_with(".properties");
            if !is_yaml && !is_props {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let port = if is_yaml { extract_port_from_yaml(&text) } else { extract_port_from_properties(&text) };
            if let Some(port) = port {
                candidates.push(PortCandidate { port, source: name });
            }
        }
    }
    if let Ok(text) = fs::read_to_string(dir.join(".env")) {
        if let Some(port) = parse_env_port(&text).and_then(|s| resolve_port_value(&s)) {
            candidates.push(PortCandidate { port, source: ".env".into() });
        }
    }
    candidates.extend(scan_frontend_ports(dir));
    candidates.extend(scan_nginx_conf(dir));
    sort_candidates_local_first(candidates)
}

#[tauri::command(async)]
pub fn inspect_dir(cwd: String) -> Result<DirInfo, String> {
    let dir = Path::new(&cwd);
    if !dir.is_dir() {
        return Err(format!("폴더가 존재하지 않습니다: {cwd}"));
    }

    let has_gradlew = dir.join("gradlew.bat").is_file() || dir.join("gradlew").is_file();
    let has_mvnw = dir.join("mvnw.cmd").is_file() || dir.join("pom.xml").is_file();
    let has_gradle_build = dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file();

    let package_json_path = dir.join("package.json");
    let has_package_json = package_json_path.is_file();
    let (npm_has_dev, npm_has_start) = if has_package_json {
        fs::read_to_string(&package_json_path)
            .map(|text| (npm_scripts_has(&text, "dev"), npm_scripts_has(&text, "start")))
            .unwrap_or((false, false))
    } else {
        (false, false)
    };

    let has_nginx_exe = dir.join("nginx.exe").is_file();

    let suggested_command = suggest_command(has_gradlew, has_mvnw, has_package_json, npm_has_dev, has_nginx_exe);
    let port_candidates = scan_ports(dir);
    let git_branch = crate::git::run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(DirInfo {
        has_gradlew,
        has_mvnw,
        has_gradle_build,
        has_package_json,
        npm_has_dev,
        npm_has_start,
        has_nginx_exe,
        suggested_command,
        port_candidates,
        git_branch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_yaml_port_under_server_block() {
        let text = "server:\n  port: 8190\nspring:\n  profiles:\n    active: local\n";
        assert_eq!(parse_yaml_nested_port(text), Some("8190".to_string()));
    }

    #[test]
    fn nested_yaml_ignores_port_outside_server_block() {
        let text = "management:\n  port: 9999\nother: 1\n";
        assert_eq!(parse_yaml_nested_port(text), None);
    }

    #[test]
    fn nested_yaml_port_with_placeholder_default() {
        let text = "server:\n  port: ${PORT:8080}\n";
        assert_eq!(extract_port_from_yaml(text), Some(8080));
    }

    #[test]
    fn inline_yaml_server_port() {
        let text = "server.port: 8195\nlogging.level.root: INFO\n";
        assert_eq!(parse_yaml_inline_port(text), Some("8195".to_string()));
    }

    #[test]
    fn nested_takes_priority_over_inline_when_both_present() {
        // nested 블록을 먼저 시도하므로, 두 표기가 섞여 있으면 nested 값을 우선 채택.
        let text = "server:\n  port: 8190\nserver.port: 9999\n";
        assert_eq!(extract_port_from_yaml(text), Some(8190));
    }

    #[test]
    fn properties_server_port() {
        let text = "spring.application.name=bms\nserver.port=8195\n";
        assert_eq!(parse_properties_port(text), Some("8195".to_string()));
    }

    #[test]
    fn properties_ignores_commented_line() {
        let text = "#server.port=9999\nserver.port=8195\n";
        assert_eq!(parse_properties_port(text), Some("8195".to_string()));
    }

    #[test]
    fn env_port_line() {
        let text = "NODE_ENV=development\nPORT=3000\n";
        assert_eq!(parse_env_port(text), Some("3000".to_string()));
    }

    #[test]
    fn resolve_plain_numeric_value() {
        assert_eq!(resolve_port_value("8080"), Some(8080));
    }

    #[test]
    fn resolve_placeholder_with_default() {
        assert_eq!(resolve_port_value("${SERVER_PORT:8081}"), Some(8081));
    }

    #[test]
    fn resolve_placeholder_without_default_is_none() {
        assert_eq!(resolve_port_value("${SERVER_PORT}"), None);
    }

    #[test]
    fn local_profile_candidate_sorts_first() {
        let candidates = vec![
            PortCandidate { port: 8190, source: "application.yml".into() },
            PortCandidate { port: 8191, source: "application-local.yml".into() },
        ];
        let sorted = sort_candidates_local_first(candidates);
        assert_eq!(sorted[0].source, "application-local.yml");
    }

    #[test]
    fn suggest_command_gradle_always_uses_local_profile_arg() {
        // 프론트 "백엔드" 유형 프리셋과 항상 동일한 문자열이어야 함.
        assert_eq!(
            suggest_command(true, false, false, false, false),
            Some("gradlew.bat bootJar --no-daemon && java -jar {jar} --spring.profiles.active=local".to_string())
        );
    }

    #[test]
    fn suggest_command_maven_when_no_gradle() {
        assert_eq!(suggest_command(false, true, false, false, false), Some("mvnw.cmd spring-boot:run".to_string()));
    }

    #[test]
    fn suggest_command_npm_dev_over_start() {
        assert_eq!(suggest_command(false, false, true, true, false), Some("npm run dev".to_string()));
    }

    #[test]
    fn suggest_command_npm_start_when_no_dev_script() {
        assert_eq!(suggest_command(false, false, true, false, false), Some("npm start".to_string()));
    }

    #[test]
    fn suggest_command_none_when_nothing_detected() {
        assert_eq!(suggest_command(false, false, false, false, false), None);
    }

    #[test]
    fn suggest_command_nginx_takes_priority_when_exe_present() {
        assert_eq!(suggest_command(true, false, false, false, true), Some("nginx.exe".to_string()));
    }

    #[test]
    fn npm_scripts_detects_dev_and_start() {
        let json = r#"{"scripts": {"dev": "vite", "build": "tsc"}}"#;
        assert!(npm_scripts_has(json, "dev"));
        assert!(!npm_scripts_has(json, "start"));
    }

    #[test]
    fn package_json_script_port_from_dashdash_port() {
        let json = r#"{"scripts": {"dev": "vite --port 3001"}}"#;
        let candidates = parse_package_json_script_ports(json);
        assert_eq!(candidates, vec![PortCandidate { port: 3001, source: "package.json(dev)".into() }]);
    }

    #[test]
    fn package_json_script_port_from_dash_p_short_flag() {
        let json = r#"{"scripts": {"start": "next dev -p 3000"}}"#;
        let candidates = parse_package_json_script_ports(json);
        assert_eq!(candidates, vec![PortCandidate { port: 3000, source: "package.json(start)".into() }]);
    }

    #[test]
    fn package_json_script_without_port_flag_is_ignored() {
        let json = r#"{"scripts": {"build": "tsc", "dev": "vite"}}"#;
        assert!(parse_package_json_script_ports(json).is_empty());
    }

    #[test]
    fn package_json_malformed_json_returns_empty() {
        assert!(parse_package_json_script_ports("not json").is_empty());
    }

    #[test]
    fn vite_config_port_from_server_block() {
        let text = "export default { server: { port: 5173 } }";
        assert_eq!(parse_vite_config_port(text), Some(5173));
    }

    #[test]
    fn vite_config_port_none_when_not_present() {
        assert_eq!(parse_vite_config_port("export default {}"), None);
    }

    #[test]
    fn parses_single_listen_port() {
        let text = "http {\n  server {\n    listen 8080;\n    server_name _;\n  }\n}\n";
        assert_eq!(parse_nginx_conf_ports(text), vec![8080]);
    }

    #[test]
    fn parses_multiple_listen_ports_and_dedupes() {
        let text = "server { listen 80; }\nserver { listen 443; listen 80; }\n";
        assert_eq!(parse_nginx_conf_ports(text), vec![80, 443]);
    }

    #[test]
    fn ignores_non_numeric_listen_directive() {
        // 유닉스 소켓 등 숫자가 아닌 listen 은 무시(단순 포트 형태만 대상).
        let text = "listen unix:/tmp/nginx.sock;\nlisten 8080;\n";
        assert_eq!(parse_nginx_conf_ports(text), vec![8080]);
    }

    #[test]
    fn returns_empty_when_no_listen_directive() {
        assert!(parse_nginx_conf_ports("http { }").is_empty());
    }

    #[test]
    fn parses_listen_with_ipv4_prefix() {
        let text = "server { listen 127.0.0.1:8080; }";
        assert_eq!(parse_nginx_conf_ports(text), vec![8080]);
    }

    #[test]
    fn parses_listen_with_trailing_options() {
        // "default_server" 처럼 세미콜론 전에 다른 토큰이 더 붙어도 포트만 추출.
        let text = "server { listen 8080 default_server; }";
        assert_eq!(parse_nginx_conf_ports(text), vec![8080]);
    }

    #[test]
    fn parses_listen_with_ipv6_bracket_prefix() {
        let text = "server { listen [::]:80; }";
        assert_eq!(parse_nginx_conf_ports(text), vec![80]);
    }

    #[test]
    fn ignores_commented_listen_line() {
        let text = "# listen 9999;\nserver { listen 8080; }";
        assert_eq!(parse_nginx_conf_ports(text), vec![8080]);
    }

    #[test]
    fn error_log_path_extracted() {
        let text = "error_log logs/custom-error.log warn;\n";
        assert_eq!(parse_nginx_error_log_path(text), Some("logs/custom-error.log".to_string()));
    }

    #[test]
    fn access_log_path_extracted_ignoring_format_name() {
        let text = "access_log logs/access.log main;\n";
        assert_eq!(parse_nginx_access_log_path(text), Some("logs/access.log".to_string()));
    }

    #[test]
    fn access_log_off_is_none() {
        assert_eq!(parse_nginx_access_log_path("access_log off;\n"), None);
    }

    #[test]
    fn log_path_directive_not_present_is_none() {
        assert_eq!(parse_nginx_error_log_path("http { }"), None);
    }

    #[test]
    fn log_path_ignores_commented_line() {
        let text = "# error_log logs/should-not-use.log;\nerror_log logs/real.log;\n";
        assert_eq!(parse_nginx_error_log_path(text), Some("logs/real.log".to_string()));
    }

    #[test]
    fn log_path_does_not_match_similarly_prefixed_directive() {
        // "error_log_extra" 같은 다른 지시자를 error_log 로 오탐하면 안 됨.
        assert_eq!(parse_nginx_error_log_path("error_log_extra logs/x.log;\n"), None);
    }

    // 실제 folder 로 확인(읽기 전용, cwd 만 읽음): C:/Workspace/BE_CMS 는 gradle 프로젝트라
    // has_nginx_exe=false, application-local.yml 후보(8190)가 정상 검출되는지 회귀 확인.
    #[test]
    fn inspect_dir_on_real_be_cms_folder_detects_gradle_and_local_port() {
        let dir = std::path::Path::new("C:/Workspace/BE_CMS");
        if !dir.is_dir() {
            return; // 이 폴더가 없는 환경(CI 등)에서는 건너뜀
        }
        let info = inspect_dir("C:/Workspace/BE_CMS".to_string()).unwrap();
        assert!(info.has_gradlew);
        assert!(!info.has_nginx_exe);
        assert_eq!(info.port_candidates.first().map(|c| c.port), Some(8190));
    }
}
