use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;
use uuid::Uuid;

const MAX_EXCEL_BYTES: u64 = 25 * 1024 * 1024;
const MAX_CAMPAIGN_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct ExcelAccess(Mutex<HashSet<PathBuf>>);

#[derive(Serialize)]
pub struct SelectedExcel {
    pub name: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignRequest {
    pub action: String,
    pub id: Option<String>,
    pub content: Option<String>,
}

fn err(e: impl std::fmt::Display) -> String {
    format!("Não foi possível concluir a operação na pasta de ofertas: {e}")
}

fn canonical_excel(path: &Path) -> Result<PathBuf, String> {
    let p = path.canonicalize().map_err(|e| format!("Não foi possível abrir o Excel: {e}"))?;
    if p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("xlsx")) != Some(true) {
        return Err("Selecione um arquivo Excel .xlsx.".into());
    }
    if !p.is_file() {
        return Err("O caminho selecionado não é um arquivo .xlsx.".into());
    }
    Ok(p)
}

pub(crate) fn read_selected_excel(path: &Path, allowed: &HashSet<PathBuf>) -> Result<Vec<u8>, String> {
    let p = canonical_excel(path)?;
    if !allowed.contains(&p) {
        return Err("Selecione o arquivo Excel pelo diálogo nativo antes de importá-lo.".into());
    }
    let file = fs::File::open(&p).map_err(|e| format!("Não foi possível ler o Excel: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_EXCEL_BYTES {
        return Err("A planilha Excel excede o limite de 25 MB.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_EXCEL_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_EXCEL_BYTES {
        return Err("A planilha Excel excede o limite de 25 MB.".into());
    }
    if bytes.get(0..4) != Some(&[0x50, 0x4b, 0x03, 0x04]) {
        return Err("Arquivo inválido: assinatura .xlsx (ZIP) não encontrada.".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn choose_excel(access: tauri::State<'_, ExcelAccess>) -> Result<Option<SelectedExcel>, String> {
    let selected = rfd::AsyncFileDialog::new()
        .add_filter("Planilha Excel (.xlsx)", &["xlsx"])
        .pick_file()
        .await;
    match selected {
        None => Ok(None),
        Some(file) => {
            let p = canonical_excel(file.path())?;
            let result = SelectedExcel {
                name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
            };
            let mut allowed = access.0.lock().map_err(|e| e.to_string())?;
            allowed.clear();
            allowed.insert(p);
            Ok(Some(result))
        }
    }
}

#[tauri::command]
pub async fn read_excel(path: String, access: tauri::State<'_, ExcelAccess>) -> Result<tauri::ipc::Response, String> {
    let allowed = access.0.lock().map_err(|e| e.to_string())?.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || read_selected_excel(Path::new(&path), &allowed))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

pub(crate) fn validate_campaign(source: &str) -> Result<Value, String> {
    if source.len() > MAX_CAMPAIGN_BYTES {
        return Err("Pasta de ofertas excede 8 MB.".into());
    }
    let v: Value = serde_json::from_str(source).map_err(|_| "Arquivo de pasta de ofertas inválido ou corrompido.")?;
    let text = |val: &Value, max: usize| val.as_str().map(|s| s.chars().count() <= max).unwrap_or(false);
    let id = v["id"].as_str().unwrap_or("");
    if v["schemaVersion"] != 1
        || Uuid::parse_str(id).is_err()
        || !text(&v["name"], 80)
        || v["name"].as_str().unwrap_or("").trim().is_empty()
        || !text(&v["campaignDate"], 20)
        || v["campaignDate"].as_str().unwrap_or("").trim().is_empty()
        || !v["archived"].is_boolean()
        || !v["items"].is_array()
        || !text(&v["createdAt"], 40)
        || !text(&v["updatedAt"], 40)
    {
        return Err("Dados da pasta de ofertas inválidos: confira nome, data e estrutura.".into());
    }
    let items = v["items"].as_array().unwrap();
    if items.len() > 20_000 {
        return Err("A pasta de ofertas excede o limite de 20 mil itens.".into());
    }
    for item in items {
        let f7_ok = item["f7"].as_str().map(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).unwrap_or(false);
        let price_ok = item["scheduledPriceCents"].as_u64().map(|n| (1..=99_999_999).contains(&n)).unwrap_or(false);
        let posters_ok = item["posters"].as_array().map(|posters| {
            posters.len() <= 200 && posters.iter().all(|p| {
                p["cartazId"].is_string()
                    && p["cartazPath"].is_string()
                    && p["selected"].is_boolean()
                    && p["copies"].as_u64().map(|c| (1..=999).contains(&c)).unwrap_or(false)
                    && matches!(p["status"].as_str(), Some("pendente" | "preparado" | "impresso"))
            })
        }).unwrap_or(false);
        if !text(&item["id"], 100) || !f7_ok || !text(&item["description"], 120) || !price_ok || !posters_ok {
            return Err("Item inválido na pasta de ofertas: F7 deve ser string numérica e preço em centavos.".into());
        }
    }
    Ok(v)
}

pub(crate) fn campaign_file_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(id).map_err(|_| "Identificador de pasta de ofertas inválido.")?;
    if !base.exists() {
        fs::create_dir_all(base).map_err(err)?;
    }
    let root = base.canonicalize().map_err(err)?;
    let target = root.join(format!("{id}.skoferta"));
    storage::inside(&root, &target)
}

pub(crate) fn save_campaign_disk(base: &Path, source: &str) -> Result<Value, String> {
    let val = validate_campaign(source)?;
    let id = val["id"].as_str().ok_or("ID ausente.")?;
    let path = campaign_file_path(base, id)?;
    let pretty = serde_json::to_string_pretty(&val).map_err(err)?;
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Diretório inválido.")?).map_err(err)?;
    tmp.write_all(pretty.as_bytes()).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    tmp.persist(&path).map_err(err)?;
    let reopened = fs::read_to_string(&path).map_err(err)?;
    validate_campaign(&reopened)
}

pub(crate) fn list_campaigns_disk(base: &Path) -> Result<Value, String> {
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
        if p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("skoferta")) != Some(true) {
            continue;
        }
        match fs::read_to_string(&p).map_err(err).and_then(|s| validate_campaign(&s)) {
            Ok(v) => campaigns.push(v),
            Err(e) => errors.push(format!("{}: {e}", entry.file_name().to_string_lossy())),
        }
    }
    campaigns.sort_by(|a, b| {
        b["updatedAt"].as_str().unwrap_or("").cmp(a["updatedAt"].as_str().unwrap_or(""))
    });
    Ok(json!({ "campaigns": campaigns, "errors": errors }))
}

pub(crate) fn delete_campaign_disk(base: &Path, id: &str) -> Result<bool, String> {
    let path = campaign_file_path(base, id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(err)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn offer_campaigns(app: tauri::AppHandle, request: CampaignRequest) -> Result<Value, String> {
    let base = app
        .path()
        .document_dir()
        .map_err(err)?
        .join("Skalee Cartazes")
        .join(".ofertas-programadas");
    tauri::async_runtime::spawn_blocking(move || match request.action.as_str() {
        "list" => list_campaigns_disk(&base),
        "save" => {
            let content = request.content.ok_or("Conteúdo da pasta de ofertas ausente.")?;
            save_campaign_disk(&base, &content)
        }
        "delete" => {
            let id = request.id.ok_or("Identificador da pasta de ofertas ausente.")?;
            Ok(json!(delete_campaign_disk(&base, &id)?))
        }
        _ => Err("Ação desconhecida em pastas de ofertas.".into()),
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn campaign_persistence_and_f7_validation() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join(".ofertas-programadas");
        let id = Uuid::new_v4().to_string();
        let campaign = json!({
            "schemaVersion": 1,
            "id": id,
            "name": "Ofertas de Amanhã",
            "campaignDate": "2026-10-27",
            "archived": false,
            "sourceExcel": null,
            "items": [{
                "id": "item-1",
                "rowNumber": 2,
                "f7": "001245",
                "description": "REPOLHO VERDE",
                "scheduledPriceCents": 349,
                "conflicting": false,
                "issues": [],
                "posters": [{
                    "cartazId": "poster-uuid",
                    "cartazPath": "C:\\Biblioteca\\repolho.skcartaz",
                    "selected": true,
                    "copies": 2,
                    "status": "preparado",
                    "printedAt": null
                }]
            }],
            "createdAt": "2026-10-26T12:00:00Z",
            "updatedAt": "2026-10-26T12:00:00Z"
        });
        let saved = save_campaign_disk(&base, &campaign.to_string()).unwrap();
        assert_eq!(saved["items"][0]["f7"], "001245");
        assert_eq!(saved["items"][0]["scheduledPriceCents"], 349);
        assert_eq!(saved["items"][0]["posters"][0]["copies"], 2);
        assert_eq!(saved["items"][0]["posters"][0]["status"], "preparado");

        let listed = list_campaigns_disk(&base).unwrap();
        assert_eq!(listed["campaigns"].as_array().unwrap().len(), 1);
        assert_eq!(listed["campaigns"][0]["id"], id);

        let mut invalid = campaign.clone();
        invalid["items"][0]["f7"] = json!(1245);
        assert!(save_campaign_disk(&base, &invalid.to_string()).is_err());
    }

    #[test]
    fn excel_read_only_and_signature_validation() {
        let dir = tempfile::tempdir().unwrap();
        let xlsx = dir.path().join("ofertas.xlsx");
        let payload = vec![0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0];
        fs::write(&xlsx, &payload).unwrap();
        assert!(read_selected_excel(&xlsx, &HashSet::new()).is_err());
        let allowed = HashSet::from([xlsx.canonicalize().unwrap()]);
        assert_eq!(read_selected_excel(&xlsx, &allowed).unwrap(), payload);
        assert_eq!(fs::read(&xlsx).unwrap(), payload);
    }
}
