mod storage;
mod dbf;
mod price_updates;
mod psd;
mod offers;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(storage::Access::default())
        .manage(dbf::DbfAccess::default())
        .manage(price_updates::PriceUpdates::default())
        .manage(psd::PsdAccess::default())
        .manage(offers::ExcelAccess::default())
        .setup(|app| {
            if let (Some(icon), Some(window)) = (
                app.default_window_icon().cloned(),
                tauri::Manager::get_webview_window(app, "main"),
            ) {
                let _ = window.set_icon(icon);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![storage::files, dbf::choose_dbf, dbf::read_dbf, psd::choose_psd, psd::read_psd, offers::choose_excel, offers::read_excel, offers::offer_campaigns, price_updates::prepare_price_updates, price_updates::prepare_price_restore, price_updates::commit_price_updates, price_updates::list_price_history, price_updates::discard_price_plan])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar Skalee Cartazes A5");
}
