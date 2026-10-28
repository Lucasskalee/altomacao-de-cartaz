use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use tauri::ipc::Response;

use crate::scantech::clean_windows_path;

pub(crate) const MAX_CONDUCTOR_SCAN_FILES: usize = 500;
pub(crate) const MAX_CARTAZ_BYTES: u64 = 12 * 1024 * 1024;
pub(crate) const MAX_PSD_BYTES: u64 = 80 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConductorScannedEntry {
    pub name: String,
    pub path: String,
    pub format: String, // "skcartaz" | "psd"
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[tauri::command]
pub async fn choose_conductor_files() -> Result<Vec<String>, String> {
    let chosen = rfd::AsyncFileDialog::new()
        .set_title("Selecionar cartazes para o Condutor de Impressão (.skcartaz ou .psd)")
        .add_filter("Cartazes e Artes PSD (*.skcartaz, *.psd)", &["skcartaz", "psd"])
        .add_filter("Cartaz Skalee (*.skcartaz)", &["skcartaz"])
        .add_filter("Arte do Photoshop (*.psd)", &["psd"])
        .pick_files()
        .await;
    let Some(files) = chosen else {
        return Ok(Vec::new());
    };
    let paths = files
        .into_iter()
        .map(|f| clean_windows_path(f.path()).to_string_lossy().into_owned())
        .collect();
    Ok(paths)
}

#[tauri::command]
pub async fn choose_conductor_folder() -> Result<Option<String>, String> {
    let chosen = rfd::AsyncFileDialog::new()
        .set_title("Selecionar pasta com cartazes (.skcartaz ou .psd)")
        .pick_folder()
        .await;
    let Some(folder) = chosen else {
        return Ok(None);
    };
    let path = clean_windows_path(folder.path());
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub(crate) fn scan_conductor_folder_disk(folder: &Path) -> Result<Vec<ConductorScannedEntry>, String> {
    let clean = clean_windows_path(folder);
    if !clean.exists() || !clean.is_dir() {
        return Err("A pasta informada não foi encontrada ou não é acessível.".into());
    }
    let mut results = Vec::new();
    let mut stack = vec![clean];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if results.len() >= MAX_CONDUCTOR_SCAN_FILES {
                break;
            }
            let p = entry.path();
            let meta = match fs::symlink_metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if !entry.file_name().to_string_lossy().starts_with('.') {
                    stack.push(p);
                }
            } else {
                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
                if ext == "skcartaz" {
                    let size = meta.len();
                    if (10..=MAX_CARTAZ_BYTES).contains(&size) {
                        let modified_at = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() * 1000);
                        results.push(ConductorScannedEntry {
                            name: entry.file_name().to_string_lossy().into_owned(),
                            path: clean_windows_path(&p).to_string_lossy().into_owned(),
                            format: "skcartaz".into(),
                            size,
                            modified_at,
                        });
                    }
                } else if ext == "psd" {
                    let size = meta.len();
                    if (26..=MAX_PSD_BYTES).contains(&size) {
                        let modified_at = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() * 1000);
                        results.push(ConductorScannedEntry {
                            name: entry.file_name().to_string_lossy().into_owned(),
                            path: clean_windows_path(&p).to_string_lossy().into_owned(),
                            format: "psd".into(),
                            size,
                            modified_at,
                        });
                    }
                }
            }
        }
    }
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(results)
}

#[tauri::command]
pub async fn scan_conductor_folder(folder_path: String) -> Result<Vec<ConductorScannedEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        scan_conductor_folder_disk(Path::new(&folder_path))
    })
    .await
    .map_err(|e| format!("Falha na varredura da pasta: {e}"))?
}

#[tauri::command]
pub fn read_conductor_cartaz(path: String) -> Result<String, String> {
    let clean = clean_windows_path(Path::new(&path));
    if !clean.exists() || !clean.is_file() {
        return Err("Arquivo .skcartaz não encontrado ou inacessível.".into());
    }
    let meta = fs::metadata(&clean).map_err(|e| format!("Não foi possível ler os metadados do arquivo: {e}"))?;
    if meta.len() > MAX_CARTAZ_BYTES {
        return Err("O arquivo .skcartaz excede o limite máximo de 12 MB.".into());
    }
    let content = fs::read_to_string(&clean).map_err(|e| format!("Erro de leitura: {e}"))?;
    if !content.contains("\"schemaVersion\"") {
        return Err("Arquivo inválido: formato .skcartaz não reconhecido.".into());
    }
    Ok(content)
}

#[tauri::command]
pub fn read_conductor_psd(path: String) -> Result<Response, String> {
    let clean = clean_windows_path(Path::new(&path));
    if !clean.exists() || !clean.is_file() {
        return Err("Arquivo PSD não encontrado ou inacessível.".into());
    }
    let meta = fs::metadata(&clean).map_err(|e| format!("Não foi possível ler os metadados do PSD: {e}"))?;
    if meta.len() < 26 || meta.len() > MAX_PSD_BYTES {
        return Err("O arquivo PSD deve ter entre 26 bytes e 80 MB.".into());
    }
    let bytes = fs::read(&clean).map_err(|e| format!("Erro de leitura do PSD: {e}"))?;
    if bytes.get(0..4) != Some(b"8BPS") {
        return Err("Arquivo inválido: assinatura 8BPS do Photoshop não encontrada.".into());
    }
    Ok(Response::new(bytes))
}

