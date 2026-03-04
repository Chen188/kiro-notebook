mod acp;
mod commands;
mod file_reader;
mod mcp_server;

use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

pub fn run_mcp() {
    mcp_server::run_mcp_server();
}

type SharedStdin = Arc<std::sync::Mutex<std::process::ChildStdin>>;

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, Arc<Mutex<acp::AcpClient>>>>>,
    pub cancel_handles: Arc<Mutex<HashMap<String, (SharedStdin, String)>>>,
    pub workspace: Arc<Mutex<Option<String>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        cancel_handles: Arc::new(Mutex::new(HashMap::new())),
        workspace: Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .setup(|app| {
            let webview_window = app
                .get_webview_window("main")
                .expect("main webview window not found");
            webview_window
                .with_webview(|webview| {
                    #[cfg(target_os = "macos")]
                    unsafe {
                        let wk: &objc2_web_kit::WKWebView = &*webview.inner().cast();
                        wk.setAllowsMagnification(true);
                    }
                })
                .expect("failed to configure webview");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::select_workspace,
            commands::list_files,
            commands::read_file_content,
            commands::new_acp_session,
            commands::load_acp_session,
            commands::send_prompt,
            commands::cancel_prompt,
            commands::set_model,
            commands::close_acp_session,
            commands::save_session_history,
            commands::load_session_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
