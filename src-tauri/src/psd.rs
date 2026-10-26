use std::{fs, path::PathBuf, sync::Mutex};
use tauri::ipc::Response;

#[derive(Default)]
pub struct PsdAccess(Mutex<Option<PathBuf>>);

fn error(value: impl std::fmt::Display) -> String { format!("Não foi possível ler o PSD: {value}") }
fn validate_path(path: &std::path::Path) -> Result<(), String> {
    if path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("psd")) != Some(true) { return Err("Selecione um arquivo .psd.".into()); }
    let size = fs::metadata(path).map_err(error)?.len();
    if size < 26 || size > 25 * 1024 * 1024 { return Err("O PSD deve ter entre 26 bytes e 25 MB.".into()); }
    Ok(())
}

#[tauri::command]
pub async fn choose_psd(access: tauri::State<'_, PsdAccess>) -> Result<Option<String>, String> {
    let chosen = rfd::AsyncFileDialog::new().add_filter("Arte do Photoshop", &["psd"]).pick_file().await;
    let Some(file) = chosen else { return Ok(None); };
    let path = file.path().canonicalize().map_err(error)?;
    validate_path(&path)?;
    *access.0.lock().map_err(error)? = Some(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn read_psd(access: tauri::State<'_, PsdAccess>, path: String) -> Result<Response, String> {
    let path = PathBuf::from(path).canonicalize().map_err(error)?;
    let selected = access.0.lock().map_err(error)?.clone();
    if selected.as_ref() != Some(&path) { return Err("Selecione o PSD pelo diálogo nativo antes de importá-lo.".into()); }
    validate_path(&path)?;
    let bytes = fs::read(&path).map_err(error)?;
    if bytes.get(0..4) != Some(b"8BPS") { return Err("Arquivo inválido: assinatura PSD não encontrada.".into()); }
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_extension_and_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let wrong = dir.path().join("arte.txt"); fs::write(&wrong, vec![0u8; 26]).unwrap();
        assert!(validate_path(&wrong).is_err());
        let tiny = dir.path().join("arte.psd"); fs::write(&tiny, b"8BPS").unwrap();
        assert!(validate_path(&tiny).is_err());
    }
}
