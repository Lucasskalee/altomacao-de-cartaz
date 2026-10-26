import { useMemo, useState } from 'react';
import type { Entry, Library as LibraryData } from '../../features/cartazes/types';
import { duplicate } from '../../features/cartazes/serialization';
import * as storage from '../../features/cartazes/storage';
import { PosterView } from '../editor/PosterView';
import { getF7, indexCartazes, matchesCartazSearch, withoutF7 } from '../../features/cartazes/f7';
import { posterFromDocument } from '../../features/cartazes/presentation';
type Props = { data: LibraryData; open: (path: string) => Promise<void>; newDocument: () => Promise<void>; run: (action: () => Promise<void>) => void; refresh: () => Promise<void>; relocated: (old: string, next: string) => void; removed: (path: string) => void };
export function Library({ data, open, newDocument, run, refresh, relocated, removed }: Props) {
  const [folder, setFolder] = useState(data.root);
  const [query, setQuery] = useState('');
  const [onlyWithoutF7, setOnlyWithoutF7] = useState(false);
  const indexed = useMemo(() => indexCartazes(data.entries), [data.entries]);
  const byPath = useMemo(() => new Map(indexed.map(item => [item.path, item])), [indexed]);
  const uncodedPaths = useMemo(() => new Set(withoutF7(indexed).map(item => item.path)), [indexed]);
  const globalSearch = Boolean(query.trim() || onlyWithoutF7);
  const [sort, setSort] = useState('date');
  const [view, setView] = useState('grid');
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Entry | null>(null);
  const [renameName, setRenameName] = useState('');
  const folders = data.entries.filter(e => e.folder).sort((a,b) => a.path.localeCompare(b.path,'pt-BR'));
  const active = folder === data.root || folders.some(e => e.path === folder) ? folder : data.root;
  const rows = data.entries.filter(e => !e.folder && (globalSearch || storage.parent(e.path) === active)).filter(e => {
    if (onlyWithoutF7 && !uncodedPaths.has(e.path)) return false;
    const item = byPath.get(e.path);
    return item ? matchesCartazSearch(item, query) : e.name.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'));
  }).sort((a,b) => sort === 'date' ? (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) : label(a).localeCompare(label(b),'pt-BR'));
  function label(e: Entry) { return byPath.get(e.path)?.document.product.name ?? e.name; }
  const renameEntry = async () => {
    if (!editing) return;
    const next = await storage.rename(editing.path, renameName); relocated(editing.path,next); setEditing(null); await refresh();
  };
  const deleteEntry = async (e: Entry) => { if (await storage.remove(e.path)) { removed(e.path); await refresh(); } };
  const renameButton = (e: Entry) => <button className="subtle" onClick={() => { setEditing(e); setRenameName(e.name); }}>Renomear</button>;
  return <section className="library panel">
    <div className="library-heading"><div><h2>Meus Cartazes</h2><p>Biblioteca no computador · Funciona offline</p></div><button onClick={() => run(newDocument)}>Novo Cartaz</button></div>
    <p className="library-path">{data.root}</p>
    <div className="library-layout"><aside aria-label="Pastas da biblioteca">
      <button className={active === data.root ? 'folder selected' : 'folder'} onClick={() => setFolder(data.root)}>▣ Todos na pasta principal</button>
      {folders.map(e => <div key={e.path} style={{ paddingLeft: Math.min(5, e.path.slice(data.root.length).split(/[\\/]/).length - 2) * 12 }}><button className={active === e.path ? 'folder selected' : 'folder'} onClick={() => setFolder(e.path)}>▸ {e.name}</button>{active === e.path && <div className="folder-actions">{renameButton(e)}<button className="subtle danger" onClick={() => run(() => deleteEntry(e))}>Excluir pasta</button></div>}</div>)}
      <form onSubmit={e => { e.preventDefault(); run(async () => { await storage.createFolder(active,newName); setNewName(''); await refresh(); }); }}><label>Nova pasta em {active === data.root ? 'Skalee Cartazes' : active.split(/[\\/]/).pop()}<input aria-label="Nome da nova pasta" value={newName} onChange={e => setNewName(e.target.value)} required maxLength={100}/></label><button type="submit">Nova Pasta</button></form>
    </aside><div><div className="library-toolbar"><input aria-label="Pesquisar por nome ou F7 em todas as pastas" placeholder="Pesquisar por nome ou F7…" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="Ordenar" value={sort} onChange={e => setSort(e.target.value)}><option value="date">Mais recentes</option><option value="name">Nome do produto</option></select><select aria-label="Visualização" value={view} onChange={e => setView(e.target.value)}><option value="grid">Grade</option><option value="list">Lista</option></select><button className="subtle" onClick={() => run(refresh)}>Atualizar</button></div>
      <label className="f7-filter"><input type="checkbox" checked={onlyWithoutF7} onChange={e => setOnlyWithoutF7(e.target.checked)}/> Somente cartazes sem F7 (todas as pastas)</label>
      <p className="library-path">{globalSearch ? 'Resultados em toda a biblioteca' : active} · {rows.length} cartaz(es)</p>
      {rows.length === 0 && <p className="empty">Nenhum cartaz aqui. Crie uma oferta no editor e salve nesta pasta.</p>}
      <div className={'cards ' + view}>{rows.map(e => {
        const d = byPath.get(e.path)?.document;
        const error = e.error || (!d ? 'Documento inválido ou incompatível.' : undefined);
        const f7 = getF7(d?.product.productCode);
        return <article className="cartaz-card" key={e.path}>
          {d && <button className="thumbnail" aria-label={'Abrir ' + d.product.name} onClick={() => run(() => open(e.path))}><PosterView poster={posterFromDocument(d)}/></button>}
          <div className="card-info"><strong>{d?.product.name ?? e.name}</strong><div>{d?.product.complement}</div>{d && <p>R$ {(d.product.priceCents/100).toFixed(2).replace('.',',')} / {d.product.unit}</p>}<small>{e.modifiedAt ? new Date(e.modifiedAt).toLocaleString('pt-BR') : ''}</small><small title={e.path}>{e.name}</small>{error && <p className="error-text">{error}</p>}
          {d && <small className={f7 ? 'f7-code' : 'f7-missing'}>{f7 ? `F7: ${f7}` : 'Sem F7'}</small>}
          {d?.product.productCode && !f7 && <small>Código antigo: {d.product.productCode}</small>}
          <details><summary>Ações do arquivo</summary><div className="file-actions"><button onClick={() => run(() => open(e.path))}>Abrir</button>{renameButton(e)}<button className="subtle" onClick={() => run(async () => { const dest = await storage.chooseFolder(); if (dest) { const next = await storage.move(e.path,dest); relocated(e.path,next); await refresh(); } })}>Mover para…</button>{d && <button className="subtle" onClick={() => run(async () => { const doc = duplicate(await storage.openDocument(e.path)); const dest = await storage.chooseSave('copia-' + e.name); if (dest) { await storage.saveDocument(dest,doc); await refresh(); } })}>Duplicar…</button>}<button className="subtle danger" onClick={() => run(() => deleteEntry(e))}>Excluir</button></div></details></div>
        </article>;
      })}</div></div></div>
    {editing && <div className="modal-backdrop"><form className="panel modal" role="dialog" aria-modal="true" aria-label="Renomear" onSubmit={e => { e.preventDefault(); run(renameEntry); }}><h2>Renomear {editing.folder ? 'pasta' : 'cartaz'}</h2><label>Novo nome<input autoFocus required value={renameName} onChange={e => setRenameName(e.target.value)}/></label><div className="toolbar"><button type="submit">Renomear</button><button type="button" className="subtle" onClick={() => setEditing(null)}>Cancelar</button></div></form></div>}
  </section>;
}
