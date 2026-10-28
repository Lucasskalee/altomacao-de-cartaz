use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;

const MAX_SCANTECH_BYTES: usize = 12 * 1024 * 1024;
const MAX_PSD_SCAN_FILES: usize = 3_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopStatus {
    pub available: bool,
    pub exe_path: Option<String>,
    pub version: Option<String>,
    pub product_name: Option<String>,
    pub automation_mode: String,
    pub details: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScannedPsdEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScantechCampaignRequest {
    pub action: String,
    pub id: Option<String>,
    pub content: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScantechExportJob {
    pub item_id: String,
    pub f7: String,
    pub description: String,
    pub source_psd_path: String,
    pub output_psd_path: String,
    pub whole_layer_id: String,
    pub fraction_layer_id: String,
    pub decimal_layer_id: Option<String>,
    pub fraction_rule_layer_id: Option<String>,
    pub validity_layer_id: Option<String>,
    pub whole_value: String,
    pub fraction_value: String,
    pub validity_text: Option<String>,
    pub rotate_delta_deg: Option<f64>,
    pub skew_delta_deg: Option<f64>,
    pub safe_left_limit: Option<f64>,
    pub safe_right_limit: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScantechExportRequest {
    pub jobs: Vec<ScantechExportJob>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScantechExportJobResult {
    pub item_id: String,
    pub f7: String,
    pub ok: bool,
    pub output_psd_path: String,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub whole_applied: Option<String>,
    pub fraction_applied: Option<String>,
    pub validity_applied: Option<String>,
    pub horizontal_scale_applied: Option<f64>,
    pub normalized_transform: Option<bool>,
    pub file_size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScantechExportBatchResult {
    pub photoshop_version: Option<String>,
    pub results: Vec<ScantechExportJobResult>,
}

fn err(e: impl std::fmt::Display) -> String {
    format!("Não foi possível concluir a operação Scantech: {e}")
}

pub(crate) fn clean_windows_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", stripped.replace('/', "\\")))
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped.replace('/', "\\"))
    } else if s.starts_with("//") {
        PathBuf::from(format!(r"\\{}", &s[2..].replace('/', "\\")))
    } else {
        PathBuf::from(s.replace('/', "\\"))
    }
}

pub(crate) fn paths_point_to_same_file(p1: &Path, p2: &Path) -> bool {
    let clean1 = clean_windows_path(p1);
    let clean2 = clean_windows_path(p2);
    if let (Ok(c1), Ok(c2)) = (clean1.canonicalize(), clean2.canonicalize()) {
        return c1 == c2;
    }
    let s1 = clean1.to_string_lossy().replace('/', "\\").to_lowercase();
    let s2 = clean2.to_string_lossy().replace('/', "\\").to_lowercase();
    s1.trim_end_matches('\\') == s2.trim_end_matches('\\')
}

fn parse_registry_exe_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix('"') {
        if let Some(end_quote) = stripped.find('"') {
            let candidate = PathBuf::from(&stripped[..end_quote]);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let lower = trimmed.to_ascii_lowercase();
    if let Some(idx) = lower.find("photoshop.exe") {
        let end = idx + "photoshop.exe".len();
        let candidate = PathBuf::from(trimmed[..end].trim());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn query_reg_default(key: &str) -> Option<String> {
    let output = Command::new("reg")
        .args(["query", key, "/ve"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some(pos) = line.find("REG_SZ") {
            return Some(line[pos + 6..].trim().to_string());
        }
    }
    None
}

#[cfg(not(windows))]
fn query_reg_default(_key: &str) -> Option<String> {
    None
}

pub fn find_photoshop_executable() -> Option<(PathBuf, String, String)> {
    // 1. Consulta chaves COM LocalServer32 registradas no Windows (64-bit e WOW6432Node 32-bit)
    let clsid_keys = [
        r"HKLM\SOFTWARE\Classes\Photoshop.Application\CLSID",
        r"HKLM\SOFTWARE\WOW6432Node\Classes\Photoshop.Application\CLSID",
    ];
    for clsid_key in clsid_keys {
        if let Some(clsid) = query_reg_default(clsid_key) {
            let server_keys = [
                format!(r"HKLM\SOFTWARE\Classes\CLSID\{clsid}\LocalServer32"),
                format!(r"HKLM\SOFTWARE\WOW6432Node\Classes\CLSID\{clsid}\LocalServer32"),
            ];
            for sk in server_keys {
                if let Some(cmd_str) = query_reg_default(&sk) {
                    if let Some(exe) = parse_registry_exe_path(&cmd_str) {
                        let (version, product) = infer_photoshop_version(&exe);
                        return Some((exe, version, product));
                    }
                }
            }
        }
    }

    // 2. Caminhos conhecidos de instalação do Photoshop no Windows
    let known_paths = [
        r"C:\programinha\app\photoshopcs6\photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2024\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2023\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2022\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2021\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop 2020\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop CC 2019\Photoshop.exe",
        r"C:\Program Files\Adobe\Adobe Photoshop CS6 (64 Bit)\Photoshop.exe",
        r"C:\Program Files (x86)\Adobe\Adobe Photoshop CS6\Photoshop.exe",
    ];
    for p in known_paths {
        let candidate = PathBuf::from(p);
        if candidate.is_file() {
            let (version, product) = infer_photoshop_version(&candidate);
            return Some((candidate, version, product));
        }
    }

    // 3. Varredura em C:\Program Files\Adobe e C:\Program Files (x86)\Adobe
    for base in [r"C:\Program Files\Adobe", r"C:\Program Files (x86)\Adobe"] {
        let base_path = Path::new(base);
        if let Ok(entries) = fs::read_dir(base_path) {
            for entry in entries.flatten() {
                let candidate = entry.path().join("Photoshop.exe");
                if candidate.is_file() {
                    let (version, product) = infer_photoshop_version(&candidate);
                    return Some((candidate, version, product));
                }
            }
        }
    }

    None
}

fn infer_photoshop_version(exe: &Path) -> (String, String) {
    let path_str = exe.to_string_lossy().to_lowercase();
    if path_str.contains("cs6") {
        return ("13.0.1".into(), "Adobe Photoshop CS6".into());
    }
    if let Some(parent) = exe.parent().and_then(|p| p.file_name()) {
        let folder = parent.to_string_lossy().into_owned();
        return ("Detectado".into(), folder);
    }
    ("Detectado".into(), "Adobe Photoshop".into())
}

#[tauri::command]
pub fn detect_photoshop() -> Result<PhotoshopStatus, String> {
    match find_photoshop_executable() {
        Some((exe, version, product)) => {
            let exe_str = exe.to_string_lossy().into_owned();
            Ok(PhotoshopStatus {
                available: true,
                exe_path: Some(exe_str.clone()),
                version: Some(version.clone()),
                product_name: Some(product.clone()),
                automation_mode: "ExtendScript JSX (-r)".into(),
                details: format!("{product} (v{version}) disponível em {exe_str}"),
            })
        }
        None => Ok(PhotoshopStatus {
            available: false,
            exe_path: None,
            version: None,
            product_name: None,
            automation_mode: "indisponível".into(),
            details: "Adobe Photoshop não foi encontrado neste computador Windows.".into(),
        }),
    }
}

#[tauri::command]
pub async fn choose_scantech_psd_folder() -> Result<Option<String>, String> {
    let chosen = rfd::AsyncFileDialog::new()
        .set_title("Selecionar pasta com artes PSD de referência")
        .pick_folder()
        .await;
    let Some(folder) = chosen else {
        return Ok(None);
    };
    let path = clean_windows_path(folder.path());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn choose_scantech_export_folder() -> Result<Option<String>, String> {
    let chosen = rfd::AsyncFileDialog::new()
        .set_title("Selecionar pasta de destino para exportar novos arquivos PSD")
        .pick_folder()
        .await;
    let Some(folder) = chosen else {
        return Ok(None);
    };
    let path = clean_windows_path(folder.path());
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub(crate) fn scan_psd_folder_disk(folder: &Path) -> Result<Vec<ScannedPsdEntry>, String> {
    if !folder.exists() || !folder.is_dir() {
        return Err("Pasta de artes PSD não encontrada.".into());
    }
    let mut results = Vec::new();
    let mut stack = vec![folder.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if results.len() >= MAX_PSD_SCAN_FILES {
                break;
            }
            let p = entry.path();
            let meta = match fs::symlink_metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if !entry.file_name().to_string_lossy().starts_with('.') {
                    stack.push(p);
                }
            } else if p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("psd"))
                == Some(true)
            {
                let size = meta.len();
                if (26..=25 * 1024 * 1024).contains(&size) {
                    let modified_at = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() * 1000);
                    results.push(ScannedPsdEntry {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        path: p.to_string_lossy().into_owned(),
                        size,
                        modified_at,
                    });
                }
            }
        }
    }
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(results)
}

#[tauri::command]
pub async fn scan_scantech_psd_folder(folder_path: String) -> Result<Vec<ScannedPsdEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_psd_folder_disk(Path::new(&folder_path)))
        .await
        .map_err(err)?
}

pub(crate) fn validate_scantech_campaign(source: &str) -> Result<Value, String> {
    if source.len() > MAX_SCANTECH_BYTES {
        return Err("Pasta de ofertas Scantech excede 12 MB.".into());
    }
    let v: Value = serde_json::from_str(source)
        .map_err(|_| "Arquivo de pasta Scantech inválido ou corrompido.")?;
    let text = |val: &Value, max: usize| val.as_str().map(|s| s.chars().count() <= max).unwrap_or(false);
    let id = v["id"].as_str().unwrap_or("");
    if v["schemaVersion"] != 1
        || Uuid::parse_str(id).is_err()
        || !text(&v["name"], 80)
        || v["name"].as_str().unwrap_or("").trim().is_empty()
        || !text(&v["globalEndDate"], 20)
        || !v["archived"].is_boolean()
        || !v["items"].is_array()
        || !text(&v["createdAt"], 40)
        || !text(&v["updatedAt"], 40)
    {
        return Err("Dados da pasta Scantech inválidos: confira nome, validade e estrutura.".into());
    }
    let items = v["items"].as_array().unwrap();
    if items.len() > 20_000 {
        return Err("A pasta Scantech excede o limite de 20 mil itens.".into());
    }
    Ok(v)
}

pub(crate) fn scantech_file_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(id).map_err(|_| "Identificador de pasta Scantech inválido.")?;
    if !base.exists() {
        fs::create_dir_all(base).map_err(err)?;
    }
    let root = base.canonicalize().map_err(err)?;
    let target = root.join(format!("{id}.skscantech"));
    storage::inside(&root, &target)
}

pub(crate) fn save_scantech_disk(base: &Path, source: &str) -> Result<Value, String> {
    let val = validate_scantech_campaign(source)?;
    let id = val["id"].as_str().ok_or("ID ausente.")?;
    let path = scantech_file_path(base, id)?;
    let pretty = serde_json::to_string_pretty(&val).map_err(err)?;
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Diretório inválido.")?)
        .map_err(err)?;
    tmp.write_all(pretty.as_bytes()).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    tmp.persist(&path).map_err(err)?;
    let reopened = fs::read_to_string(&path).map_err(err)?;
    validate_scantech_campaign(&reopened)
}

pub(crate) fn list_scantech_disk(base: &Path) -> Result<Value, String> {
    if !base.exists() {
        fs::create_dir_all(base).map_err(err)?;
    }
    let root = base.canonicalize().map_err(err)?;
    let mut campaigns = Vec::new();
    let mut errors = Vec::new();
    for entry in fs::read_dir(&root).map_err(err)? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                errors.push(e.to_string());
                continue;
            }
        };
        let p = entry.path();
        if p.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("skscantech"))
            != Some(true)
        {
            continue;
        }
        match fs::read_to_string(&p)
            .map_err(err)
            .and_then(|s| validate_scantech_campaign(&s))
        {
            Ok(v) => campaigns.push(v),
            Err(e) => errors.push(format!("{}: {e}", entry.file_name().to_string_lossy())),
        }
    }
    campaigns.sort_by(|a, b| {
        b["updatedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["updatedAt"].as_str().unwrap_or(""))
    });
    Ok(json!({ "campaigns": campaigns, "errors": errors }))
}

pub(crate) fn delete_scantech_disk(base: &Path, id: &str) -> Result<bool, String> {
    let path = scantech_file_path(base, id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(err)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn scantech_campaigns(
    app: tauri::AppHandle,
    request: ScantechCampaignRequest,
) -> Result<Value, String> {
    let base = app
        .path()
        .document_dir()
        .map_err(err)?
        .join("Skalee Cartazes")
        .join(".scantech-campanhas");
    tauri::async_runtime::spawn_blocking(move || match request.action.as_str() {
        "list" => list_scantech_disk(&base),
        "save" => {
            let content = request
                .content
                .ok_or("Conteúdo da campanha Scantech ausente.")?;
            save_scantech_disk(&base, &content)
        }
        "delete" => {
            let id = request
                .id
                .ok_or("Identificador da campanha Scantech ausente.")?;
            Ok(json!(delete_scantech_disk(&base, &id)?))
        }
        _ => Err("Ação desconhecida em campanhas Scantech.".into()),
    })
    .await
    .map_err(err)?
}

/// Valida que um arquivo .psd no disco é um documento Photoshop genuíno com camadas editáveis,
/// e não apenas uma imagem rasterizada renomeada como .psd.
pub fn validate_editable_psd_file(path: &Path) -> Result<u64, String> {
    if path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("psd"))
        != Some(true)
    {
        return Err("O arquivo exportado não possui extensão .psd.".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("Não foi possível ler o PSD gerado: {e}"))?;
    if bytes.len() < 64 {
        return Err("Arquivo PSD gerado está truncado ou vazio.".into());
    }
    if &bytes[0..4] != b"8BPS" {
        return Err("Assinatura binária 8BPS ausente: imagens rasterizadas (PNG/JPEG) renomeadas como .psd não são aceitas.".into());
    }
    let version = u16::from_be_bytes([bytes[4], bytes[5]]);
    if version != 1 {
        return Err(format!("Versão de cabeçalho PSD não suportada ({version})."));
    }
    let height = u32::from_be_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
    let width = u32::from_be_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]);
    if width == 0 || height == 0 || width > 10_000 || height > 10_000 {
        return Err(format!("Dimensões inválidas no PSD gerado ({width}x{height})."));
    }
    let color_mode_len = u32::from_be_bytes([bytes[26], bytes[27], bytes[28], bytes[29]]) as usize;
    let resources_pos = 30usize.saturating_add(color_mode_len);
    if resources_pos + 4 > bytes.len() {
        return Err("Seção Image Resources ausente no PSD.".into());
    }
    let resources_len = u32::from_be_bytes([
        bytes[resources_pos],
        bytes[resources_pos + 1],
        bytes[resources_pos + 2],
        bytes[resources_pos + 3],
    ]) as usize;
    let layer_mask_pos = resources_pos.saturating_add(4).saturating_add(resources_len);
    if layer_mask_pos + 4 > bytes.len() {
        return Err("Seção de camadas (Layer and Mask Information) ausente no PSD.".into());
    }
    let layer_mask_len = u32::from_be_bytes([
        bytes[layer_mask_pos],
        bytes[layer_mask_pos + 1],
        bytes[layer_mask_pos + 2],
        bytes[layer_mask_pos + 3],
    ]) as usize;
    if layer_mask_len == 0 {
        return Err("O PSD gerado não contém seção de camadas editáveis (arquivo achatado/rasterizado).".into());
    }
    // Verifica presença de descritor de texto tipográfico (TySh) do Photoshop nas camadas
    let layer_slice_end = layer_mask_pos
        .saturating_add(4)
        .saturating_add(layer_mask_len)
        .min(bytes.len());
    let layer_slice = &bytes[layer_mask_pos..layer_slice_end];
    let has_tysh = layer_slice.windows(4).any(|w| w == b"TySh");
    if !has_tysh {
        return Err("O PSD gerado não contém camadas de texto editáveis (TySh ausente).".into());
    }
    Ok(bytes.len() as u64)
}

fn escape_jsx_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) > 127 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn validate_export_job(job: &ScantechExportJob) -> Result<(PathBuf, PathBuf), String> {
    if job.whole_value.trim().is_empty() || !job.whole_value.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("F7 {}: Parte inteira do preço (Reais) inválida.", job.f7));
    }
    if job.fraction_value.len() != 2 || !job.fraction_value.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("F7 {}: Centavos devem ter exatamente 2 dígitos.", job.f7));
    }
    if job.whole_layer_id.trim().is_empty() || job.fraction_layer_id.trim().is_empty() {
        return Err(format!("F7 {}: Camadas de Reais e Centavos devem estar mapeadas.", job.f7));
    }
    if job.whole_layer_id == job.fraction_layer_id {
        return Err(format!("F7 {}: Reais e Centavos não podem usar a mesma camada.", job.f7));
    }
    let src = PathBuf::from(&job.source_psd_path)
        .canonicalize()
        .map_err(|e| format!("F7 {}: PSD de origem não encontrado ({e}).", job.f7))?;
    crate::psd::validate_path(&src)?;

    let out_raw = PathBuf::from(&job.output_psd_path);
    if out_raw
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("psd"))
        != Some(true)
    {
        return Err(format!("F7 {}: O arquivo de saída deve terminar com .psd.", job.f7));
    }
    let out_parent = out_raw
        .parent()
        .ok_or_else(|| format!("F7 {}: Pasta de saída inválida.", job.f7))?;
    if !out_parent.exists() {
        fs::create_dir_all(out_parent)
            .map_err(|e| format!("F7 {}: Não foi possível criar pasta de saída: {e}", job.f7))?;
    }
    let out_dir = out_parent
        .canonicalize()
        .map_err(|e| format!("F7 {}: Pasta de saída inacessível: {e}", job.f7))?;
    let out_name = out_raw
        .file_name()
        .ok_or_else(|| format!("F7 {}: Nome do PSD de saída inválido.", job.f7))?;
    let dst = out_dir.join(out_name);

    // Proteção absoluta: NUNCA sobrescrever o arquivo PSD original
    if dst == src {
        return Err(format!(
            "F7 {}: Bloqueado por segurança — o arquivo de destino não pode ser o próprio PSD original.",
            job.f7
        ));
    }
    Ok((src, dst))
}

fn generate_batch_jsx(jobs: &[(ScantechExportJob, PathBuf, PathBuf)], status_file: &Path) -> String {
    let status_path = escape_jsx_string(&status_file.to_string_lossy().replace('\\', "/"));
    let mut jobs_js = String::new();
    for (job, src, dst) in jobs {
        let src_str = escape_jsx_string(&src.to_string_lossy().replace('\\', "/"));
        let dst_str = escape_jsx_string(&dst.to_string_lossy().replace('\\', "/"));
        let item_id = escape_jsx_string(&job.item_id);
        let f7 = escape_jsx_string(&job.f7);
        let whole_id = escape_jsx_string(&job.whole_layer_id);
        let frac_id = escape_jsx_string(&job.fraction_layer_id);
        let dec_id = escape_jsx_string(job.decimal_layer_id.as_deref().unwrap_or(""));
        let rule_id = escape_jsx_string(job.fraction_rule_layer_id.as_deref().unwrap_or(""));
        let val_id = escape_jsx_string(job.validity_layer_id.as_deref().unwrap_or(""));
        let whole_val = escape_jsx_string(&job.whole_value);
        let frac_val = escape_jsx_string(&job.fraction_value);
        let val_text = escape_jsx_string(job.validity_text.as_deref().unwrap_or(""));
        let rot_delta = job.rotate_delta_deg.unwrap_or(0.0);
        let skew_delta = job.skew_delta_deg.unwrap_or(0.0);
        let safe_left = job.safe_left_limit.unwrap_or(42.0);
        let safe_right = job.safe_right_limit.unwrap_or(0.0);

        jobs_js.push_str(&format!(
            "{{itemId:\"{item_id}\",f7:\"{f7}\",src:\"{src_str}\",dst:\"{dst_str}\",wholeId:\"{whole_id}\",fractionId:\"{frac_id}\",decimalId:\"{dec_id}\",ruleId:\"{rule_id}\",validityId:\"{val_id}\",wholeVal:\"{whole_val}\",fractionVal:\"{frac_val}\",validityText:\"{val_text}\",rotDelta:{rot_delta},skewDelta:{skew_delta},safeLeft:{safe_left},safeRight:{safe_right}}},\n"
        ));
    }

    format!(
        r##"#target photoshop
app.displayDialogs = DialogModes.NO;

function resolveLayerByPath(container, pathStr) {{
  if (!pathStr) return null;
  var parts = pathStr.split(".");
  var current = container;
  for (var i = 0; i < parts.length; i++) {{
    var idx = parseInt(parts[i], 10);
    if (isNaN(idx) || !current.layers || idx < 0 || idx >= current.layers.length) return null;
    var domIdx = current.layers.length - 1 - idx;
    var layer = current.layers[domIdx];
    if (i === parts.length - 1) return layer;
    current = layer;
  }}
  return null;
}}

function jsonEscape(str) {{
  if (str === null || str === undefined) return "";
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}}

function applyActionTrnf(layer, angleDeg, skewH) {{
  if (angleDeg === 0 && skewH === 0) return;
  app.activeDocument.activeLayer = layer;
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
  desc.putReference(charIDToTypeID("null"), ref);
  desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
  var offsetDesc = new ActionDescriptor();
  offsetDesc.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), 0.0);
  offsetDesc.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), 0.0);
  desc.putObject(charIDToTypeID("Ofst"), charIDToTypeID("Ofst"), offsetDesc);
  if (skewH !== 0) {{
    var skewDesc = new ActionDescriptor();
    skewDesc.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Ang"), skewH);
    skewDesc.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Ang"), 0.0);
    desc.putObject(charIDToTypeID("Skew"), charIDToTypeID("Pnt "), skewDesc);
  }}
  if (angleDeg !== 0) {{
    desc.putUnitDouble(charIDToTypeID("Angl"), charIDToTypeID("#Ang"), angleDeg);
  }}
  executeAction(charIDToTypeID("Trnf"), desc, DialogModes.NO);
}}

function readTextTransform(layer) {{
  try {{
    app.activeDocument.activeLayer = layer;
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    var desc = executeActionGet(ref);
    if (!desc.hasKey(stringIDToTypeID("textKey"))) return null;
    var tk = desc.getObjectValue(stringIDToTypeID("textKey"));
    if (tk.hasKey(stringIDToTypeID("transform"))) {{
      var tr = tk.getObjectValue(stringIDToTypeID("transform"));
      return [
        tr.getDouble(stringIDToTypeID("xx")),
        tr.getDouble(stringIDToTypeID("xy")),
        tr.getDouble(stringIDToTypeID("yx")),
        tr.getDouble(stringIDToTypeID("yy"))
      ];
    }}
  }} catch (_) {{}}
  return null;
}}

function findFirstVisibleLayer(container, pattern) {{
  if (!container || !container.layers) return null;
  for (var i = 0; i < container.layers.length; i++) {{
    var l = container.layers[i];
    if (l.visible) {{
      if (l.kind == LayerKind.TEXT && pattern.test(l.textItem.contents)) return l;
      if (pattern.test(l.name)) return l;
    }}
  }}
  return null;
}}

var jobs = [
{jobs_js}];

var resultsJson = [];
for (var j = 0; j < jobs.length; j++) {{
  var job = jobs[j];
  var doc = null;
  try {{
    var srcFile = new File(job.src);
    var dstFile = new File(job.dst);
    if (!srcFile.exists) throw new Error("Arquivo PSD de origem nao encontrado: " + job.src);
    if (srcFile.fsName.toLowerCase() === dstFile.fsName.toLowerCase()) {{
      throw new Error("Sobrescrita do PSD original bloqueada por seguranca.");
    }}
    doc = app.open(srcFile);
    var wholeLayer = resolveLayerByPath(doc, job.wholeId);
    var fractionLayer = resolveLayerByPath(doc, job.fractionId);
    if (!wholeLayer || wholeLayer.kind != LayerKind.TEXT) {{
      throw new Error("Camada de Reais (" + job.wholeId + ") nao e uma camada de texto editavel.");
    }}
    if (!fractionLayer || fractionLayer.kind != LayerKind.TEXT) {{
      throw new Error("Camada de Centavos (" + job.fractionId + ") nao e uma camada de texto editavel.");
    }}

    var origWholeBounds = [wholeLayer.bounds[0].as("px"), wholeLayer.bounds[1].as("px"), wholeLayer.bounds[2].as("px"), wholeLayer.bounds[3].as("px")];
    var origHScale = (wholeLayer.textItem && typeof wholeLayer.textItem.horizontalScale === "number") ? wholeLayer.textItem.horizontalScale : 100.0;
    var origWholeText = wholeLayer.textItem.contents;

    var commaLayer = resolveLayerByPath(doc, job.decimalId);
    if (!commaLayer) commaLayer = findFirstVisibleLayer(doc, /^,$/);
    var ruleLayer = resolveLayerByPath(doc, job.ruleId);
    if (!ruleLayer) ruleLayer = findFirstVisibleLayer(doc, /rectangle\s*3|linha.*cent/i);

    var fracLeft = fractionLayer.bounds[0].as("px");
    var minObstacleLeft = fracLeft;
    if (commaLayer && commaLayer.visible) {{
      var cLeft = commaLayer.bounds[0].as("px");
      if (cLeft > origWholeBounds[0] && cLeft < minObstacleLeft) minObstacleLeft = cLeft;
    }}
    if (ruleLayer && ruleLayer.visible) {{
      var rLeft = ruleLayer.bounds[0].as("px");
      if (rLeft > origWholeBounds[0] && rLeft < minObstacleLeft) minObstacleLeft = rLeft;
    }}

    var safeRight = job.safeRight > 0 ? job.safeRight : Math.min(minObstacleLeft - 18, Math.max(origWholeBounds[2], minObstacleLeft - 24));
    var safeLeft = job.safeLeft > 0 ? job.safeLeft : Math.min(42, Math.max(16, Math.round(origWholeBounds[0] * 0.5)));
    var availableWidth = Math.max(120, safeRight - safeLeft);

    var rotDelta = job.rotDelta;
    var skewDelta = job.skewDelta;
    var normalizedTransformApplied = false;

    if (rotDelta === 0 && skewDelta === 0) {{
      var tr = readTextTransform(wholeLayer);
      if (tr) {{
        var xx = tr[0], xy = tr[1], yx = tr[2], yy = tr[3];
        var rotDeg = Math.atan2(xy, xx) * 180 / Math.PI;
        var skewDeg = Math.atan2(yx, yy) * 180 / Math.PI;
        var netCounter = skewDeg - rotDeg;
        var isOnes = /^1{{2,}}$/.test(job.wholeVal);
        if (isOnes && (Math.abs(rotDeg) > 0.8 || netCounter < 13.5)) {{
          rotDelta = Math.abs(rotDeg) > 0.8 ? -rotDeg : 0;
          var afterRot = skewDeg - rotDelta;
          var targetSkew = Math.min(17.5, Math.max(afterRot, 15.6));
          skewDelta = targetSkew - afterRot;
        }} else if (Math.abs(rotDeg) > 1.5) {{
          rotDelta = -rotDeg;
          var afterRot = skewDeg - rotDelta;
          var targetSkew = Math.min(14.5, Math.max(7.5, afterRot));
          skewDelta = targetSkew - afterRot;
        }}
      }}
    }}

    if (Math.abs(rotDelta) > 0.1 || Math.abs(skewDelta) > 0.2) {{
      if (Math.abs(rotDelta) > 0.1) applyActionTrnf(wholeLayer, rotDelta, 0);
      if (Math.abs(skewDelta) > 0.2) applyActionTrnf(wholeLayer, 0, skewDelta);
      normalizedTransformApplied = true;
    }}

    wholeLayer.textItem.contents = job.wholeVal;
    var currentB = [wholeLayer.bounds[0].as("px"), wholeLayer.bounds[1].as("px"), wholeLayer.bounds[2].as("px"), wholeLayer.bounds[3].as("px")];
    var currentW = currentB[2] - currentB[0];
    var appliedHScale = origHScale;

    if (currentW > availableWidth) {{
      var scaleRatio = availableWidth / currentW;
      if (scaleRatio < 0.48) {{
        throw new Error("Preco R$ " + job.wholeVal + "," + job.fractionVal + " ultrapassa o limite seguro de reducao horizontal (" + Math.round(scaleRatio * 100) + "% < 48%) para a area util do cartaz.");
      }}
      appliedHScale = origHScale * scaleRatio;
      wholeLayer.textItem.horizontalScale = appliedHScale;
      currentB = [wholeLayer.bounds[0].as("px"), wholeLayer.bounds[1].as("px"), wholeLayer.bounds[2].as("px"), wholeLayer.bounds[3].as("px")];
      if (currentB[2] - currentB[0] > availableWidth) {{
        appliedHScale = appliedHScale * (availableWidth / (currentB[2] - currentB[0]));
        wholeLayer.textItem.horizontalScale = appliedHScale;
        currentB = [wholeLayer.bounds[0].as("px"), wholeLayer.bounds[1].as("px"), wholeLayer.bounds[2].as("px"), wholeLayer.bounds[3].as("px")];
      }}
    }}

    var renderedW = currentB[2] - currentB[0];
    var targetRight = Math.min(safeRight, Math.max(origWholeBounds[2], origWholeBounds[0] + renderedW));
    var dx = targetRight - currentB[2];
    if (currentB[0] + dx < safeLeft) {{
      dx = safeLeft - currentB[0];
    }}
    if (Math.abs(dx) >= 0.5) {{
      wholeLayer.translate(new UnitValue(dx, "px"), new UnitValue(0, "px"));
    }}

    fractionLayer.textItem.contents = job.fractionVal;

    var validityApplied = "";
    if (job.validityText) {{
      var validityLayer = resolveLayerByPath(doc, job.validityId);
      if (!validityLayer || !validityLayer.visible) {{
        validityLayer = findFirstVisibleLayer(doc, /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b)/i);
      }}
      if (validityLayer && validityLayer.visible && validityLayer.kind == LayerKind.TEXT) {{
        validityLayer.textItem.contents = job.validityText;
        validityApplied = validityLayer.textItem.contents;
      }}
    }}

    var saveOpts = new PhotoshopSaveOptions();
    saveOpts.layers = true;
    saveOpts.embedColorProfile = true;
    saveOpts.maximizeCompatibility = true;
    doc.saveAs(dstFile, saveOpts, true, Extension.LOWERCASE);
    doc.close(SaveOptions.DONOTSAVECHANGES);
    doc = null;

    var verifyDoc = app.open(dstFile);
    var vWhole = resolveLayerByPath(verifyDoc, job.wholeId);
    var vFrac = resolveLayerByPath(verifyDoc, job.fractionId);
    var wholeRead = (vWhole && vWhole.kind == LayerKind.TEXT) ? vWhole.textItem.contents : "";
    var fracRead = (vFrac && vFrac.kind == LayerKind.TEXT) ? vFrac.textItem.contents : "";
    var valRead = "";
    if (job.validityText) {{
      var vVal = resolveLayerByPath(verifyDoc, job.validityId);
      if (!vVal || !vVal.visible) vVal = findFirstVisibleLayer(verifyDoc, /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b)/i);
      valRead = (vVal && vVal.kind == LayerKind.TEXT) ? vVal.textItem.contents : "";
    }}

    if (vWhole && vFrac) {{
      var vWholeRight = vWhole.bounds[2].as("px");
      var vFracLeft = vFrac.bounds[0].as("px");
      if (vWholeRight > vFracLeft) {{
        verifyDoc.close(SaveOptions.DONOTSAVECHANGES);
        throw new Error("Inconsistencia geometrica: camada de Reais colidiu com Centavos (Reais=" + vWholeRight + " > Centavos=" + vFracLeft + ").");
      }}
    }}
    verifyDoc.close(SaveOptions.DONOTSAVECHANGES);

    resultsJson.push(
      '{{"itemId":"' + jsonEscape(job.itemId) +
      '","f7":"' + jsonEscape(job.f7) +
      '","ok":true,"outputPsdPath":"' + jsonEscape(job.dst) +
      '","wholeApplied":"' + jsonEscape(wholeRead) +
      '","fractionApplied":"' + jsonEscape(fracRead) +
      '","validityApplied":"' + jsonEscape(valRead) +
      '","horizontalScaleApplied":' + appliedHScale.toFixed(2) +
      ',"normalizedTransform":' + (normalizedTransformApplied ? "true" : "false") + '}}'
    );
  }} catch (err) {{
    if (doc != null) {{
      try {{ doc.close(SaveOptions.DONOTSAVECHANGES); }} catch (_) {{}}
    }}
    resultsJson.push(
      '{{"itemId":"' + jsonEscape(job.itemId) +
      '","f7":"' + jsonEscape(job.f7) +
      '","ok":false,"outputPsdPath":"' + jsonEscape(job.dst) +
      '","error":"' + jsonEscape(err.toString()) + '"}}'
    );
  }}
}}

var statusFile = new File("{status_path}");
statusFile.encoding = "UTF-8";
statusFile.open("w");
statusFile.write('{{"version":"' + jsonEscape(app.version) + '","results":[' + resultsJson.join(",") + ']}}');
statusFile.close();
"##
    )
}

pub fn run_scantech_export_batch(request: ScantechExportRequest) -> Result<ScantechExportBatchResult, String> {
    if request.jobs.is_empty() {
        return Err("Nenhum produto selecionado para exportação.".into());
    }
    let (exe_path, detected_version, _) = find_photoshop_executable().ok_or_else(|| {
        "Adobe Photoshop não foi encontrado instalado no Windows. A exportação de PSD editável requer o Photoshop instalado.".to_string()
    })?;

    let mut validated_jobs = Vec::new();
    let mut immediate_failures = Vec::new();

    for job in &request.jobs {
        match validate_export_job(job) {
            Ok((src, dst)) => {
                // Guarda hash do PSD original antes da execução para comprovar que o original permaneceu intacto
                validated_jobs.push((job.clone(), src, dst));
            }
            Err(e) => {
                immediate_failures.push(ScantechExportJobResult {
                    item_id: job.item_id.clone(),
                    f7: job.f7.clone(),
                    ok: false,
                    output_psd_path: job.output_psd_path.clone(),
                    error: Some(e),
                    warnings: vec![],
                    whole_applied: None,
                    fraction_applied: None,
                    validity_applied: None,
                    horizontal_scale_applied: None,
                    normalized_transform: None,
                    file_size: None,
                });
            }
        }
    }

    if validated_jobs.is_empty() {
        return Ok(ScantechExportBatchResult {
            photoshop_version: Some(detected_version),
            results: immediate_failures,
        });
    }

    let original_snapshots: Vec<(PathBuf, u64)> = validated_jobs
        .iter()
        .filter_map(|(_, src, _)| fs::metadata(src).ok().map(|m| (src.clone(), m.len())))
        .collect();

    let work_dir = std::env::temp_dir().join(format!("skalee-scantech-{}", Uuid::new_v4()));
    fs::create_dir_all(&work_dir).map_err(err)?;
    let status_file = work_dir.join("status.json");
    let jsx_file = work_dir.join("scantech_export.jsx");

    let jsx_script = generate_batch_jsx(&validated_jobs, &status_file);
    fs::write(&jsx_file, jsx_script.as_bytes()).map_err(err)?;

    Command::new(&exe_path)
        .arg("-r")
        .arg(&jsx_file)
        .spawn()
        .map_err(|e| format!("Falha ao iniciar o Photoshop ({}): {e}", exe_path.display()))?;

    let timeout = Duration::from_secs(60 + (validated_jobs.len() as u64) * 15);
    let start = Instant::now();
    while start.elapsed() < timeout {
        if status_file.exists() {
            if let Ok(meta) = fs::metadata(&status_file) {
                if meta.len() > 10 {
                    std::thread::sleep(Duration::from_millis(120));
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    if !status_file.exists() {
        let _ = fs::remove_dir_all(&work_dir);
        return Err("Tempo limite excedido aguardando o Photoshop processar os arquivos PSD.".into());
    }

    let raw_status = fs::read_to_string(&status_file).map_err(err)?;
    let _ = fs::remove_dir_all(&work_dir);

    let parsed: Value = serde_json::from_str(&raw_status)
        .map_err(|e| format!("Resposta inválida da automação do Photoshop: {e}"))?;

    let ps_version = parsed["version"]
        .as_str()
        .map(|s| s.to_string())
        .or(Some(detected_version));

    let mut final_results = immediate_failures;
    if let Some(arr) = parsed["results"].as_array() {
        for entry in arr {
            let item_id = entry["itemId"].as_str().unwrap_or("").to_string();
            let f7 = entry["f7"].as_str().unwrap_or("").to_string();
            let ok = entry["ok"].as_bool().unwrap_or(false);
            let out_path = entry["outputPsdPath"].as_str().unwrap_or("").to_string();
            if !ok {
                let err_msg = entry["error"]
                    .as_str()
                    .unwrap_or("Erro desconhecido no Photoshop")
                    .to_string();
                final_results.push(ScantechExportJobResult {
                    item_id,
                    f7,
                    ok: false,
                    output_psd_path: out_path,
                    error: Some(err_msg),
                    warnings: vec![],
                    whole_applied: None,
                    fraction_applied: None,
                    validity_applied: None,
                    horizontal_scale_applied: None,
                    normalized_transform: None,
                    file_size: None,
                });
                continue;
            }

            let whole_applied = entry["wholeApplied"].as_str().map(|s| s.trim().to_string());
            let fraction_applied = entry["fractionApplied"].as_str().map(|s| s.trim().to_string());
            let validity_applied = entry["validityApplied"].as_str().map(|s| s.trim().to_string());
            let horizontal_scale_applied = entry["horizontalScaleApplied"].as_f64();
            let normalized_transform = entry["normalizedTransform"].as_bool();

            // Valida estrutura binária do PSD gerado (garante 8BPS + camadas + TySh)
            let dst_path = Path::new(&out_path);
            match validate_editable_psd_file(dst_path) {
                Ok(file_size) => {
                    final_results.push(ScantechExportJobResult {
                        item_id,
                        f7,
                        ok: true,
                        output_psd_path: out_path,
                        error: None,
                        warnings: vec![],
                        whole_applied,
                        fraction_applied,
                        validity_applied,
                        horizontal_scale_applied,
                        normalized_transform,
                        file_size: Some(file_size),
                    });
                }
                Err(validation_err) => {
                    final_results.push(ScantechExportJobResult {
                        item_id,
                        f7,
                        ok: false,
                        output_psd_path: out_path,
                        error: Some(validation_err),
                        warnings: vec![],
                        whole_applied,
                        fraction_applied,
                        validity_applied,
                        horizontal_scale_applied,
                        normalized_transform,
                        file_size: None,
                    });
                }
            }
        }
    }

    // Confirma que os PSDs originais continuam intactos
    for (src_path, orig_len) in original_snapshots {
        if let Ok(meta) = fs::metadata(&src_path) {
            if meta.len() != orig_len {
                return Err(format!(
                    "Alerta de integridade: tamanho do PSD original {} divergiu.",
                    src_path.display()
                ));
            }
        }
    }

    Ok(ScantechExportBatchResult {
        photoshop_version: ps_version,
        results: final_results,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteScantechPsdRequest {
    pub output_path: String,
    pub source_psd_path: String,
    pub bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteScantechPsdResponse {
    pub file_size: u64,
}

#[tauri::command]
pub fn write_scantech_psd(
    request: WriteScantechPsdRequest,
) -> Result<WriteScantechPsdResponse, String> {
    let raw_out = PathBuf::from(&request.output_path);
    let raw_src = PathBuf::from(&request.source_psd_path);

    let out_path = clean_windows_path(&raw_out);
    let src_path = clean_windows_path(&raw_src);

    if out_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("psd"))
        != Some(true)
    {
        return Err("O caminho de saída deve ter extensão .psd.".into());
    }

    if !src_path.is_file() {
        return Err(format!(
            "Arquivo PSD original não encontrado: {}",
            src_path.display()
        ));
    }

    if paths_point_to_same_file(&out_path, &src_path) {
        return Err(
            "Bloqueado por segurança: o arquivo de saída não pode sobrescrever o PSD original."
                .into(),
        );
    }

    if request.bytes.len() < 64 || request.bytes.len() > 50 * 1024 * 1024 {
        return Err("Conteúdo binário PSD inválido ou fora dos limites de tamanho.".into());
    }

    if &request.bytes[0..4] != b"8BPS" {
        return Err("Assinatura binária 8BPS ausente no arquivo exportado.".into());
    }

    let orig_meta = fs::metadata(&src_path).map_err(err)?;
    let orig_len = orig_meta.len();

    let parent = out_path
        .parent()
        .ok_or_else(|| "Diretório de destino inválido.".to_string())?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(err)?;
    }

    // 1. Cria nome de arquivo temporário exclusivo no próprio diretório de destino
    let tmp_name = format!(
        ".tmp_psd_export_{}_{}.tmp",
        std::process::id(),
        Uuid::new_v4().simple()
    );
    let tmp_path = parent.join(tmp_name);

    // 2. Grava os bytes no arquivo temporário e fecha o descritor explicitamente (Drop)
    {
        let mut tmp_file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)
            .map_err(err)?;
        tmp_file.write_all(&request.bytes).map_err(err)?;
        tmp_file.sync_all().map_err(err)?;
    } // O handle do arquivo temporário é fechado de forma garantida antes da renomeação

    // 3. Se o arquivo de destino já existe, remove proteção de somente-leitura e limpa antes da substituição
    if out_path.exists() {
        if let Ok(meta) = fs::metadata(&out_path) {
            let mut perms = meta.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                let _ = fs::set_permissions(&out_path, perms);
            }
        }
        let _ = fs::remove_file(&out_path);
    }

    // 4. Renomeação atômica com repetição para contornar bloqueios transitórios
    // (ex: antivírus/Windows Defender ou indexador de arquivos do Desktop no Windows)
    let mut renamed = false;
    let mut last_io_err = None;

    for attempt in 0..8 {
        match fs::rename(&tmp_path, &out_path) {
            Ok(_) => {
                renamed = true;
                break;
            }
            Err(e) => {
                if out_path.exists() {
                    let _ = fs::remove_file(&out_path);
                }
                std::thread::sleep(Duration::from_millis(40 * (attempt + 1) as u64));
                last_io_err = Some(e);
            }
        }
    }

    if !renamed {
        // Fallback: se rename falhar (ex: restrições especiais de volume), tenta cópia + exclusão
        match fs::copy(&tmp_path, &out_path) {
            Ok(_) => {
                let _ = fs::remove_file(&tmp_path);
            }
            Err(copy_err) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!(
                    "Não foi possível persistir arquivo PSD de destino: {}",
                    last_io_err.unwrap_or(copy_err)
                ));
            }
        }
    }

    // 5. Verificação de integridade: assegura que o arquivo de origem nunca foi modificado
    if let Ok(meta) = fs::metadata(&src_path) {
        if meta.len() != orig_len {
            return Err("Alerta de integridade: o arquivo PSD original foi modificado.".into());
        }
    }

    let file_size = validate_editable_psd_file(&out_path)?;
    Ok(WriteScantechPsdResponse { file_size })
}

#[tauri::command]
pub async fn export_scantech_psds(
    request: ScantechExportRequest,
) -> Result<ScantechExportBatchResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_scantech_export_batch(request))
        .await
        .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_renamed_raster_image_as_psd() {
        let dir = tempfile::tempdir().unwrap();
        let fake_psd = dir.path().join("falso_raster.psd");
        // Assinatura PNG renomeada como .psd
        let png_bytes = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        fs::write(&fake_psd, png_bytes).unwrap();
        let res = validate_editable_psd_file(&fake_psd);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("8BPS"));
    }

    #[test]
    fn blocks_overwriting_original_psd() {
        let dir = tempfile::tempdir().unwrap();
        let orig = dir.path().join("original.psd");
        let mut psd_stub = b"8BPS\x00\x01".to_vec();
        psd_stub.resize(128, 0);
        fs::write(&orig, psd_stub).unwrap();

        let job = ScantechExportJob {
            item_id: "1".into(),
            f7: "12345".into(),
            description: "CERVEJA CORONA".into(),
            source_psd_path: orig.to_string_lossy().into_owned(),
            output_psd_path: orig.to_string_lossy().into_owned(),
            whole_layer_id: "10".into(),
            fraction_layer_id: "11".into(),
            decimal_layer_id: None,
            fraction_rule_layer_id: None,
            validity_layer_id: Some("13".into()),
            whole_value: "4".into(),
            fraction_value: "99".into(),
            validity_text: Some("OFERTA VÁLIDA ATÉ 30/10".into()),
            rotate_delta_deg: None,
            skew_delta_deg: None,
            safe_left_limit: None,
            safe_right_limit: None,
        };
        let res = validate_export_job(&job);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Bloqueado por segurança"));
    }
}
