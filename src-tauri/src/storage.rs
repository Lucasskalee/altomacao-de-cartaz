use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;
pub(crate) const MAX_DOCUMENT_BYTES: usize = 12 * 1024 * 1024;

#[derive(Default)]
pub struct Access(Mutex<HashSet<PathBuf>>);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    action: String,
    path: Option<String>,
    destination: Option<String>,
    content: Option<String>,
    name: Option<String>,
    overwrite: Option<bool>,
}
fn err(e: impl std::fmt::Display) -> String { format!("Não foi possível concluir a operação: {e}") }
fn extension(p: &Path) -> Result<(), String> {
    if p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("skcartaz")) != Some(true) {
        return Err("Selecione um arquivo .skcartaz.".into());
    }
    Ok(())
}
fn name(s: &str) -> Result<(), String> {
    let base = s.split('.').next().unwrap_or("").to_uppercase();
    if s.is_empty() || s.len() > 180 || s.ends_with(['.', ' ']) || s.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) || ["CON","PRN","AUX","NUL"].contains(&base.as_str()) || (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && base.ends_with(['1','2','3','4','5','6','7','8','9'])) {
        return Err("Nome inválido para arquivo ou pasta no Windows.".into());
    }
    Ok(())
}
fn resolved(p: &Path) -> Result<PathBuf, String> {
    if p.exists() { p.canonicalize().map_err(err) }
    else { Ok(p.parent().ok_or("Caminho inválido.")?.canonicalize().map_err(err)?.join(p.file_name().ok_or("Nome inválido.")?)) }
}
pub(crate) fn inside(root: &Path, p: &Path) -> Result<PathBuf, String> {
    let p = resolved(p)?;
    if !p.starts_with(root) { return Err("A operação deve permanecer na biblioteca local.".into()); }
    Ok(p)
}
pub(crate) fn document(s: &str) -> Result<Value, String> {
    if s.len() > MAX_DOCUMENT_BYTES { return Err("Documento excede 12 MB.".into()); }
    let v: Value = serde_json::from_str(s).map_err(|_| "Arquivo JSON inválido ou corrompido.")?;
    let p = &v["product"];
    let text = |v: &Value, max: usize| v.as_str().map(|s| s.chars().count() <= max).unwrap_or(false);
    // Preserve legacy free-text codes and absent codes from v0.2.0. New F7 input
    // is digit-only in the editor; string codes have no fixed length limit.
    let template = v["layout"]["template"].as_str();
    let imported_ok = template != Some("imported-psd") || imported_artwork(&v["layout"]["artwork"]);
    if v["schemaVersion"] != 1 || !text(&v["id"], 100) || v["id"].as_str() == Some("") || !text(&p["name"],32) || p["name"].as_str().unwrap_or("").trim().is_empty() || !text(&p["complement"],28) || !text(&p["unit"],12) || p["unit"].as_str().unwrap_or("").trim().is_empty() || !(p["productCode"].is_null() || p["productCode"].is_string()) || p["priceCents"].as_u64().map(|n| n > 99_999_999).unwrap_or(true) || !matches!(template, Some("oferta-classica" | "imported-psd")) || !imported_ok || v["layout"]["paper"] != "A5" || v["layout"]["orientation"] != "portrait" || !text(&v["metadata"]["createdAt"],40) || !text(&v["metadata"]["updatedAt"],40) {
        return Err("Documento incompatível: confira versão, produto, preço em centavos e layout A5.".into());
    }
    Ok(v)
}
fn imported_artwork(a: &Value) -> bool {
    let png = |v: &Value| v.as_str().map(|s| s.starts_with("data:image/png;base64,") && s.len() <= 8 * 1024 * 1024).unwrap_or(false);
    let source = &a["source"];
    let canvas = &a["canvas"];
    a["kind"] == "imported-psd" && matches!(a["compatibility"].as_str(), Some("ready" | "requires-preparation"))
        && source["fileName"].is_string() && source["sha256"].as_str().map(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())).unwrap_or(false)
        && (source["sourcePath"].is_null() || source["sourcePath"].is_string())
        && canvas["width"].as_u64().map(|n| (1..=10_000).contains(&n)).unwrap_or(false)
        && canvas["height"].as_u64().map(|n| (1..=10_000).contains(&n)).unwrap_or(false)
        && canvas["resolutionPpi"].as_f64().map(|n| (1.0..=2400.0).contains(&n)).unwrap_or(false)
        && canvas["fit"] == "contain" && png(&a["staticBackground"]) && png(&a["originalPreview"])
        && a["priceParts"].as_array().map(|parts| parts.iter().any(|p| p["role"] == "whole") && parts.iter().any(|p| p["role"] == "fraction")).unwrap_or(false)
        && a["layers"].is_array() && a["warnings"].is_array()
}
pub(crate) fn read(p: &Path) -> Result<String, String> {
    extension(p)?;
    if fs::metadata(p).map_err(err)?.len() > MAX_DOCUMENT_BYTES as u64 { return Err("Documento excede 12 MB.".into()); }
    let s = fs::read_to_string(p).map_err(err)?; document(&s)?; Ok(s)
}
pub(crate) fn write(p: &Path, s: &str, overwrite: bool) -> Result<(), String> {
    extension(p)?; document(s)?;
    let mut tmp = tempfile::NamedTempFile::new_in(p.parent().ok_or("Caminho inválido.")?).map_err(err)?;
    tmp.write_all(s.as_bytes()).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    if overwrite { tmp.persist(p).map_err(err)?; }
    else { tmp.persist_noclobber(p).map_err(|_| "Já existe um arquivo nesse destino. Escolha outro nome.")?; }
    Ok(())
}
fn move_file(source: &Path, target: &Path) -> Result<(), String> {
    let content = read(source)?;
    write(target, &content, false)?;
    fs::remove_file(source).map_err(err)
}
fn scan(root: &Path, dir: &Path, rows: &mut Vec<Value>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        let p = entry.path();
        // Never follow junctions/symlinks outside the library or recursively through links.
        let meta = fs::symlink_metadata(&p).map_err(err)?;
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 { continue; }
        }
        if meta.file_type().is_symlink() { continue; }
        if entry.file_name().to_string_lossy().starts_with('.') { continue; }
        let p = inside(root, &p)?;
        if meta.is_dir() {
            rows.push(json!({"path":p,"name":entry.file_name().to_string_lossy(),"folder":true}));
            scan(root, &p, rows)?;
        } else if extension(&p).is_ok() {
            match read(&p) {
                Ok(s) => rows.push(json!({"path":p,"name":entry.file_name().to_string_lossy(),"folder":false,"content":s,"modifiedAt":meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_secs()*1000)})),
                Err(e) => rows.push(json!({"path":p,"name":entry.file_name().to_string_lossy(),"folder":false,"error":e})),
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn files(app: tauri::AppHandle, access: tauri::State<'_, Access>, request: Request) -> Result<Value, String> {
    let root = app.path().document_dir().map_err(err)?.join("Skalee Cartazes");
    if !root.exists() {
        fs::create_dir_all(&root).map_err(err)?;
        for n in ["Hortifruti", "Açougue", "Padaria", "Mercearia", "Bebidas"] { fs::create_dir_all(root.join(n)).map_err(err)?; }
    }
    let root = root.canonicalize().map_err(err)?;
    let r = request;
    if r.action == "confirmDiscard" {
        let result = rfd::AsyncMessageDialog::new().set_title("Alterações não salvas")
            .set_description("Descartar as alterações não salvas? Escolha Não para voltar e salvar o cartaz.")
            .set_buttons(rfd::MessageButtons::YesNo).show().await;
        return Ok(json!(result == rfd::MessageDialogResult::Yes));
    }
    if r.action == "list" {
        let mut rows = vec![]; scan(&root, &root, &mut rows)?;
        return Ok(json!({"root":root,"entries":rows}));
    }
    if r.action == "openDialog" || r.action == "saveDialog" || r.action == "folderDialog" {
        let dialog = rfd::AsyncFileDialog::new().set_directory(&root).add_filter("Cartaz Skalee", &["skcartaz"]);
        let chosen = if r.action == "openDialog" { dialog.pick_file().await }
            else if r.action == "folderDialog" { dialog.pick_folder().await }
            else { dialog.set_file_name(r.name.as_deref().unwrap_or("cartaz.skcartaz")).save_file().await };
        return match chosen {
            None => Ok(Value::Null),
            Some(file) => {
                let p = resolved(file.path())?;
                if r.action == "folderDialog" { inside(&root, &p)?; }
                else { extension(&p)?; access.0.lock().map_err(err)?.insert(p.clone()); }
                Ok(json!(p))
            }
        };
    }
    let raw = PathBuf::from(r.path.ok_or("Caminho ausente.")?);
    let p = resolved(&raw)?;
    if !p.starts_with(&root) && !access.0.lock().map_err(err)?.contains(&p) { return Err("Escolha o arquivo no diálogo nativo para autorizar o acesso.".into()); }
    match r.action.as_str() {
        "read" => Ok(json!(read(&p)?)),
        "save" => { write(&p, &r.content.ok_or("Documento ausente.")?, r.overwrite.unwrap_or(false))?; Ok(json!(p)) },
        "mkdir" => {
            inside(&root, &p)?;
            let n = r.name.ok_or("Nome ausente.")?; name(&n)?;
            let target = p.join(n); fs::create_dir(&target).map_err(err)?; Ok(json!(target))
        },
        "rename" | "move" => {
            inside(&root, &p)?;
            if p == root { return Err("A pasta principal não pode ser alterada.".into()); }
            let target = if r.action == "rename" {
                let n = r.name.ok_or("Nome ausente.")?; name(&n)?;
                if p.is_file() { extension(Path::new(&n))?; }
                p.parent().ok_or("Caminho inválido.")?.join(n)
            } else {
                let dest = inside(&root, Path::new(&r.destination.ok_or("Destino ausente.")?))?;
                if !dest.is_dir() { return Err("Selecione uma pasta de destino.".into()); }
                dest.join(p.file_name().ok_or("Nome inválido.")?)
            };
            if target.exists() { return Err("O destino já existe. Nada foi substituído.".into()); }
            if target.starts_with(&p) { return Err("Uma pasta não pode ser movida para dentro dela mesma.".into()); }
            // File moves use no-clobber persistence, including on Windows.
            if p.is_file() { move_file(&p, &target)?; }
            else { fs::rename(&p, &target).map_err(err)?; }
            Ok(json!(target))
        },
        "delete" => {
            inside(&root, &p)?;
            if p == root { return Err("A pasta principal não pode ser excluída.".into()); }
            let confirmed = rfd::AsyncMessageDialog::new().set_title("Confirmar exclusão")
                .set_description(format!("Excluir permanentemente {}? Todos os arquivos e subpastas serão excluídos.", p.display()))
                .set_buttons(rfd::MessageButtons::YesNo).show().await;
            if confirmed != rfd::MessageDialogResult::Yes { return Ok(json!(false)); }
            if p.is_dir() { fs::remove_dir_all(&p).map_err(err)?; } else { extension(&p)?; fs::remove_file(&p).map_err(err)?; }
            Ok(json!(true))
        },
        _ => Err("Operação desconhecida.".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> String { json!({"schemaVersion":1,"id":"test-id","product":{"name":"REPOLHO","complement":"VERDE","priceCents":289,"unit":"KG","productCode":null},"layout":{"template":"oferta-classica","paper":"A5","orientation":"portrait"},"metadata":{"createdAt":"2026-10-26T12:00:00Z","updatedAt":"2026-10-26T12:00:00Z"}}).to_string() }
    #[test] fn persistence_and_no_clobber() {
        let dir = tempfile::tempdir().unwrap(); let p = dir.path().join("repolho.skcartaz");
        write(&p,&sample(),false).unwrap(); assert!(write(&p,&sample(),false).is_err());
        let s = read(&p).unwrap(); assert_eq!(document(&s).unwrap()["product"]["priceCents"],289);
        let updated = s.replace("289", "349"); write(&p,&updated,true).unwrap();
        assert_eq!(document(&read(&p).unwrap()).unwrap()["product"]["priceCents"],349);
        let copy = dir.path().join("copia.skcartaz"); write(&copy,&updated,false).unwrap();
        assert_eq!(read(&p).unwrap(),read(&copy).unwrap());
        let folder = dir.path().join("Mercearia"); fs::create_dir(&folder).unwrap();
        let moved = folder.join("copia.skcartaz"); move_file(&copy,&moved).unwrap();
        assert!(!copy.exists()); assert!(p.exists());
        assert_eq!(document(&read(&moved).unwrap()).unwrap()["product"]["priceCents"],349);
        assert!(move_file(&p,&moved).is_err()); assert!(p.exists());
    }
    #[test] fn unsafe_paths_and_invalid_documents() {
        let dir = tempfile::tempdir().unwrap(); let root = dir.path().canonicalize().unwrap();
        assert!(inside(&root,&root.join("../escape.skcartaz")).is_err());
        for n in ["../fora","CON","COM1.txt","a:b","nome.",""] { assert!(name(n).is_err()); }
        assert!(document("<script>alert(1)</script>").is_err());
        assert!(document(&sample().replace("289","2.89")).is_err());
        assert!(document(&sample().replace("\"schemaVersion\":1","\"schemaVersion\":2")).is_err());
    }
    #[test] fn f7_round_trip_and_legacy_compatibility() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f7.skcartaz");
        let mut original = document(&sample()).unwrap();
        original["product"].as_object_mut().unwrap().remove("productCode");
        write(&path, &original.to_string(), false).unwrap();
        let mut reopened = document(&read(&path).unwrap()).unwrap();
        assert!(reopened["product"]["productCode"].is_null());
        reopened["product"]["productCode"] = json!("001245");
        write(&path, &reopened.to_string(), true).unwrap();
        let saved = document(&read(&path).unwrap()).unwrap();
        assert_eq!(saved["product"]["productCode"], "001245");
        assert_eq!(saved["id"], original["id"]);
        assert_eq!(saved["layout"], original["layout"]);
        assert_eq!(saved["product"]["priceCents"], original["product"]["priceCents"]);
        for code in [json!(""), Value::Null, json!("ABC-001"), json!("0".repeat(150))] {
            reopened["product"]["productCode"] = code.clone();
            write(&path, &reopened.to_string(), true).unwrap();
            assert_eq!(document(&read(&path).unwrap()).unwrap()["product"]["productCode"], code);
        }
        reopened["product"]["productCode"] = json!(1245);
        assert!(write(&path, &reopened.to_string(), true).is_err());
    }
    #[test] fn imported_psd_document_is_portable_and_validated() {
        let pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let mut value = document(&sample()).unwrap();
        value["product"]["productCode"] = json!("001245");
        value["layout"] = json!({"template":"imported-psd","paper":"A5","orientation":"portrait","artwork":{"kind":"imported-psd","compatibility":"ready","source":{"fileName":"repolho verde kg.psd","sha256":"a".repeat(64)},"canvas":{"width":886,"height":1240,"resolutionPpi":150,"fit":"contain"},"staticBackground":pixel,"originalPreview":pixel,"priceParts":[{"role":"whole"},{"role":"fraction"}],"layers":[],"warnings":[]}});
        let serialized = value.to_string();
        let reopened = document(&serialized).unwrap();
        assert_eq!(reopened["product"]["productCode"], "001245");
        assert_eq!(reopened["layout"]["artwork"]["source"]["fileName"], "repolho verde kg.psd");
        let mut invalid = reopened.clone(); invalid["layout"]["artwork"]["staticBackground"] = json!("C:\\temporario\\fundo.png");
        assert!(document(&invalid.to_string()).is_err());
    }
}
