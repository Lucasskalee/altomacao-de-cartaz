mod storage;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(storage::Access::default())
        .invoke_handler(tauri::generate_handler![storage::files])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar Skalee Cartazes A5");
}
