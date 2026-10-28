import { useEffect, useRef, useState } from 'react';
import { PosterView, type Poster } from './components/editor/PosterView';
import { exportPng } from './components/editor/exportPng';
import { Library } from './components/library/Library';
import { useCartaz } from './hooks/useCartaz';
import { listFiles } from './features/cartazes/storage';
import type { Library as LibraryData } from './features/cartazes/types';
import { F7Field } from './components/editor/F7Field';
import { useF7Matches } from './hooks/useF7Matches';
import { posterFromDocument } from './features/cartazes/presentation';
import { PriceImport } from './components/importacao/PriceImport';
import { OfferFolders } from './components/ofertas/OfferFolders';
import { ScantechCreator } from './components/scantech/ScantechCreator';
import { hasInvertedPsdPriceParts, importedPriceWarning, repairInvertedPsdArtwork } from './components/editor/importedRenderer';
export default function App() {
  const editor = useCartaz();
  const editorGuard = { path: editor.path, dirty: editor.dirty };
  const guardRef = useRef(editorGuard);
  guardRef.current = editorGuard;
  const f7Matches = useF7Matches(editor.document.product.productCode, editor.path);
  const [section, setSection] = useState('editor');
  const [data, setData] = useState<LibraryData | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [queue, setQueue] = useState<Poster[]>([]);
  const [batchPrintPosters, setBatchPrintPosters] = useState<Poster[] | null>(null);
  const poster: Poster = { ...posterFromDocument(editor.document), price: editor.price };
  const imported=editor.document.layout.template==='imported-psd';
  const invertedLayers=poster.artwork?hasInvertedPsdPriceParts(poster.artwork):false;
  const priceWarning=poster.artwork?(invertedLayers?'As camadas de Reais e Centavos estão invertidas nesta arte PSD. Clique em "Corrigir inversão Reais/Centavos" abaixo antes de salvar ou imprimir.':importedPriceWarning(poster.artwork,poster.price)):'';
  const refresh = async () => { setData(await listFiles()); f7Matches.refresh(); };
  useEffect(() => { let active = true; listFiles().then(value => { if(active) setData(value); }).catch(ex => { if(active) setError(String(ex)); }); return () => { active = false; }; }, []);
  const handlePrintBatch = (posters: Poster[]) => {
    setBatchPrintPosters(posters);
    setTimeout(() => {
      window.print();
      setBatchPrintPosters(null);
    }, 60);
  };
  const run = (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    action().catch(ex => setError(String(ex))).finally(() => { locked.current = false; setBusy(false); });
  };
  const newDocument = async () => { if (await editor.newDocument()) setSection('editor'); };
  const open = async (path?: string) => { if (await editor.open(path)) { setSection('editor'); setMessage('Cartaz aberto.'); } };
  const save = async (as = false) => { if (await editor.save(as)) { setMessage('Cartaz salvo no computador.'); await refresh(); } };
  const validPoster = () => { const d = editor.current(); if (!d.product.name.trim()) throw new Error('Informe o nome do produto.'); return posterFromDocument(d); };
  return <div className="app">
    <header><div className="brand"><img className="brand-logo" src="/logo.png" alt="Logo oficial Skalee"/><div><strong>Skalee Cartazes</strong><small>Editor de ofertas · A5 vertical · Offline</small></div></div><span className="version">Sprint 07.2</span></header>
    <nav className="navigation" aria-label="Navegação principal"><button className={section === 'editor' ? 'active' : 'subtle'} disabled={busy} onClick={() => setSection('editor')}>Editor de Cartazes</button><button className={section === 'library' ? 'active' : 'subtle'} disabled={busy} onClick={() => { setSection('library'); run(refresh); }}>Meus Cartazes</button><button className={section === 'import' ? 'active' : 'subtle'} disabled={busy} onClick={() => setSection('import')}>Importação de Preços</button><button className={section === 'offers' ? 'active' : 'subtle'} disabled={busy} onClick={() => { setSection('offers'); run(refresh); }}>Pastas de Ofertas</button><button className={section === 'scantech' ? 'active' : 'subtle'} disabled={busy} onClick={() => { setSection('scantech'); run(refresh); }}>Criar Cartaz Scantech</button></nav>
    <div className="notifications" aria-live="polite">{busy && <p role="status">Aguarde…</p>}{message && <p className="success" role="status">{message}</p>}{error && <p className="error-text" role="alert">{error}</p>}</div>
    <fieldset className="workspace" disabled={busy} aria-busy={busy}>
    {section === 'editor' ? <><div className="document-bar"><div className="toolbar"><button className="subtle" onClick={() => run(newDocument)}>Novo cartaz</button><button className="subtle" onClick={() => run(async () => { if (await editor.openReferencePsd()) setMessage('Modelo PSD carregado. Edite os campos e salve o novo cartaz.'); })}>Novo a partir de PSD</button><button className="subtle" onClick={() => run(() => open())}>Abrir cartaz</button><button onClick={() => run(() => save())}>Salvar</button><button className="subtle" onClick={() => run(() => save(true))}>Salvar como</button><button className="subtle" onClick={() => run(async () => { if(await editor.duplicate()) setMessage('Cópia criada no editor. Salve com outro nome.'); })}>Duplicar</button></div><p className="document-path">{editor.dirty ? '● Alterações não salvas · ' : ''}{editor.path ?? 'Cartaz novo — ainda não salvo'}</p></div>
    <main><section className="panel controls"><h2>Editar oferta</h2><p>Preencha os campos para atualizar a prévia.</p>
      {imported && !poster.artwork?.isReferenceTemplate && <p className="import-warning">Arte PSD legada: somente preço e F7 são dinâmicos.</p>}
      {poster.artwork?.isReferenceTemplate && <p className="hint" style={{marginTop:0,marginBottom:14,color:'#137b52',fontWeight:600}}>Modelo PSD ativo: Categoria, Nome (Brush Hand New), Complemento, Embalagem, Preço e Validade editáveis.</p>}
      {poster.artwork?.isReferenceTemplate && <label>Categoria<input value={((editor.document.product as any).category as string) || poster.category || ''} maxLength={32} onChange={e => editor.change('category', e.target.value.toUpperCase())}/></label>}
      <label>Nome principal<input disabled={imported && !poster.artwork?.isReferenceTemplate} value={poster.name} maxLength={32} onChange={e => editor.change('name',e.target.value.toUpperCase())}/></label>
      <label>Complemento<input disabled={imported && !poster.artwork?.isReferenceTemplate} value={poster.detail} maxLength={28} onChange={e => editor.change('complement',e.target.value.toUpperCase())}/></label>
      <div className="fields"><label>Preço (R$)<input inputMode="decimal" value={poster.price} onChange={e => editor.change('price',e.target.value)}/></label><label>Unidade / Embalagem{poster.artwork?.isReferenceTemplate ? <input value={poster.unit} maxLength={12} onChange={e => editor.change('unit', e.target.value.toUpperCase())}/> : <select disabled={imported} value={poster.unit} onChange={e => editor.change('unit',e.target.value)}>{Array.from(new Set(['KG','UN','PCT','CX','LT',poster.unit])).map(unit => <option key={unit}>{unit}</option>)}</select>}</label></div>
      {poster.artwork?.isReferenceTemplate && <label>Validade da oferta<input value={((editor.document.product as any).validityText as string) || poster.validityText || ''} placeholder="Ex: 08/11/2026 ou OFERTA VÁLIDA ATÉ 25/10" onChange={e => editor.change('validityText', e.target.value)}/></label>}
      {priceWarning&&<p className="error-text" role="alert">{priceWarning}</p>}{invertedLayers&&<button type="button" className="subtle" style={{marginBottom:14,width:'100%'}} onClick={()=>editor.fixInvertedPsdLayers()}>Corrigir inversão Reais/Centavos (restaurar preço original)</button>}
      <F7Field value={editor.document.product.productCode} onChange={value => editor.change('productCode',value)} matches={f7Matches.matches} checking={f7Matches.checking} error={f7Matches.error} onRefresh={f7Matches.refresh}/>
      <div className="actions"><button disabled={Boolean(priceWarning)} onClick={() => run(async () => { validPoster(); window.print(); })}>Imprimir A5</button><button disabled={Boolean(priceWarning)} className="secondary" onClick={() => run(async () => exportPng(validPoster()))}>Exportar PNG 300 DPI</button></div>
      <button className="outline" onClick={() => run(async () => { const p = validPoster(); setQueue(items => [...items,p]); })}>+ Adicionar à lista ({queue.length})</button>
      {queue.length > 0 && <div className="queue"><h3>Lista de cartazes</h3>{queue.map((item,i) => <div key={i}><span>{item.name} {item.detail} · R$ {item.price}</span><button className="remove" aria-label={'Remover ' + item.name} onClick={() => setQueue(items => items.filter((_,j) => i !== j))}>×</button></div>)}<small>Lista temporária preparada para a futura impressão em lote.</small></div>}
      <p className="hint">Impressão: selecione papel A5, escala 100%, margens nenhuma e desative cabeçalhos/rodapés. A saída depende do driver da impressora.</p>
    </section><section className="panel preview"><div className="preview-heading"><div><h2>Pré-visualização</h2><p>148 × 210 mm · Retrato</p></div><span className="status">Documento editável local</span></div><div className="paper-wrap"><PosterView poster={poster}/></div></section></main></> : section === 'library' ? <div className="library-container">{data ? <Library data={data} open={open} newDocument={newDocument} run={run} refresh={refresh} relocated={editor.relocate} removed={editor.removed}/> : <section className="panel"><h2>Meus Cartazes</h2><p>Abra o aplicativo desktop para usar a biblioteca local.</p><button onClick={() => run(refresh)}>Tentar novamente</button></section>}</div> : null}
    <div hidden={section !== 'import'} className="library-container"><PriceImport run={run} editorGuard={editorGuard} getEditorGuard={() => guardRef.current} onFilesChanged={async paths => { await refresh(); await editor.refreshSaved(paths); }}/></div>
    <div hidden={section !== 'offers'} className="library-container"><OfferFolders libraryData={data} run={run} onPrintBatch={handlePrintBatch} onRefreshLibrary={refresh}/></div>
    <div hidden={section !== 'scantech'} className="library-container"><ScantechCreator libraryData={data} run={run} onPrintBatch={handlePrintBatch} onRefreshLibrary={refresh}/></div>
    </fieldset><div className="print-only">{batchPrintPosters && batchPrintPosters.length > 0 ? batchPrintPosters.map((p, i) => <div className="print-page" key={i}><PosterView poster={p}/></div>) : <PosterView poster={poster}/>}</div>
  </div>;
}
