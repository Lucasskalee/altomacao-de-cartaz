use serde::Serialize;
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}, sync::Mutex};

const MAX_BYTES: u64 = 25 * 1024 * 1024;
#[derive(Default)]
pub struct DbfAccess(Mutex<HashSet<PathBuf>>);
#[derive(Serialize)]
pub struct SelectedDbf { name: String, path: String }

fn canonical_dbf(path: &Path) -> Result<PathBuf, String> {
    let p = path.canonicalize().map_err(|e| format!("Não foi possível abrir o DBF: {e}"))?;
    if p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("dbf")) != Some(true) {
        return Err("Selecione um arquivo .dbf.".into());
    }
    if !p.is_file() { return Err("O caminho não é um arquivo DBF.".into()); }
    Ok(p)
}
fn read_selected(path: &Path, allowed: &HashSet<PathBuf>) -> Result<Vec<u8>, String> {
    let p = canonical_dbf(path)?;
    if !allowed.contains(&p) { return Err("Escolha o DBF pelo botão Importar DBF antes de ler o arquivo.".into()); }
    // Read-only handle, plus a bounded read even if the source grows after metadata().
    let file = fs::File::open(&p).map_err(|e| format!("Não foi possível ler o DBF: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES { return Err("DBF excede o limite de 25 MB.".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES { return Err("DBF excede o limite de 25 MB.".into()); }
    Ok(bytes)
}
#[tauri::command]
pub async fn choose_dbf(access: tauri::State<'_, DbfAccess>) -> Result<Option<SelectedDbf>, String> {
    let selected = rfd::AsyncFileDialog::new().add_filter("Tabela DBF", &["dbf"]).pick_file().await;
    match selected {
        None => Ok(None),
        Some(file) => {
            let p = canonical_dbf(file.path())?;
            let result = SelectedDbf { name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(), path: p.to_string_lossy().into_owned() };
            let mut allowed = access.0.lock().map_err(|e| e.to_string())?;
            allowed.clear(); allowed.insert(p);
            Ok(Some(result))
        }
    }
}
#[tauri::command]
pub async fn read_dbf(path: String, access: tauri::State<'_, DbfAccess>) -> Result<tauri::ipc::Response, String> {
    let allowed = access.0.lock().map_err(|e| e.to_string())?.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || read_selected(Path::new(&path), &allowed)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_only_scoped_dbf() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("sample.dbf");
        let source = vec![3u8; 64]; fs::write(&path, &source).unwrap();
        assert!(read_selected(&path, &HashSet::new()).is_err());
        let allowed = HashSet::from([path.canonicalize().unwrap()]);
        assert_eq!(read_selected(&path, &allowed).unwrap(), source);
        assert_eq!(fs::read(&path).unwrap(), source);
        let wrong = dir.path().join("sample.skcartaz"); fs::write(&wrong, b"{}").unwrap();
        assert!(canonical_dbf(&wrong).is_err());
        fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(read_selected(&path, &allowed).is_err());
    }
}
