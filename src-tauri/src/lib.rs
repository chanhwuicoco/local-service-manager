mod config;
mod git;
mod inspect;
mod logutil;
mod port;
mod process;
mod tail;

use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use config::{AppConfig, ConfigState};
use process::ProcState;

// 메인 스레드 블로킹 방지: 모든 커맨드는 (async) 로 별도 스레드에서 실행 (내부는 그대로 동기 코드).
#[tauri::command(async)]
fn get_config(app: AppHandle) -> AppConfig {
    app.state::<ConfigState>().0.lock().unwrap().clone()
}

#[tauri::command(async)]
fn reload_config(app: AppHandle) -> AppConfig {
    let cfg = config::load_or_init(&app);
    *app.state::<ConfigState>().0.lock().unwrap() = cfg.clone();
    let registry = app.state::<tail::TailRegistry>();
    tail::reconcile(app.clone(), &registry, &config::nginx_services(&cfg));
    cfg
}

#[tauri::command(async)]
fn open_config_file(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = config::config_path(&app);
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// 프론트 초기 로딩(불러오는 중...) 이 끝난 뒤 호출 - 흰 화면/빈 화면 없이 창을 보여줌.
/// setup() 의 폴백 타이머가 안전망(프론트가 무슨 이유로든 이 커맨드를 못 부르면 3초 뒤 강제로 보여줌).
#[tauri::command(async)]
fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cfg = config::load_or_init(&app.handle().clone());
            app.manage(tail::TailRegistry::new());
            tail::reconcile(app.handle().clone(), &app.state::<tail::TailRegistry>(), &config::nginx_services(&cfg));
            app.manage(ConfigState::new(cfg));
            app.manage(ProcState::new());

            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let running = app_handle.state::<ProcState>().0.lock().unwrap().len() > 0;
                        if running {
                            api.prevent_close();
                            let _ = app_handle.emit("close-requested", ());
                        }
                    }
                });

                // 안전망: 프론트가 초기화 실패 등으로 show_main_window 를 못 부르는 경우에도
                // 창이 영원히 안 보이는 채로 남지 않게 3초 뒤 강제로 보여줌.
                let fallback_window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = fallback_window.show();
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            reload_config,
            open_config_file,
            write_text_file,
            show_main_window,
            config::save_config,
            inspect::inspect_dir,
            process::start_service,
            process::stop_service,
            process::restart_service,
            process::running_pids,
            process::stop_all_and_exit,
            process::force_exit,
            git::git_info,
            git::git_fetch,
            git::git_pull,
            port::check_ports,
            port::port_pids,
            port::kill_port,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
