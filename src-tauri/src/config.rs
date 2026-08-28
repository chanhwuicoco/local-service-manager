use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceConfig {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub command: Option<String>,
    pub port: Option<u16>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// "backend" | "frontend" | "lib" | "nginx" — 없으면 프론트에서 추론(resolveKind). 값 자체는 검증하지 않음.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 사이드바 접힘 레일에 쓸 약칭(최대 3자). 없으면 프론트가 이름에서 자동 유도.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    /// Start All/Stop All/Pull All 일괄 실행에 이 서비스를 포함할지 여부. 없던 필드라 기존 config.json 은
    /// 전부 true(현행 동작)로 자동 해석됨.
    #[serde(default = "default_true", rename = "includeInAll")]
    pub include_in_all: bool,
}

fn default_kind_order() -> Vec<String> {
    vec!["backend".to_string(), "frontend".to_string(), "lib".to_string(), "nginx".to_string()]
}

/// "merge" | "rebase" - 없던 필드라 기존 config.json 은 전부 "rebase"(현재 동작 유지)로 자동 해석됨.
fn default_pull_mode() -> String {
    "rebase".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub services: Vec<ServiceConfig>,
    pub start_stagger_ms: u64,
    pub git_fetch_interval_sec: u64,
    pub max_log_lines: u32,
    /// 사이드바 그룹(kind) 표시 순서. 없으면 기존 고정 순서(backend/frontend/lib/nginx)로 자동 해석.
    #[serde(default = "default_kind_order")]
    pub kind_order: Vec<String>,
    /// git pull 방식: "merge"(인자 없는 기본 pull) | 그 외 전부(기본값 "rebase" 포함) rebase+autostash.
    /// 값 자체를 enum 으로 엄격 검증하지 않음(다른 kind/short 필드와 같은 패턴) - git.rs::pull_args_for_mode 가
    /// "merge" 만 특별 취급하고 나머지는 전부 안전한 기본(rebase)으로 처리.
    #[serde(default = "default_pull_mode")]
    pub pull_mode: String,
}

// 프로덕션 기본값 생성은 이제 empty_svc() 가 담당 - 이 두 헬퍼는 테스트 fixture 전용이라(실제 폴더/커맨드가
// 채워진 서비스를 간단히 만들 때 씀) 릴리스 빌드에서 dead_code 경고 안 나게 테스트 전용으로 한정.
#[cfg(test)]
fn svc(id: &str, name: &str, cwd: &str, command: Option<&str>, port: Option<u16>) -> ServiceConfig {
    ServiceConfig {
        id: id.into(),
        name: name.into(),
        cwd: cwd.into(),
        command: command.map(|s| s.into()),
        port,
        env: HashMap::new(),
        kind: None,
        short: None,
        include_in_all: true,
    }
}

#[cfg(test)]
fn svc_kind(id: &str, name: &str, cwd: &str, command: Option<&str>, port: Option<u16>, kind: &str) -> ServiceConfig {
    let mut s = svc(id, name, cwd, command, port);
    s.kind = Some(kind.to_string());
    s
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 새 config.json 최초 생성 시 쓰는 "빈 값" 기본 서비스 - 예전엔 실제 폴더 경로가 하드코딩돼 있어서
/// 다른 컴퓨터에선 전부 깨진 경로였음. 이제는 이름/유형만 미리 채워두고 폴더는 사용자가 직접 지정하게
/// 유도한다. command 는 kind="lib" 만 None(진짜 git-only), 나머지는 빈 문자열로 둬서
/// effective_command 의 kind 기본 placeholder(npm run dev/gradle/nginx.exe)가 그대로 적용되게 함.
fn empty_svc(name: &str, kind: &str) -> ServiceConfig {
    ServiceConfig {
        id: new_id(),
        name: name.to_string(),
        cwd: String::new(),
        command: if kind == "lib" { None } else { Some(String::new()) },
        port: None,
        env: HashMap::new(),
        kind: Some(kind.to_string()),
        short: None,
        include_in_all: true,
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            services: vec![
                empty_svc("FE_ECC", "frontend"),
                empty_svc("FE_PORTAL", "frontend"),
                empty_svc("BE_CMS", "backend"),
                empty_svc("BE_PORTAL", "backend"),
                empty_svc("BE_FMS", "backend"),
                empty_svc("BE_BMS", "backend"),
                empty_svc("BE_PRC", "backend"),
                empty_svc("BE_WND", "backend"),
                empty_svc("FE_LIB", "lib"),
                empty_svc("BE_LIB", "lib"),
                empty_svc("nginx", "nginx"),
            ],
            start_stagger_ms: 1500,
            git_fetch_interval_sec: 600, // 10분 - 기존 300(5분)은 사용자 config 를 main 이 직접 패치해서 여긴 신규 생성 시에만 적용됨
            max_log_lines: 10000,
            kind_order: default_kind_order(),
            pull_mode: default_pull_mode(),
        }
    }
}

/// LSM_CONFIG 환경변수로 config.json 경로를 override (검증/테스트용).
pub fn config_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("LSM_CONFIG") {
        return PathBuf::from(p);
    }
    let dir = app.path().app_config_dir().expect("app_config_dir unavailable");
    dir.join("config.json")
}

/// 앱 이름 개명(local-backend-manager -> local-service-manager)으로 identifier 가 바뀌면서
/// app_config_dir 경로도 바뀜 - 새 위치 기준으로 개명 전 위치의 config.json 경로를 추론.
/// new_path 가 ".../<식별자 폴더>/config.json" 형태가 아니면(예: LSM_CONFIG 오버라이드) None.
pub fn legacy_config_path_from(new_path: &Path) -> Option<PathBuf> {
    let dir = new_path.parent()?;
    let dir_name = dir.file_name()?.to_str()?;
    if !dir_name.contains("local-service-manager") {
        return None;
    }
    let legacy_dir_name = dir_name.replace("local-service-manager", "local-backend-manager");
    let legacy_dir = dir.parent()?.join(legacy_dir_name);
    Some(legacy_dir.join("config.json"))
}

/// 새 위치에 config.json 이 아직 없고 개명 전 위치에 있으면 1회 복사해옴(있으면 절대 안 덮어씀).
/// 읽기/쓰기 실패는 조용히 무시 - 실패해도 load_or_init 이 이어서 기본값을 만들어주므로 안전.
pub fn migrate_legacy_config(new_path: &Path) {
    if new_path.exists() {
        return;
    }
    let Some(legacy_path) = legacy_config_path_from(new_path) else { return };
    if let Ok(text) = fs::read_to_string(&legacy_path) {
        if let Some(parent) = new_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(new_path, text);
    }
}

pub fn load_or_init(app: &AppHandle) -> AppConfig {
    let path = config_path(app);
    migrate_legacy_config(&path);
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<AppConfig>(&text) {
            return cfg;
        }
    }
    let cfg = AppConfig::default();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap());
    cfg
}

// Arc 로 감싸 do_start/do_stop 에 값으로 넘길 수 있게 함 (Tauri State 는 invoke 수명에 묶여 스레드로 못 들고 감).
#[derive(Clone)]
pub struct ConfigState(pub std::sync::Arc<std::sync::Mutex<AppConfig>>);

impl ConfigState {
    pub fn new(cfg: AppConfig) -> Self {
        ConfigState(std::sync::Arc::new(std::sync::Mutex::new(cfg)))
    }
}

/// 이름/id 필수·중복, 포트 범위 검증. IO 가 없어 순수 함수로 테스트 가능.
pub fn validate_config(cfg: &AppConfig) -> Result<(), String> {
    let mut seen_ids = std::collections::HashSet::new();
    for s in &cfg.services {
        if s.name.trim().is_empty() {
            return Err(format!("이름은 필수입니다 (id: {})", s.id));
        }
        if s.id.trim().is_empty() {
            return Err(format!("id는 필수입니다 (이름: {})", s.name));
        }
        if !seen_ids.insert(s.id.clone()) {
            return Err(format!("id가 중복되었습니다: {}", s.id));
        }
        // 경로 미설정 서비스는 아직 "설정 중"인 상태로 보고 port/command 검증을 면제(이름/id 만 지킴) -
        // 관리 모달은 전체 서비스를 한 번에 검증하므로, 안 그러면 서비스 1개만 채워 저장하려 해도 나머지
        // 빈 기본 서비스들의 포트 필수 정책에 걸려 저장 자체가 막히는 문제가 있었음. 폴더를 채우는
        // 순간부터(cwd non-empty) 기존 포트/커맨드 정책이 그대로 적용됨.
        if s.cwd.trim().is_empty() {
            continue;
        }
        // command: None = 진짜 LIB 전용(체크박스로 명시). Some("") 는 비어있어도 kind 기본값으로
        // 해석되므로(effective_command) 더 이상 에러가 아님 - 포트만 검증.
        // frontend 는 포트가 선택 입력 - dev 서버는 포트를 프로젝트 설정이 스스로 정하고 데몬화 없이
        // 계속 떠 있어서 포트가 없어도 pid 기준으로 상태 판단이 가능함. backend/nginx 는 여전히 필수.
        match &s.command {
            None => {
                if s.port.is_some() {
                    return Err(format!("{}: LIB 전용 서비스는 포트를 비워야 합니다", s.name));
                }
            }
            Some(_) => {
                let port_optional = s.kind.as_deref() == Some("frontend");
                match s.port {
                    Some(0) => return Err(format!("{}: 포트는 1~65535 범위여야 합니다", s.name)),
                    None if !port_optional => {
                        return Err(format!("{}: 포트는 1~65535 범위여야 합니다", s.name))
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

/// cwd 실존 여부 검증(IO 필요라 validate_config 와 분리). 경로 미설정(빈 문자열)은 "아직 안 정한 상태"로
/// 허용 - 값을 채워 넣었을 때만 실제 폴더 존재를 검증함(빈 채로 저장/로드 자체는 항상 가능해야 함).
pub fn check_cwds_exist(cfg: &AppConfig) -> Result<(), String> {
    for s in &cfg.services {
        if s.cwd.trim().is_empty() {
            continue;
        }
        if !std::path::Path::new(&s.cwd).is_dir() {
            return Err(format!("{}: 폴더가 존재하지 않습니다 ({})", s.name, s.cwd));
        }
    }
    Ok(())
}

/// 명령이 비어있으면(""도 포함) kind 기본값으로 대체. kind="lib" 이거나 command=None 이면 None.
pub fn effective_command(svc: &ServiceConfig) -> Option<String> {
    if svc.kind.as_deref() == Some("lib") {
        return None;
    }
    let cmd = svc.command.as_ref()?;
    if !cmd.trim().is_empty() {
        return Some(cmd.clone());
    }
    match svc.kind.as_deref() {
        Some("frontend") => Some("npm run dev".to_string()),
        Some("nginx") => Some("nginx.exe".to_string()),
        // gradlew bootRun 은 서비스마다 Gradle 데몬 JVM 이 상주해 메모리를 낭비 - jar 빌드 후
        // java -jar 로 실행하면 뜬 뒤엔 앱 JVM 하나만 남음. process.rs 의 && 체인 실행 +
        // {jar} 치환(build/libs 산출물)이 이 명령을 해석함.
        _ => Some("gradlew.bat bootJar --no-daemon && java -jar {jar} --spring.profiles.active=local".to_string()),
    }
}

/// AppConfig 에서 nginx kind 서비스의 (id, cwd) 목록만 추림 — 로그 tail 대상 재구성용.
pub fn nginx_services(cfg: &AppConfig) -> Vec<(String, String)> {
    cfg.services
        .iter()
        .filter(|s| s.kind.as_deref() == Some("nginx"))
        .map(|s| (s.id.clone(), s.cwd.clone()))
        .collect()
}

#[tauri::command(async)]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    validate_config(&config)?;
    check_cwds_exist(&config)?;
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())?;
    *app.state::<ConfigState>().0.lock().unwrap() = config.clone();
    let registry = app.state::<crate::tail::TailRegistry>();
    crate::tail::reconcile(app.clone(), &registry, &nginx_services(&config));
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_with(services: Vec<ServiceConfig>) -> AppConfig {
        AppConfig {
            services,
            start_stagger_ms: 1500,
            git_fetch_interval_sec: 300,
            max_log_lines: 10000,
            kind_order: default_kind_order(),
            pull_mode: default_pull_mode(),
        }
    }

    #[test]
    fn legacy_config_path_derives_old_identifier_folder() {
        let new_path = PathBuf::from("C:/Users/x/AppData/Roaming/com.bigtorchman.local-service-manager/config.json");
        let legacy = legacy_config_path_from(&new_path).unwrap();
        assert_eq!(
            legacy,
            PathBuf::from("C:/Users/x/AppData/Roaming/com.bigtorchman.local-backend-manager/config.json")
        );
    }

    #[test]
    fn legacy_config_path_none_when_dir_name_unrelated() {
        // LSM_CONFIG 오버라이드 등으로 폴더명에 "local-service-manager" 가 없으면 추론 불가 - 안전하게 None.
        let new_path = PathBuf::from("C:/temp/custom-config.json");
        assert!(legacy_config_path_from(&new_path).is_none());
    }

    #[test]
    fn migrate_copies_legacy_config_when_new_missing() {
        let tmp = std::env::temp_dir().join(format!("lbm-migrate-{}-a", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let legacy_dir = tmp.join("com.bigtorchman.local-backend-manager");
        let new_dir = tmp.join("com.bigtorchman.local-service-manager");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("config.json"), r#"{"marker":"legacy-data"}"#).unwrap();

        let new_path = new_dir.join("config.json");
        migrate_legacy_config(&new_path);

        let migrated = fs::read_to_string(&new_path).unwrap();
        assert_eq!(migrated, r#"{"marker":"legacy-data"}"#);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrate_never_overwrites_existing_new_config() {
        let tmp = std::env::temp_dir().join(format!("lbm-migrate-{}-b", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let legacy_dir = tmp.join("com.bigtorchman.local-backend-manager");
        let new_dir = tmp.join("com.bigtorchman.local-service-manager");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(legacy_dir.join("config.json"), r#"{"marker":"legacy-data"}"#).unwrap();
        let new_path = new_dir.join("config.json");
        fs::write(&new_path, r#"{"marker":"already-here"}"#).unwrap();

        migrate_legacy_config(&new_path);

        let content = fs::read_to_string(&new_path).unwrap();
        assert_eq!(content, r#"{"marker":"already-here"}"#, "이미 있는 새 위치 config 는 절대 덮어쓰면 안 됨");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrate_does_nothing_when_legacy_missing_too() {
        let tmp = std::env::temp_dir().join(format!("lbm-migrate-{}-c", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let new_dir = tmp.join("com.bigtorchman.local-service-manager");
        let new_path = new_dir.join("config.json");

        migrate_legacy_config(&new_path); // 패닉 없이 조용히 통과해야 함

        assert!(!new_path.exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn include_in_all_defaults_to_true_when_field_missing_in_json() {
        // 구 config.json 에 "includeInAll" 필드 자체가 없어도 true(현행 동작)로 읽혀야 함(하위호환).
        let json = r#"{"id":"a","name":"A","cwd":"C:/x","command":"npm start","port":3000,"env":{}}"#;
        let s: ServiceConfig = serde_json::from_str(json).unwrap();
        assert!(s.include_in_all);
    }

    #[test]
    fn include_in_all_false_when_explicitly_set() {
        let json = r#"{"id":"a","name":"A","cwd":"C:/x","command":"npm start","port":3000,"env":{},"includeInAll":false}"#;
        let s: ServiceConfig = serde_json::from_str(json).unwrap();
        assert!(!s.include_in_all);
    }

    #[test]
    fn include_in_all_round_trip_through_serialize() {
        let mut s = svc("a", "A", "C:/x", Some("npm start"), Some(3000));
        s.include_in_all = false;
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""includeInAll":false"#));
        let back: ServiceConfig = serde_json::from_str(&json).unwrap();
        assert!(!back.include_in_all);
    }

    #[test]
    fn kind_order_defaults_when_missing_from_json() {
        // 구 config.json 에 "kindOrder" 가 없어도 기존 고정 순서로 자동 해석돼야 함.
        let json = r#"{"services":[],"startStaggerMs":1500,"gitFetchIntervalSec":300,"maxLogLines":10000}"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.kind_order, vec!["backend", "frontend", "lib", "nginx"]);
    }

    #[test]
    fn kind_order_round_trip_with_custom_order() {
        let mut cfg = cfg_with(vec![]);
        cfg.kind_order = vec!["nginx".to_string(), "lib".to_string()];
        let json = serde_json::to_string(&cfg).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind_order, vec!["nginx", "lib"]);
    }

    #[test]
    fn pull_mode_defaults_to_rebase_when_missing_from_json() {
        // 구 config.json 에 "pullMode" 가 없어도 기존 동작(rebase+autostash)으로 자동 해석돼야 함.
        let json = r#"{"services":[],"startStaggerMs":1500,"gitFetchIntervalSec":300,"maxLogLines":10000}"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.pull_mode, "rebase");
    }

    #[test]
    fn pull_mode_round_trip_merge() {
        let mut cfg = cfg_with(vec![]);
        cfg.pull_mode = "merge".to_string();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"pullMode\":\"merge\""));
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pull_mode, "merge");
    }

    #[test]
    fn default_config_has_the_eleven_empty_services_in_order() {
        let cfg = AppConfig::default();
        let names_kinds: Vec<(String, Option<String>)> =
            cfg.services.iter().map(|s| (s.name.clone(), s.kind.clone())).collect();
        assert_eq!(
            names_kinds,
            vec![
                ("FE_ECC".to_string(), Some("frontend".to_string())),
                ("FE_PORTAL".to_string(), Some("frontend".to_string())),
                ("BE_CMS".to_string(), Some("backend".to_string())),
                ("BE_PORTAL".to_string(), Some("backend".to_string())),
                ("BE_FMS".to_string(), Some("backend".to_string())),
                ("BE_BMS".to_string(), Some("backend".to_string())),
                ("BE_PRC".to_string(), Some("backend".to_string())),
                ("BE_WND".to_string(), Some("backend".to_string())),
                ("FE_LIB".to_string(), Some("lib".to_string())),
                ("BE_LIB".to_string(), Some("lib".to_string())),
                ("nginx".to_string(), Some("nginx".to_string())),
            ],
        );
    }

    #[test]
    fn default_config_services_have_every_value_empty_except_name_and_kind() {
        let cfg = AppConfig::default();
        for s in &cfg.services {
            assert_eq!(s.cwd, "", "{}: cwd 는 비어있어야 함", s.name);
            assert_eq!(s.port, None, "{}: port 는 없어야 함", s.name);
            assert!(s.env.is_empty(), "{}: env 는 비어있어야 함", s.name);
            assert_eq!(s.short, None, "{}: short 는 비어있어야 함", s.name);
            assert!(s.include_in_all, "{}: include_in_all 은 기본 true 여야 함", s.name);
            if s.kind.as_deref() == Some("lib") {
                assert_eq!(s.command, None, "{}: lib 는 command 가 None(진짜 git-only) 이어야 함", s.name);
            } else {
                assert_eq!(s.command, Some(String::new()), "{}: lib 아니면 command 는 빈 문자열이어야 함", s.name);
            }
        }
    }

    #[test]
    fn default_config_service_ids_are_unique_and_uuid_shaped() {
        let cfg = AppConfig::default();
        let ids: std::collections::HashSet<&str> = cfg.services.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), cfg.services.len(), "id 중복 없이 전부 유일해야 함");
        for s in &cfg.services {
            // 8-4-4-4-12 하이픈 형태(uuid v4) 대충 확인 - 길이 36, 하이픈 4개.
            assert_eq!(s.id.len(), 36, "{}: id 는 UUID 형태(36자)여야 함", s.name);
            assert_eq!(s.id.matches('-').count(), 4, "{}: id 는 하이픈 4개짜리 UUID 형태여야 함", s.name);
        }
    }

    #[test]
    fn default_config_git_fetch_interval_is_ten_minutes() {
        // 기존 사용자 config(300) 마이그레이션은 main 이 직접 패치 - 여긴 신규 생성 기본값만 확인.
        assert_eq!(AppConfig::default().git_fetch_interval_sec, 600);
    }

    #[test]
    fn default_config_passes_check_cwds_exist() {
        // 이번 작업의 핵심: cwd 가 비어있어도(저장 시점) 폴더 실존 검증에서 거부되면 안 됨.
        let cfg = AppConfig::default();
        assert!(check_cwds_exist(&cfg).is_ok());
    }

    #[test]
    fn default_config_passes_validate_config_since_cwd_is_empty_for_all() {
        // 경로 미설정 서비스는 port/command 검증이 면제되므로, 방금 생성된 빈 기본값(전부 cwd="")은
        // 아무것도 안 채운 채로도 그대로 저장 가능해야 함 - 관리 모달을 열자마자 저장해도 안 막혀야 함.
        let cfg = AppConfig::default();
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn validate_config_allows_saving_when_only_one_service_is_filled_in() {
        // 사용자 실사용 시나리오: 기본 서비스 중 1개만 폴더/포트를 채우고 나머지는 그대로 둔 채 저장 -
        // 나머지 빈 기본 서비스들의 포트 필수 정책에 걸려 저장 자체가 막히면 안 됨(이번 수정의 핵심).
        let mut cfg = AppConfig::default();
        cfg.services[2].cwd = "C:/x".to_string(); // BE_CMS
        cfg.services[2].port = Some(8190);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn validate_config_still_requires_port_once_cwd_is_filled_in_for_backend() {
        // 폴더를 채우는 순간부터는(cwd non-empty) 기존 포트 필수 정책이 그대로 적용돼야 함.
        let cfg = cfg_with(vec![svc_kind("a", "A", "C:/x", Some(""), None, "backend")]);
        let err = validate_config(&cfg).expect_err("cwd 채운 backend 는 포트 없이 저장 불가해야 함");
        assert!(err.contains("포트는"), "포트 미설정 에러여야 함: {err}");
    }

    #[test]
    fn validate_config_still_requires_port_once_cwd_is_filled_in_for_nginx() {
        let cfg = cfg_with(vec![svc_kind("a", "A", "C:/x", Some(""), None, "nginx")]);
        let err = validate_config(&cfg).expect_err("cwd 채운 nginx 는 포트 없이 저장 불가해야 함");
        assert!(err.contains("포트는"), "포트 미설정 에러여야 함: {err}");
    }

    #[test]
    fn validate_config_lib_with_cwd_still_rejects_a_port() {
        // LIB(command=None) 는 cwd 를 채워도 "포트를 비워야 함" 정책이 그대로 유지돼야 함.
        let cfg = cfg_with(vec![svc_kind("a", "A", "C:/x", None, Some(3000), "lib")]);
        let err = validate_config(&cfg).expect_err("cwd 채운 LIB 는 포트가 있으면 저장 불가해야 함");
        assert!(err.contains("포트를 비워야"), "LIB 포트 존재 에러여야 함: {err}");
    }

    #[test]
    fn validate_config_backend_with_empty_cwd_and_no_port_is_still_ok() {
        // cwd 가 빈 채로 남아있으면 포트가 없어도(기본값 그대로) 통과해야 함 - 면제 규칙 자체를 직접 확인.
        let cfg = cfg_with(vec![svc_kind("a", "A", "", Some(""), None, "backend")]);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn default_config_effective_command_resolves_kind_placeholders() {
        let cfg = AppConfig::default();
        let by_name = |name: &str| cfg.services.iter().find(|s| s.name == name).unwrap();
        assert_eq!(effective_command(by_name("FE_ECC")), Some("npm run dev".to_string()));
        assert_eq!(
            effective_command(by_name("BE_CMS")),
            Some("gradlew.bat bootJar --no-daemon && java -jar {jar} --spring.profiles.active=local".to_string()),
        );
        assert_eq!(effective_command(by_name("nginx")), Some("nginx.exe".to_string()));
        assert_eq!(effective_command(by_name("FE_LIB")), None);
        assert_eq!(effective_command(by_name("BE_LIB")), None);
    }

    #[test]
    fn rejects_empty_name() {
        let cfg = cfg_with(vec![svc("a", "", "C:/x", Some("npm start"), Some(3000))]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_empty_id() {
        let cfg = cfg_with(vec![svc("", "A", "C:/x", Some("npm start"), Some(3000))]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_duplicate_id() {
        let cfg = cfg_with(vec![
            svc("a", "A", "C:/x", Some("npm start"), Some(3000)),
            svc("a", "A2", "C:/y", Some("npm start"), Some(3001)),
        ]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_zero_port_when_not_git_only() {
        let cfg = cfg_with(vec![svc("a", "A", "C:/x", Some("npm start"), Some(0))]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_missing_port_when_not_git_only() {
        let cfg = cfg_with(vec![svc("a", "A", "C:/x", Some("npm start"), None)]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn accepts_empty_command_with_valid_port() {
        // 명령이 비어있어도 LIB 전용이 아니면 kind 기본값으로 해석되므로(effective_command) 저장은 허용.
        let cfg = cfg_with(vec![svc("a", "A", "C:/x", Some(""), Some(3000))]);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn accepts_git_only_service_without_command_or_port() {
        let cfg = cfg_with(vec![svc("a", "A", "C:/x", None, None)]);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_git_only_service_with_leftover_port() {
        let cfg = cfg_with(vec![svc("a", "A", "C:/x", None, Some(3000))]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn accepts_valid_service_with_command_and_port() {
        let cfg = cfg_with(vec![svc("a", "A", "C:/x", Some("npm start"), Some(3000))]);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn check_cwds_exist_rejects_missing_folder() {
        let cfg = cfg_with(vec![svc("a", "A", "C:/definitely-not-a-real-path-lbm-test", None, None)]);
        assert!(check_cwds_exist(&cfg).is_err());
    }

    #[test]
    fn check_cwds_exist_accepts_existing_folder() {
        let tmp = std::env::temp_dir();
        let cfg = cfg_with(vec![svc("a", "A", &tmp.to_string_lossy(), None, None)]);
        assert!(check_cwds_exist(&cfg).is_ok());
    }

    #[test]
    fn check_cwds_exist_allows_empty_cwd() {
        // 경로 미설정("") 은 "아직 안 정한 상태"로 항상 허용 - 값이 채워졌을 때만 실존 여부를 검증함.
        let cfg = cfg_with(vec![svc("a", "A", "", None, None)]);
        assert!(check_cwds_exist(&cfg).is_ok());
    }

    #[test]
    fn check_cwds_exist_still_rejects_missing_folder_when_cwd_is_whitespace_only() {
        // 공백만 있는 값도 "미설정"으로 취급(trim 기준) - 실제 폴더로 오인해 존재 검증을 하지 않음.
        let cfg = cfg_with(vec![svc("a", "A", "   ", None, None)]);
        assert!(check_cwds_exist(&cfg).is_ok());
    }

    #[test]
    fn effective_command_uses_value_when_present() {
        let cfg = svc("a", "A", "C:/x", Some("java -jar x.jar"), Some(3000));
        assert_eq!(effective_command(&cfg), Some("java -jar x.jar".to_string()));
    }

    #[test]
    fn effective_command_falls_back_to_backend_default_when_empty() {
        let mut s = svc("a", "A", "C:/x", Some(""), Some(3000));
        s.kind = None;
        assert_eq!(
            effective_command(&s),
            Some("gradlew.bat bootJar --no-daemon && java -jar {jar} --spring.profiles.active=local".to_string())
        );
    }

    #[test]
    fn effective_command_falls_back_to_frontend_default_when_kind_frontend() {
        let mut s = svc("a", "A", "C:/x", Some(""), Some(3000));
        s.kind = Some("frontend".to_string());
        assert_eq!(effective_command(&s), Some("npm run dev".to_string()));
    }

    #[test]
    fn effective_command_none_when_git_only() {
        let s = svc("a", "A", "C:/x", None, None);
        assert_eq!(effective_command(&s), None);
    }

    #[test]
    fn effective_command_falls_back_to_nginx_default_when_kind_nginx() {
        let mut s = svc("a", "A", "C:/x", Some(""), None);
        s.kind = Some("nginx".to_string());
        assert_eq!(effective_command(&s), Some("nginx.exe".to_string()));
    }

    #[test]
    fn rejects_nginx_service_without_port() {
        // 포트 없으면 상태 감지·Stop 이 전부 무력화되므로 nginx 도 포트 필수.
        let mut s = svc("a", "A", "C:/x", Some("nginx.exe"), None);
        s.kind = Some("nginx".to_string());
        let cfg = cfg_with(vec![s]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn accepts_nginx_service_with_valid_port() {
        let mut s = svc("a", "A", "C:/x", Some("nginx.exe"), Some(80));
        s.kind = Some("nginx".to_string());
        let cfg = cfg_with(vec![s]);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_nginx_service_with_zero_port() {
        let mut s = svc("a", "A", "C:/x", Some("nginx.exe"), Some(0));
        s.kind = Some("nginx".to_string());
        let cfg = cfg_with(vec![s]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_missing_port_for_non_frontend_non_git_service() {
        // kind 없음(backend 로 취급) 이면 기존 규칙대로 포트 필수.
        let cfg = cfg_with(vec![svc("a", "A", "C:/x", Some("npm start"), None)]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn accepts_frontend_service_without_port() {
        // 프론트 dev 서버는 프로젝트 설정이 포트를 스스로 정할 수 있어 포트 선택 입력.
        let mut s = svc("a", "A", "C:/x", Some("npm run dev"), None);
        s.kind = Some("frontend".to_string());
        let cfg = cfg_with(vec![s]);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn accepts_frontend_service_with_valid_port() {
        let mut s = svc("a", "A", "C:/x", Some("npm run dev"), Some(5173));
        s.kind = Some("frontend".to_string());
        let cfg = cfg_with(vec![s]);
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_frontend_service_with_zero_port() {
        let mut s = svc("a", "A", "C:/x", Some("npm run dev"), Some(0));
        s.kind = Some("frontend".to_string());
        let cfg = cfg_with(vec![s]);
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn nginx_services_filters_by_kind() {
        let mut n = svc("nx", "NGX", "C:/nginx", Some("nginx.exe"), Some(80));
        n.kind = Some("nginx".to_string());
        let cfg = cfg_with(vec![
            svc("a", "A", "C:/x", Some("npm start"), Some(3000)),
            n,
        ]);
        assert_eq!(nginx_services(&cfg), vec![("nx".to_string(), "C:/nginx".to_string())]);
    }

    #[test]
    fn effective_command_none_when_kind_is_lib_even_with_stray_command() {
        // 수동 편집 등으로 kind=lib 인데 command 가 남아있어도(데이터 오염) 무조건 None.
        let mut s = svc("a", "A", "C:/x", Some("gradlew.bat bootRun"), Some(3000));
        s.kind = Some("lib".to_string());
        assert_eq!(effective_command(&s), None);
    }
}
