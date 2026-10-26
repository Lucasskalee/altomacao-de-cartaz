mod storage;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(storage::Access::default())
        .setup(|app| {
            if let (Some(icon), Some(window)) = (
                app.default_window_icon().cloned(),
                tauri::Manager::get_webview_window(app, "main"),
            ) {
                let _ = window.set_icon(icon);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![storage::files])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar Skalee Cartazes A5");
}
