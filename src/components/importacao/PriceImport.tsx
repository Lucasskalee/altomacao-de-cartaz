import { useEffect, useMemo, useRef, useState } from 'react';
import { comparePrices } from '../../features/importacao/comparison';
import { compareWithLibrary, parseInWorker, selectDbf } from '../../features/importacao/service';
import type { DbfData, DbfEncoding, PriceComparison } from '../../features/importacao/types';
import { canSelect, changedPaths, commitUpdates, discardPlan, isBlockedInEditor, listHistory, prepareRestore, prepareUpdates, selectedProposals, selectionKey, type EditorGuard, type HistoryData, type Review, type UpdateOutcome } from '../../features/importacao/updates';
import { PriceConfirmation } from './PriceConfirmation';
import { PriceHistory } from './PriceHistory';

const money = (cents: number | null) => cents === null ? '—' : `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
type Props = { run: (action: () => Promise<void>) => void; editorGuard: EditorGuard; getEditorGuard: () => EditorGuard; onFilesChanged: (paths: string[]) => Promise<void> };
export function PriceImport({ run, editorGuard, getEditorGuard, onFilesChanged }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<Review | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);
  const [name, setName] = useState('');
  const [encoding, setEncoding] = useState<DbfEncoding>('auto');
  const [data, setData] = useState<DbfData | null>(null);
  const [rows, setRows] = useState<PriceComparison[]>([]);
  const [compared, setCompared] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [invalidCartazes, setInvalidCartazes] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('Todas');
  const [page, setPage] = useState(0);
  const buffer = useRef<ArrayBuffer | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const refreshHistory = async () => {
    try { setHistory(await listHistory()); setHistoryError(''); }
    catch (error) { setHistoryError(`Não foi possível ler o histórico local: ${String(error)}`); }
  };
  useEffect(() => {
    let active = true;
    listHistory().then(value => { if (active) setHistory(value); }).catch(error => { if (active) setHistoryError(String(error)); });
    return () => { active = false; };
  }, []);

  const compare = async (loaded: DbfData) => {
    setSelected(new Set());
    setLibraryError(''); setCompared(false); setInvalidCartazes(0);
    try {
      const result = await compareWithLibrary(loaded);
      setRows(result.rows); setInvalidCartazes(result.invalidCartazes); setCompared(true);
    } catch (error) {
      setRows(comparePrices(loaded.products, [])); setLibraryError(String(error));
    }
  };
  const parse = async (bytes: ArrayBuffer, selected: DbfEncoding) => {
    controller.current?.abort();
    const pending = new AbortController(); controller.current = pending;
    setData(null); setRows([]); setCompared(false); setLibraryError(''); setPage(0); setStatus('Todas');
    const loaded = await parseInWorker(bytes, selected, pending.signal);
    setData(loaded); await compare(loaded);
  };
  const importFile = async () => {
    const file = await selectDbf(); if (!file) return;
    buffer.current = file.buffer; setName(file.name);
    await parse(file.buffer, encoding);
  };
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('pt-BR');
    return rows.filter(row => (!term || `${row.product.codeRaw} ${row.product.description}`.toLocaleLowerCase('pt-BR').includes(term)) && (status === 'Todas' || (compared && row.status === status)));
  }, [rows, query, status, compared]);
  const pages = Math.max(1, Math.ceil(filtered.length / 100));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * 100, (current + 1) * 100);
  const conflictCount = useMemo(() => new Set(rows.filter(row => row.conflicting).map(row => row.product.f7)).size, [rows]);
  const eligible = rows.filter(row => compared && canSelect(row, editorGuard));
  const prepare = async () => {
    const proposals = selectedProposals(rows, selected, getEditorGuard());
    const conflicts = [...new Set(rows.filter(row => row.conflicting && row.product.f7).map(row => row.product.f7!))];
    setReview(await prepareUpdates(name, proposals, conflicts, getEditorGuard()));
  };
  const apply = async () => {
    if (!review) return;
    setSaving(true);
    try {
      const result = await commitUpdates(review.id, getEditorGuard());
      setOutcome(result); setSelected(new Set());
      let refreshError = '';
      try { await onFilesChanged(changedPaths(result)); }
      catch (error) { refreshError = String(error); }
      if (data) await compare(data);
      await refreshHistory();
      if (refreshError) throw new Error(`O resultado da gravação está abaixo, mas não foi possível atualizar a biblioteca/prévia: ${refreshError}. Reabra o cartaz para conferir.`);
    } finally { setSaving(false); setReview(null); }
  };
  return <section className="panel price-import">
    <div className="library-heading"><div><h2>Importação de Preços</h2><p>Compare, selecione e confirme. Os preços só serão gravados após sua autorização.</p></div><button onClick={() => run(importFile)}>Importar DBF</button></div>
    <div className="import-options"><label>Codificação do DBF<select value={encoding} onChange={event => { const selected = event.target.value as DbfEncoding; setEncoding(selected); if (buffer.current) run(() => parse(buffer.current!, selected)); }}>
      <option value="auto">Automática (DOS CP850 se indefinida)</option><option value="cp850">DOS CP850</option><option value="cp860">DOS português CP860</option><option value="cp437">DOS CP437</option><option value="windows-1252">Windows-1252</option><option value="utf-8">UTF-8</option>
    </select></label><div><strong>Arquivo: {name || 'Nenhum arquivo selecionado'}</strong>{data && <small>Codificação usada: {data.encoding} · Cabeçalho LDID: {data.languageDriver}</small>}</div></div>
    {!name && <p className="empty">Selecione o consulta01.dbf ou outra tabela dBASE III com CODPROD, DESCRICAO, PRVENDA, PRVENDA02 e CODBAR.</p>}
    {data && <>
      <div className="import-stats" aria-live="polite"><span><strong>{data.recordsRead.toLocaleString('pt-BR')}</strong> registros lidos</span><span><strong>{data.productsIdentified.toLocaleString('pt-BR')}</strong> produtos identificados por F7</span><span><strong>{data.deleted}</strong> excluídos ignorados</span><span><strong>{data.invalidRecords}</strong> registros com problemas</span><span><strong>{conflictCount}</strong> F7 com conflitos</span></div>
      <div className="import-warnings">{data.warnings.map(warning => <p key={warning}>{warning}</p>)}{invalidCartazes > 0 && <p>{invalidCartazes} cartaz(es) inválido(s) não puderam ser comparados. Consulte os erros em Meus Cartazes.</p>}</div>
      {libraryError && <p className="error-text" role="alert">DBF lido, mas a comparação não está disponível: {libraryError}. Nenhum produto foi classificado como sem cartaz.</p>}
      <div className="library-toolbar"><input aria-label="Pesquisar F7 ou descrição no DBF" placeholder="Pesquisar F7 ou descrição…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/><select aria-label="Filtrar situação" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }} disabled={!compared}>{['Todas', 'Alterado', 'Igual', 'Sem cartaz', 'Conflito no DBF', 'Dados inválidos'].map(label => <option key={label}>{label}</option>)}</select><button className="subtle" onClick={() => run(() => compare(data))}>Comparar novamente com a biblioteca</button></div>
      <div className="toolbar price-selection"><button className="subtle" disabled={!compared || eligible.length === 0} onClick={() => setSelected(new Set(eligible.map(selectionKey)))}>Selecionar todas as alterações válidas</button><button className="subtle" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Limpar seleção</button><button disabled={!compared || selected.size === 0} onClick={() => run(prepare)}>Aplicar preços selecionados ({selected.size})</button></div>
      <p className="import-caption">{filtered.length.toLocaleString('pt-BR')} resultado(s) · {eligible.length} alteração(ões) válida(s). Seleção por UUID e caminho em todas as páginas. Cartazes abertos com edição pendente ficam bloqueados.</p>
      <div className="import-table-wrap"><table className="import-table"><caption className="sr-only">Comparação de preços DBF com cartazes salvos</caption><thead><tr><th>Selecionar</th><th>F7</th><th>Produto</th><th>Preço cartaz</th><th>Preço DBF</th><th>Alternativo</th><th>Código de barras</th><th>Situação</th></tr></thead><tbody>
        {visible.map(row => <tr key={row.key}><td><input type="checkbox" aria-label={`Selecionar cartaz ${row.cartazPath ?? row.product.codeRaw}`} checked={selected.has(selectionKey(row))} disabled={!compared || !canSelect(row, editorGuard)} onChange={event => { const checked = event.target.checked; setSelected(previous => { const next = new Set(previous); if (checked) next.add(selectionKey(row)); else next.delete(selectionKey(row)); return next; }); }}/>{isBlockedInEditor(row, editorGuard) && <small className="error-text">Edição não salva</small>}</td><td className="code-cell">{row.product.codeRaw || '—'}</td><td><strong>{row.product.description || '(Sem descrição)'}</strong><details><summary>Detalhes</summary><small>Registro DBF {row.product.record} · {row.occurrences} ocorrência(s) idêntica(s)</small><small>PRVENDA original: {row.product.referenceRaw || '(vazio)'} · PRVENDA02 original: {row.product.alternativeRaw || '(vazio)'}</small>{row.cartazPath && <><small>{row.cartazPath}</small><small>UUID: {row.cartazId}</small></>}{row.product.issues.map(issue => <small className="error-text" key={issue}>{issue}</small>)}</details></td><td>{money(row.cartazPriceCents)}</td><td>{money(row.product.priceCents)}</td><td>{money(row.product.alternativeCents)}</td><td className="code-cell">{row.product.barcode ?? '—'}</td><td><span className={'comparison-status ' + (row.conflicting ? 'conflict' : '')}>{compared ? row.status : 'Não comparado'}</span>{compared && row.conflicting && row.priceStatus && <small>Preço: {row.priceStatus.toLowerCase()}</small>}</td></tr>)}
        {visible.length === 0 && <tr><td colSpan={8}>Nenhum resultado para os filtros selecionados.</td></tr>}
      </tbody></table></div>
      <div className="import-pagination"><button className="subtle" disabled={current === 0} onClick={() => setPage(current - 1)}>Anterior</button><span>Página {current + 1} de {pages} · até 100 linhas por página</span><button className="subtle" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Próxima</button></div>
      <p className="import-caption">O DBF nunca é modificado. Somente os cartazes selecionados e confirmados podem receber preços novos, com backup e histórico. Nenhum cartaz é criado automaticamente.</p>
    </>}
    <PriceHistory history={history} error={historyError} outcome={outcome} refresh={() => run(refreshHistory)} restore={id => run(async () => { setReview(await prepareRestore(id, getEditorGuard())); })}/>
    {review && <PriceConfirmation key={review.id} review={review} saving={saving} confirm={() => run(apply)} cancel={() => { const id = review.id; setReview(null); void discardPlan(id).catch(error => setHistoryError(String(error))); }}/>}
  </section>;
}
