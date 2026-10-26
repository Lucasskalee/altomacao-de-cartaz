import { useEffect, useMemo, useRef, useState } from 'react';
import { comparePrices } from '../../features/importacao/comparison';
import { compareWithLibrary, parseInWorker, selectDbf } from '../../features/importacao/service';
import type { DbfData, DbfEncoding, PriceComparison } from '../../features/importacao/types';

const money = (cents: number | null) => cents === null ? '—' : `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
type Props = { run: (action: () => Promise<void>) => void };
export function PriceImport({ run }: Props) {
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

  const compare = async (loaded: DbfData) => {
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
  return <section className="panel price-import">
    <div className="library-heading"><div><h2>Importação de Preços</h2><p>Leia um DBF local e compare com os cartazes salvos. Nenhum preço será alterado.</p></div><button onClick={() => run(importFile)}>Importar DBF</button></div>
    <div className="import-options"><label>Codificação do DBF<select value={encoding} onChange={event => { const selected = event.target.value as DbfEncoding; setEncoding(selected); if (buffer.current) run(() => parse(buffer.current!, selected)); }}>
      <option value="auto">Automática (DOS CP850 se indefinida)</option><option value="cp850">DOS CP850</option><option value="cp860">DOS português CP860</option><option value="cp437">DOS CP437</option><option value="windows-1252">Windows-1252</option><option value="utf-8">UTF-8</option>
    </select></label><div><strong>Arquivo: {name || 'Nenhum arquivo selecionado'}</strong>{data && <small>Codificação usada: {data.encoding} · Cabeçalho LDID: {data.languageDriver}</small>}</div></div>
    {!name && <p className="empty">Selecione o consulta01.dbf ou outra tabela dBASE III com CODPROD, DESCRICAO, PRVENDA, PRVENDA02 e CODBAR.</p>}
    {data && <>
      <div className="import-stats" aria-live="polite"><span><strong>{data.recordsRead.toLocaleString('pt-BR')}</strong> registros lidos</span><span><strong>{data.productsIdentified.toLocaleString('pt-BR')}</strong> produtos identificados por F7</span><span><strong>{data.deleted}</strong> excluídos ignorados</span><span><strong>{data.invalidRecords}</strong> registros com problemas</span><span><strong>{conflictCount}</strong> F7 com conflitos</span></div>
      <div className="import-warnings">{data.warnings.map(warning => <p key={warning}>{warning}</p>)}{invalidCartazes > 0 && <p>{invalidCartazes} cartaz(es) inválido(s) não puderam ser comparados. Consulte os erros em Meus Cartazes.</p>}</div>
      {libraryError && <p className="error-text" role="alert">DBF lido, mas a comparação não está disponível: {libraryError}. Nenhum produto foi classificado como sem cartaz.</p>}
      <div className="library-toolbar"><input aria-label="Pesquisar F7 ou descrição no DBF" placeholder="Pesquisar F7 ou descrição…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/><select aria-label="Filtrar situação" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }} disabled={!compared}>{['Todas', 'Alterado', 'Igual', 'Sem cartaz', 'Conflito no DBF', 'Dados inválidos'].map(label => <option key={label}>{label}</option>)}</select><button className="subtle" onClick={() => run(() => compare(data))}>Comparar novamente com a biblioteca</button></div>
      <p className="import-caption">Prévia somente leitura · {filtered.length.toLocaleString('pt-BR')} resultado(s). Cada cartaz correspondente aparece em uma linha. Registros DBF idênticos são agrupados.</p>
      <div className="import-table-wrap"><table className="import-table"><caption className="sr-only">Comparação de preços DBF com cartazes salvos</caption><thead><tr><th>F7</th><th>Produto</th><th>Preço cartaz</th><th>Preço DBF</th><th>Alternativo</th><th>Código de barras</th><th>Situação</th></tr></thead><tbody>
        {visible.map(row => <tr key={row.key}><td className="code-cell">{row.product.codeRaw || '—'}</td><td><strong>{row.product.description || '(Sem descrição)'}</strong><details><summary>Detalhes</summary><small>Registro DBF {row.product.record} · {row.occurrences} ocorrência(s) idêntica(s)</small><small>PRVENDA original: {row.product.referenceRaw || '(vazio)'} · PRVENDA02 original: {row.product.alternativeRaw || '(vazio)'}</small>{row.cartazPath && <><small>{row.cartazPath}</small><small>UUID: {row.cartazId}</small></>}{row.product.issues.map(issue => <small className="error-text" key={issue}>{issue}</small>)}</details></td><td>{money(row.cartazPriceCents)}</td><td>{money(row.product.priceCents)}</td><td>{money(row.product.alternativeCents)}</td><td className="code-cell">{row.product.barcode ?? '—'}</td><td><span className={'comparison-status ' + (row.conflicting ? 'conflict' : '')}>{compared ? row.status : 'Não comparado'}</span>{compared && row.conflicting && row.priceStatus && <small>Preço: {row.priceStatus.toLowerCase()}</small>}</td></tr>)}
        {visible.length === 0 && <tr><td colSpan={7}>Nenhum resultado para os filtros selecionados.</td></tr>}
      </tbody></table></div>
      <div className="import-pagination"><button className="subtle" disabled={current === 0} onClick={() => setPage(current - 1)}>Anterior</button><span>Página {current + 1} de {pages} · até 100 linhas por página</span><button className="subtle" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Próxima</button></div>
      <p className="import-caption">“Alterado” indica somente diferença encontrada. Esta tela não grava no DBF nem nos arquivos .skcartaz. Alterações ainda não salvas no editor não entram nesta comparação.</p>
    </>}
  </section>;
}
