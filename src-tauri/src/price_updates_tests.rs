use super::*;
use serde_json::{json, Value};

fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("library");
    fs::create_dir(&root).unwrap(); let root = root.canonicalize().unwrap();
    let history = temp.path().join("history"); (temp, root, history)
}
fn create(root: &Path, name: &str) -> PathBuf {
    let path = root.join(name);
    let mut doc = json!({"schemaVersion":1,"id":Uuid::new_v4().to_string(),"product":{"name":"REPOLHO","complement":"VERDE","priceCents":289,"unit":"KG","productCode":"001245","extra":{"preservar":[1,true,null]}},"layout":{"template":"oferta-classica","paper":"A5","orientation":"portrait","custom":"manter"},"metadata":{"createdAt":"2026-10-26T12:00:00Z","updatedAt":"2026-10-26T12:00:00Z","note":"manter"},"custom":{"root":"manter"}});
    doc["custom"]["largeNumber"] = serde_json::from_str("123456789012345678901234567890").unwrap();
    storage::write(&path, &serde_json::to_string_pretty(&doc).unwrap(), false).unwrap(); path
}
fn proposal(path: &Path, price: u64) -> Proposal {
    let source = storage::read(path).unwrap(); let doc = storage::document(&source).unwrap();
    Proposal { path: path.to_string_lossy().into_owned(), document_id: doc["id"].as_str().unwrap().into(), f7: "001245".into(), old_price_cents: doc["product"]["priceCents"].as_u64().unwrap(), new_price_cents: price, source, conflicting: false }
}
fn prepare(engine: &mut Engine, root: &Path, items: Vec<Proposal>) -> Review {
    engine.prepare(root, "consulta01.dbf".into(), items, vec![], &[], None).unwrap()
}
fn unchanged_fields(mut doc: Value) -> Value {
    doc["product"].as_object_mut().unwrap().remove("priceCents");
    doc["metadata"].as_object_mut().unwrap().remove("updatedAt"); doc
}
#[test]
fn actual_files_update_restart_and_restore_preserve_every_other_field() {
    let (_temp, root, base) = setup(); let path = create(&root, "repolho.skcartaz");
    let unrelated = create(&root, "nao-selecionado.skcartaz");
    let original = storage::read(&path).unwrap(); let untouched = storage::read(&unrelated).unwrap();
    let original_doc = storage::document(&original).unwrap();
    let mut engine = Engine::default(); let review = prepare(&mut engine, &root, vec![proposal(&path, 349)]);
    assert_eq!(storage::read(&path).unwrap(), original); assert!(!base.exists());
    assert!(engine.commit(&root, &base, &review.id, false, &[]).is_err());
    assert_eq!(storage::read(&path).unwrap(), original);
    let outcome = engine.commit(&root, &base, &review.id, true, &[]).unwrap();
    assert!(!outcome.stopped); assert_eq!(outcome.entries.len(), 1); assert_eq!(outcome.entries[0].result, "updated");
    assert_eq!(storage::read(&unrelated).unwrap(), untouched);
    let reopened = storage::document(&storage::read(&path).unwrap()).unwrap();
    assert_eq!(reopened["product"]["priceCents"],349); assert_ne!(reopened["metadata"]["updatedAt"],original_doc["metadata"]["updatedAt"]);
    assert_eq!(unchanged_fields(reopened.clone()),unchanged_fields(original_doc.clone()));
    assert_eq!(backup_source(&base,&outcome.entries[0]).unwrap(),original);
    drop(engine); // Simulate a new application process: only persisted files/history remain.
    let persisted = history(&base).unwrap(); assert_eq!(persisted.entries.len(),1); assert!(persisted.entries[0].backup_available);
    assert_eq!(storage::document(&storage::read(&path).unwrap()).unwrap()["product"]["priceCents"],349);
    let mut restarted = Engine::default();
    let restore = restarted.prepare_restore(&root,&base,&persisted.entries[0].id,&[]).unwrap();
    assert_eq!(restore.changes[0].old_price_cents,349); assert_eq!(restore.changes[0].new_price_cents,289);
    assert!(restarted.commit(&root,&base,&restore.id,false,&[]).is_err());
    let result = restarted.commit(&root,&base,&restore.id,true,&[]).unwrap(); assert_eq!(result.entries[0].result,"restored");
    let restored = storage::document(&storage::read(&path).unwrap()).unwrap();
    assert_eq!(restored["product"]["priceCents"],289); assert_eq!(unchanged_fields(restored),unchanged_fields(original_doc));
    assert_eq!(history(&base).unwrap().entries.len(),2);
}
#[test]
fn blocks_conflicts_equal_prices_dirty_editor_wrong_identity_and_duplicate_paths() {
    let (_temp,root,base)=setup(); let path=create(&root,"a.skcartaz"); let original=storage::read(&path).unwrap();
    let mut engine=Engine::default();
    let mut p=proposal(&path,349); p.conflicting=true;
    assert!(engine.prepare(&root,"teste.dbf".into(),vec![p],vec![],&[],None).is_err());
    assert!(engine.prepare(&root,"teste.dbf".into(),vec![proposal(&path,349)],vec!["001245".into()],&[],None).is_err());
    assert!(engine.prepare(&root,"teste.dbf".into(),vec![proposal(&path,289)],vec![],&[],None).is_err());
    assert!(engine.prepare(&root,"teste.dbf".into(),vec![proposal(&path,349),proposal(&path,349)],vec![],&[],None).is_err());
    let dirty=vec![path.to_string_lossy().into_owned()];
    assert!(engine.prepare(&root,"teste.dbf".into(),vec![proposal(&path,349)],vec![],&dirty,None).is_err());
    let review=prepare(&mut engine,&root,vec![proposal(&path,349)]);
    assert!(engine.commit(&root,&base,&review.id,true,&dirty).is_err());
    for wrong in ["id","f7"] {
        let mut p=proposal(&path,349); if wrong=="id" {p.document_id="outro".into();} else {p.f7="1245".into();}
        assert!(engine.prepare(&root,"teste.dbf".into(),vec![p],vec![],&[],None).is_err());
    }
    assert_eq!(storage::read(&path).unwrap(),original); assert!(!base.exists());
}
#[test]
fn external_change_after_review_stops_batch_and_records_unattempted_files() {
    let (_temp,root,base)=setup(); let first=create(&root,"a.skcartaz"); let second=create(&root,"b.skcartaz");
    let mut engine=Engine::default(); let review=prepare(&mut engine,&root,vec![proposal(&first,349),proposal(&second,499)]);
    let mut changed=storage::document(&storage::read(&first).unwrap()).unwrap(); changed["product"]["priceCents"]=json!(777);
    storage::write(&first,&changed.to_string(),true).unwrap();
    let result=engine.commit(&root,&base,&review.id,true,&[]).unwrap(); assert!(result.stopped);
    assert_eq!(result.entries[0].result,"failed"); assert_eq!(result.entries[1].result,"skipped");
    assert_eq!(storage::document(&storage::read(&first).unwrap()).unwrap()["product"]["priceCents"],777);
    assert_eq!(storage::document(&storage::read(&second).unwrap()).unwrap()["product"]["priceCents"],289);
    assert_eq!(history(&base).unwrap().entries.len(),2);
    assert!(engine.commit(&root,&base,&review.id,true,&[]).is_err());
}
#[test]
fn any_document_change_since_comparison_is_rejected_before_preparation() {
    let (_temp,root,_base)=setup(); let path=create(&root,"a.skcartaz"); let p=proposal(&path,349);
    let mut changed=storage::document(&p.source).unwrap(); changed["product"]["complement"]=json!("NOVA EDIÇÃO");
    storage::write(&path,&changed.to_string(),true).unwrap();
    assert!(Engine::default().prepare(&root,"teste.dbf".into(),vec![p],vec![],&[],None).is_err());
}
#[test]
fn journal_write_failure_preserves_original_and_reports_failure() {
    let (_temp,root,base)=setup(); let path=create(&root,"a.skcartaz"); let original=storage::read(&path).unwrap();
    fs::write(&base,b"arquivo bloqueando pasta do historico").unwrap();
    let mut engine=Engine::default(); let review=prepare(&mut engine,&root,vec![proposal(&path,349)]);
    let result=engine.commit(&root,&base,&review.id,true,&[]).unwrap();
    assert!(result.stopped); assert_eq!(result.entries[0].result,"failed"); assert!(!result.errors.is_empty());
    assert_eq!(storage::read(&path).unwrap(),original);
}
#[cfg(windows)]
#[test]
fn actual_windows_write_failure_keeps_original_and_valid_backup() {
    let (_temp,root,base)=setup(); let path=create(&root,"a.skcartaz"); let original=storage::read(&path).unwrap();
    let mut engine=Engine::default(); let review=prepare(&mut engine,&root,vec![proposal(&path,349)]);
    let mut permissions=fs::metadata(&path).unwrap().permissions(); permissions.set_readonly(true); fs::set_permissions(&path,permissions).unwrap();
    let result=engine.commit(&root,&base,&review.id,true,&[]).unwrap();
    let mut permissions=fs::metadata(&path).unwrap().permissions(); permissions.set_readonly(false); fs::set_permissions(&path,permissions).unwrap();
    assert!(result.stopped); assert_eq!(result.entries[0].result,"failed"); assert!(result.entries[0].backup_available);
    assert_eq!(storage::read(&path).unwrap(),original); assert_eq!(backup_source(&base,&result.entries[0]).unwrap(),original);
}
#[test]
fn corrupted_backup_and_later_edits_block_restoration() {
    let (_temp,root,base)=setup(); let path=create(&root,"a.skcartaz"); let mut engine=Engine::default();
    let review=prepare(&mut engine,&root,vec![proposal(&path,349)]); let result=engine.commit(&root,&base,&review.id,true,&[]).unwrap();
    let entry=&result.entries[0];
    let updated=storage::read(&path).unwrap();
    storage::write(&path,&updated.replace("349","459"),true).unwrap();
    assert!(Engine::default().prepare_restore(&root,&base,&entry.id,&[]).is_err());
    storage::write(&path,&updated,true).unwrap();
    fs::write(&entry.backup_path,b"backup corrompido").unwrap();
    assert!(Engine::default().prepare_restore(&root,&base,&entry.id,&[]).is_err());
    assert!(!history(&base).unwrap().entries[0].backup_available);
    assert_eq!(storage::read(&path).unwrap(),updated);
}
#[test]
fn durable_prepared_journal_recovers_after_interrupted_result_recording() {
    let (_temp,root,base)=setup(); let path=create(&root,"a.skcartaz"); let mut engine=Engine::default();
    let review=prepare(&mut engine,&root,vec![proposal(&path,349)]); let result=engine.commit(&root,&base,&review.id,true,&[]).unwrap();
    let mut entry=result.entries[0].clone(); entry.result="prepared".into();
    atomic_record(&base.join(&entry.id).join("record.json"),&entry).unwrap();
    let persisted=history(&base).unwrap(); assert!(persisted.entries[0].message.contains("interrompida"));
    let mut restarted=Engine::default(); let restore=restarted.prepare_restore(&root,&base,&entry.id,&[]).unwrap();
    assert_eq!(restarted.commit(&root,&base,&restore.id,true,&[]).unwrap().entries[0].result,"restored");
}
#[test]
fn same_uuid_in_different_paths_is_selected_and_updated_individually() {
    let (_temp,root,base)=setup(); let first=create(&root,"a.skcartaz"); let second=root.join("b.skcartaz");
    let original=storage::read(&first).unwrap(); storage::write(&second,&original,false).unwrap();
    let mut engine=Engine::default(); let review=prepare(&mut engine,&root,vec![proposal(&first,349)]);
    engine.commit(&root,&base,&review.id,true,&[]).unwrap();
    assert_eq!(storage::read(&second).unwrap(),original); assert_eq!(history(&base).unwrap().entries.len(),1);
}
