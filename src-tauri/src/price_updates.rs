use crate::storage;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs, io::Write, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use tauri::Manager;
use uuid::Uuid;

fn now() -> String { Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) }
fn hash(source: &str) -> String { format!("{:x}", Sha256::digest(source.as_bytes())) }
fn error(e: impl std::fmt::Display) -> String { e.to_string() }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    path: String, document_id: String, f7: String,
    old_price_cents: u64, new_price_cents: u64, source: String,
    conflicting: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String, document_id: String, f7: String, name: String,
    old_price_cents: u64, new_price_cents: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    id: String, action: String, dbf_name: String, changes: Vec<Change>, ignored_conflicts: usize,
}
struct Plan { review: Review, proposals: Vec<Proposal>, created: i64, restores_id: Option<String> }
#[derive(Default)]
pub struct Engine { plans: HashMap<String, Plan> }
#[derive(Default)]
pub struct PriceUpdates(Arc<Mutex<Engine>>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    id: String, timestamp: String, action: String, dbf_name: String,
    f7: String, path: String, document_id: String, name: String,
    old_price_cents: u64, new_price_cents: u64,
    result: String, message: String, backup_available: bool, backup_path: String,
    before_hash: String, after_hash: String, restores_id: Option<String>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History { entries: Vec<HistoryEntry>, errors: Vec<String> }
#[derive(Serialize)]
pub struct Outcome { entries: Vec<HistoryEntry>, stopped: bool, errors: Vec<String> }

fn atomic_record(path: &Path, entry: &HistoryEntry) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(entry).map_err(error)?;
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Histórico sem pasta.")?).map_err(error)?;
    tmp.write_all(&bytes).map_err(error)?; tmp.as_file().sync_all().map_err(error)?;
    tmp.persist(path).map_err(error)?; Ok(())
}
fn history_dir(base: &Path, id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(id).map_err(|_| "Identificador de histórico inválido.")?;
    let path = base.join(id);
    if path.exists() { storage::inside(&base.canonicalize().map_err(error)?, &path) } else { Ok(path) }
}
fn read_entry(base: &Path, id: &str) -> Result<HistoryEntry, String> {
    let directory = history_dir(base, id)?;
    let record = storage::inside(&directory.canonicalize().map_err(error)?, &directory.join("record.json"))?;
    if fs::metadata(&record).map_err(error)?.len() > 2_097_152 { return Err("Registro de histórico muito grande.".into()); }
    let entry: HistoryEntry = serde_json::from_str(&fs::read_to_string(record).map_err(error)?).map_err(error)?;
    if entry.id != id { return Err("Identidade do histórico divergente.".into()); } Ok(entry)
}
fn backup_source(base: &Path, entry: &HistoryEntry) -> Result<String, String> {
    let directory = history_dir(base, &entry.id)?.canonicalize().map_err(error)?;
    let backup = storage::inside(&directory, &directory.join("before.skcartaz.bak"))?;
    if fs::metadata(&backup).map_err(error)?.len() > 1_048_576 { return Err("Backup muito grande.".into()); }
    let source = fs::read_to_string(backup).map_err(error)?;
    storage::document(&source)?;
    if hash(&source) != entry.before_hash { return Err("O backup foi alterado ou está corrompido.".into()); } Ok(source)
}
pub fn history(base: &Path) -> Result<History, String> {
    let mut result = History::default();
    if !base.exists() { return Ok(result); }
    for item in fs::read_dir(base).map_err(error)? {
        let item = match item { Ok(item) => item, Err(e) => { result.errors.push(e.to_string()); continue; } };
        let id = item.file_name().to_string_lossy().into_owned();
        if Uuid::parse_str(&id).is_err() { continue; }
        match read_entry(base, &id) {
            Ok(mut entry) => {
                match backup_source(base, &entry) {
                    Ok(_) => entry.backup_available = true,
                    Err(e) => {
                        if entry.backup_available { result.errors.push(format!("Backup indisponível de {}: {e}", entry.path)); }
                        entry.backup_available = false;
                    }
                }
                if entry.result == "prepared" {
                    entry.message = "Operação interrompida. Confira o arquivo e use o backup para recuperar; nenhum reenvio é automático.".into();
                }
                result.entries.push(entry);
            },
            Err(e) => result.errors.push(format!("Histórico {id}: {e}")),
        }
    }
    result.entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp)); Ok(result)
}
fn blocked(path: &Path, paths: &[String]) -> bool {
    paths.iter().any(|p| Path::new(p).canonicalize().map(|p| p == path).unwrap_or(false))
}
fn validate_proposal(root: &Path, proposal: &Proposal, dirty_paths: &[String]) -> Result<(PathBuf, String), String> {
    let path = storage::inside(root, Path::new(&proposal.path))?;
    if blocked(&path, dirty_paths) { return Err("Cartaz aberto com alterações não salvas. Salve ou resolva a edição primeiro.".into()); }
    if proposal.conflicting || proposal.f7.is_empty() || !proposal.f7.bytes().all(|b| b.is_ascii_digit()) { return Err("F7 inválido ou conflitante no DBF.".into()); }
    if proposal.old_price_cents == proposal.new_price_cents || proposal.new_price_cents > 99_999_999 { return Err("Não há alteração válida de preço neste cartaz.".into()); }
    let source = storage::read(&path)?;
    if source != proposal.source { return Err("O arquivo mudou desde a comparação. Compare novamente antes de salvar.".into()); }
    let doc = storage::document(&source)?;
    if doc["id"].as_str() != Some(proposal.document_id.as_str()) || doc["product"]["productCode"].as_str() != Some(proposal.f7.as_str()) || doc["product"]["priceCents"].as_u64() != Some(proposal.old_price_cents) {
        return Err("UUID, F7 ou preço anterior do cartaz não corresponde à comparação.".into());
    }
    for key in ["createdAt", "updatedAt"] {
        DateTime::parse_from_rfc3339(doc["metadata"][key].as_str().ok_or("Data inválida no cartaz.")?).map_err(|_| "Data inválida no cartaz.")?;
    }
    Ok((path, doc["product"]["name"].as_str().unwrap_or("").to_string()))
}
impl Engine {
    fn prepare(&mut self, root: &Path, dbf_name: String, proposals: Vec<Proposal>, conflict_codes: Vec<String>, dirty_paths: &[String], restores_id: Option<String>) -> Result<Review, String> {
        if proposals.is_empty() || proposals.len() > 500 || proposals.iter().map(|p| p.source.len()).sum::<usize>() > 16 * 1024 * 1024 { return Err("Selecione de 1 a 500 cartazes, com até 16 MB de documentos por lote.".into()); }
        let mut seen = HashSet::new(); let mut changes = Vec::new(); let mut normalized = Vec::new();
        let conflicts: HashSet<String> = conflict_codes.into_iter().collect();
        for mut proposal in proposals {
            if conflicts.contains(&proposal.f7) { return Err("O lote contém um F7 conflitante. Ele não pode ser atualizado.".into()); }
            let (path, name) = validate_proposal(root, &proposal, dirty_paths)?;
            if !seen.insert(path.clone()) { return Err("Um mesmo arquivo foi selecionado mais de uma vez.".into()); }
            proposal.path = path.to_string_lossy().into_owned();
            changes.push(Change { path: proposal.path.clone(), document_id: proposal.document_id.clone(), f7: proposal.f7.clone(), name, old_price_cents: proposal.old_price_cents, new_price_cents: proposal.new_price_cents });
            normalized.push(proposal);
        }
        self.plans.retain(|_, plan| Utc::now().timestamp() - plan.created < 600);
        if self.plans.len() >= 20 { return Err("Muitas revisões pendentes. Aguarde dez minutos e prepare novamente.".into()); }
        let review = Review { id: Uuid::new_v4().to_string(), action: if restores_id.is_some() { "restore" } else { "update" }.into(), dbf_name: Path::new(&dbf_name).file_name().unwrap_or_default().to_string_lossy().chars().take(255).collect(), changes, ignored_conflicts: conflicts.len() };
        self.plans.insert(review.id.clone(), Plan { review: review.clone(), proposals: normalized, created: Utc::now().timestamp(), restores_id }); Ok(review)
    }
    fn prepare_restore(&mut self, root: &Path, base: &Path, id: &str, dirty_paths: &[String]) -> Result<Review, String> {
        let entry = read_entry(base, id)?;
        if entry.action != "update" || !["updated", "prepared", "recovery-required"].contains(&entry.result.as_str()) { return Err("Este registro não possui atualização recuperável.".into()); }
        let backup = storage::document(&backup_source(base, &entry)?)?;
        let path = storage::inside(root, Path::new(&entry.path))?;
        let source = storage::read(&path)?;
        if hash(&source) != entry.after_hash { return Err("O cartaz foi alterado após a atualização. Restauração automática bloqueada; preserve a edição atual e confira o backup.".into()); }
        if backup["id"].as_str() != Some(entry.document_id.as_str()) || backup["product"]["productCode"].as_str() != Some(entry.f7.as_str()) || backup["product"]["priceCents"].as_u64() != Some(entry.old_price_cents) { return Err("Backup incompatível com o histórico.".into()); }
        let proposal = Proposal { path: entry.path, document_id: entry.document_id, f7: entry.f7, old_price_cents: entry.new_price_cents, new_price_cents: entry.old_price_cents, source, conflicting: false };
        self.prepare(root, entry.dbf_name, vec![proposal], vec![], dirty_paths, Some(id.to_string()))
    }
    fn commit(&mut self, root: &Path, base: &Path, plan_id: &str, confirmed: bool, dirty_paths: &[String]) -> Result<Outcome, String> {
        if !confirmed { return Err("Confirmação explícita obrigatória. Nenhum arquivo foi alterado.".into()); }
        let plan = self.plans.remove(plan_id).ok_or("Revisão inexistente ou já utilizada. Compare novamente.")?;
        if Utc::now().timestamp() - plan.created >= 600 { return Err("A revisão expirou. Compare novamente.".into()); }
        // A dirty editor invalidates the entire plan before the first mutation.
        for p in &plan.proposals { if blocked(Path::new(&p.path), dirty_paths) { return Err("Cartaz aberto com alterações não salvas. Nenhum preço foi aplicado.".into()); } }
        let mut outcome = Outcome { entries: Vec::new(), stopped: false, errors: Vec::new() };
        for (proposal, change) in plan.proposals.iter().zip(&plan.review.changes) {
            let mut entry = HistoryEntry { id: Uuid::new_v4().to_string(), timestamp: now(), action: plan.review.action.clone(), dbf_name: plan.review.dbf_name.clone(), f7: change.f7.clone(), path: change.path.clone(), document_id: change.document_id.clone(), name: change.name.clone(), old_price_cents: change.old_price_cents, new_price_cents: change.new_price_cents, result: "prepared".into(), message: String::new(), backup_available: false, backup_path: String::new(), before_hash: hash(&proposal.source), after_hash: String::new(), restores_id: plan.restores_id.clone() };
            let directory = base.join(&entry.id);
            let operation = (|| -> Result<(), String> {
                if outcome.stopped { entry.result = "skipped".into(); entry.message = "Não executado: lote interrompido após uma falha.".into(); return Ok(()); }
                let (path, _) = validate_proposal(root, proposal, dirty_paths)?;
                let mut doc = storage::document(&proposal.source)?;
                doc["product"]["priceCents"] = proposal.new_price_cents.into(); doc["metadata"]["updatedAt"] = now().into();
                let after = serde_json::to_string_pretty(&doc).map_err(error)?;
                storage::document(&after)?; entry.after_hash = hash(&after);
                fs::create_dir_all(&directory).map_err(error)?;
                // Validate the newly created history directory before writing through it.
                let _ = storage::inside(&base.canonicalize().map_err(error)?, &directory)?;
                let backup = directory.join("before.skcartaz.bak");
                let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&backup).map_err(error)?;
                file.write_all(proposal.source.as_bytes()).map_err(error)?; file.sync_all().map_err(error)?;
                entry.backup_available = true; entry.backup_path = backup.to_string_lossy().into_owned();
                if fs::read_to_string(&backup).map_err(error)? != proposal.source { return Err("Falha na verificação do backup; original preservado.".into()); }
                atomic_record(&directory.join("record.json"), &entry)?;
                // Revalidate immediately before the atomic replacement, after the backup/journal.
                validate_proposal(root, proposal, dirty_paths)?;
                storage::write(&path, &after, true)?;
                entry.result = "recovery-required".into();
                let reopened = storage::read(&path)?;
                if reopened != after || storage::document(&reopened)? != doc { return Err("Verificação após gravar falhou. Backup preservado; confira e restaure pelo histórico.".into()); }
                entry.result = if plan.review.action == "restore" { "restored" } else { "updated" }.into();
                entry.message = "Preço salvo e arquivo reaberto/validado. Backup preservado.".into(); Ok(())
            })();
            if let Err(e) = operation {
                if entry.result != "recovery-required" { entry.result = "failed".into(); }
                entry.message = e; outcome.stopped = true;
            }
            if let Err(e) = fs::create_dir_all(&directory).map_err(error).and_then(|_| atomic_record(&directory.join("record.json"), &entry)) {
                outcome.errors.push(format!("Não foi possível persistir o histórico de {}: {e}. Backup: {}", entry.path, entry.backup_path)); outcome.stopped = true;
            }
            outcome.entries.push(entry);
        }
        Ok(outcome)
    }
}
fn locations(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let root = app.path().document_dir().map_err(error)?.join("Skalee Cartazes").canonicalize().map_err(error)?;
    let base = app.path().app_local_data_dir().map_err(error)?.join("price-updates"); Ok((root, base))
}
#[tauri::command]
pub async fn prepare_price_updates(app: tauri::AppHandle, state: tauri::State<'_, PriceUpdates>, dbf_name: String, proposals: Vec<Proposal>, conflict_codes: Vec<String>, dirty_paths: Vec<String>) -> Result<Review, String> {
    let (root, _) = locations(&app)?; let engine = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || { let mut engine = engine.lock().map_err(error)?; engine.prepare(&root, dbf_name, proposals, conflict_codes, &dirty_paths, None) }).await.map_err(error)?
}
#[tauri::command]
pub async fn prepare_price_restore(app: tauri::AppHandle, state: tauri::State<'_, PriceUpdates>, entry_id: String, dirty_paths: Vec<String>) -> Result<Review, String> {
    let (root, base) = locations(&app)?; let engine = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || { let mut engine = engine.lock().map_err(error)?; engine.prepare_restore(&root, &base, &entry_id, &dirty_paths) }).await.map_err(error)?
}
#[tauri::command]
pub async fn commit_price_updates(app: tauri::AppHandle, state: tauri::State<'_, PriceUpdates>, plan_id: String, confirmed: bool, dirty_paths: Vec<String>) -> Result<Outcome, String> {
    let (root, base) = locations(&app)?; let engine = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || { let mut engine = engine.lock().map_err(error)?; engine.commit(&root, &base, &plan_id, confirmed, &dirty_paths) }).await.map_err(error)?
}
#[tauri::command]
pub async fn list_price_history(app: tauri::AppHandle) -> Result<History, String> {
    let base = app.path().app_local_data_dir().map_err(error)?.join("price-updates");
    tauri::async_runtime::spawn_blocking(move || history(&base)).await.map_err(error)?
}
#[tauri::command]
pub fn discard_price_plan(state: tauri::State<'_, PriceUpdates>, plan_id: String) -> Result<(), String> {
    state.0.lock().map_err(error)?.plans.remove(&plan_id); Ok(())
}
#[cfg(test)]
#[path = "price_updates_tests.rs"]
mod tests;
