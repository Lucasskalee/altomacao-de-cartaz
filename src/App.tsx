import { useCallback, useEffect, useRef, useState } from 'react';
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
import { PrintConductor } from './components/condutor/PrintConductor';
import { createQueueItemFromCartaz, createQueueItemFromPoster, findDuplicateInQueue } from './features/condutor/service';
import type { ConductorQueueItem } from './features/condutor/types';
import { createDocument, serialize } from './features/cartazes/serialization';

function getDemoLibrary(): LibraryData {
  const root = 'C:\\Skalee\\Cartazes';
  const now = Date.now();
  const doc1 = createDocument();
  doc1.product = { name: 'REPOLHO', complement: 'VERDE', priceCents: 289, unit: 'KG', productCode: '001245' };
  const doc2 = createDocument();
  doc2.product = { name: 'CERVEJA CORONA EXTRA', complement: 'LATA 350ML', priceCents: 419, unit: 'UN', productCode: '0025037' };
  const doc3 = createDocument();
  doc3.product = { name: 'ARROZ RAMPINELLI', complement: 'TIPO 1 5KG', priceCents: 1989, unit: 'PCT', productCode: '0038340' };
  const doc4 = createDocument();
  doc4.product = { name: 'GUARANÁ ANTARCTICA', complement: 'TRADICIONAL 3L', priceCents: 1119, unit: 'UN', productCode: '0029965' };
  const doc5 = createDocument();
  doc5.product = { name: 'MAÇÃ GALA NACIONAL', complement: 'SELECIONADA', priceCents: 799, unit: 'KG', productCode: null };
  const doc6 = createDocument();
  doc6.product = { name: 'TOMATE ITALIANO', complement: 'MÉDIO', priceCents: 649, unit: 'KG', productCode: '0018450' };
  const doc7 = createDocument();
  doc7.product = { name: 'FEIJÃO CARIOCA', complement: 'TIPO 1 1KG', priceCents: 689, unit: 'PCT', productCode: '0015020' };
  const doc8 = createDocument();
  doc8.product = { name: 'AÇÚCAR REFINADO', complement: 'PACOTE 1KG', priceCents: 399, unit: 'PCT', productCode: null };

  return {
    root,
    entries: [
      { name: 'Hortifruti', path: `${root}\\Hortifruti`, folder: true },
      { name: 'Bebidas', path: `${root}\\Bebidas`, folder: true },
      { name: 'Mercearia', path: `${root}\\Mercearia`, folder: true },
      { name: 'feijao carioca 1kg.skcartaz', path: `${root}\\feijao carioca 1kg.skcartaz`, folder: false, modifiedAt: now - 1800000, content: serialize(doc7) },
      { name: 'acucar refinado 1kg.skcartaz', path: `${root}\\acucar refinado 1kg.skcartaz`, folder: false, modifiedAt: now - 2500000, content: serialize(doc8) },
      { name: 'repolho verde kg.skcartaz', path: `${root}\\Hortifruti\\repolho verde kg.skcartaz`, folder: false, modifiedAt: now - 3600000, content: serialize(doc1) },
      { name: 'maca gala nacional kg.skcartaz', path: `${root}\\Hortifruti\\maca gala nacional kg.skcartaz`, folder: false, modifiedAt: now - 7200000, content: serialize(doc5) },
      { name: 'tomate italiano kg.skcartaz', path: `${root}\\Hortifruti\\tomate italiano kg.skcartaz`, folder: false, modifiedAt: now - 10800000, content: serialize(doc6) },
      { name: 'cerveja corona extra lata 350ml.psd', path: `${root}\\Bebidas\\cerveja corona extra lata 350ml.psd`, folder: false, modifiedAt: now - 14400000, content: serialize(doc2) },
      { name: 'guarana antarctica 3l.psd', path: `${root}\\Bebidas\\guarana antarctica 3l.psd`, folder: false, modifiedAt: now - 18000000, content: serialize(doc4) },
      { name: 'arroz rampinelli 5kg.skcartaz', path: `${root}\\Mercearia\\arroz rampinelli 5kg.skcartaz`, folder: false, modifiedAt: now - 21600000, content: serialize(doc3) },
    ]
  };
}

export default function App() {
  const editor = useCartaz();
  const editorGuard = { path: editor.path, dirty: editor.dirty };
  const guardRef = useRef(editorGuard);
  guardRef.current = editorGuard;
  const f7Matches = useF7Matches(editor.document.product.productCode, editor.path);
  const queryParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isDemoMode = queryParams?.get('demo') === '1';
  const [section, setSection] = useState(() => queryParams?.get('tab') || 'editor');
  const [data, setData] = useState<LibraryData | null>(() => (isDemoMode ? getDemoLibrary() : null));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [queue, setQueue] = useState<Poster[]>([]);
  const [conductorQueue, setConductorQueue] = useState<ConductorQueueItem[]>([]);
  const [batchPrintPosters, setBatchPrintPosters] = useState<Poster[] | null>(null);
  const [showFormatMenu, setShowFormatMenu] = useState(() => (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('formatMenu') === '1' : false));
  const formatMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (formatMenuRef.current && !formatMenuRef.current.contains(e.target as Node)) {
        setShowFormatMenu(false);
      }
    };
    if (showFormatMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showFormatMenu]);
  const poster: Poster = { ...posterFromDocument(editor.document), price: editor.price };
  const imported=editor.document.layout.template==='imported-psd';
  const invertedLayers=poster.artwork?hasInvertedPsdPriceParts(poster.artwork):false;
  const priceWarning=poster.artwork?(invertedLayers?'As camadas de Reais e Centavos estão invertidas nesta arte PSD. Clique em "Corrigir inversão Reais/Centavos" abaixo antes de salvar ou imprimir.':importedPriceWarning(poster.artwork,poster.price)):'';
  const refresh = async () => {
    try {
      setData(await listFiles());
    } catch (e) {
      if (isDemoMode) {
        setData(getDemoLibrary());
      } else {
        throw e;
      }
    }
    f7Matches.refresh();
  };
  useEffect(() => {
    let active = true;
    listFiles()
      .then(value => {
        if (active) setData(value);
      })
      .catch(ex => {
        if (active) {
          if (isDemoMode) {
            setData(getDemoLibrary());
          } else {
            setError(String(ex));
          }
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const renderedPostersCountRef = useRef(0);
  const printReadyResolveRef = useRef<(() => void) | null>(null);

  const handlePosterRendered = useCallback(() => {
    renderedPostersCountRef.current++;
    if (
      batchPrintPosters &&
      renderedPostersCountRef.current >= batchPrintPosters.length &&
      printReadyResolveRef.current
    ) {
      const resolve = printReadyResolveRef.current;
      printReadyResolveRef.current = null;
      resolve();
    }
  }, [batchPrintPosters]);

  const handlePrintBatch = async (
    posters: Poster[] | null,
    options?: {
      onReadyToPrint?: () => void;
      onDialogClosed?: () => void;
      keepMountedUntilConfirmed?: boolean;
    }
  ) => {
    if (!posters || posters.length === 0) {
      setBatchPrintPosters(null);
      return;
    }

    renderedPostersCountRef.current = 0;
    setBatchPrintPosters(posters);

    // Aguarda todos os canvas e fontes renderizarem sem tempo fixo arbitrário
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          } else {
            setTimeout(resolve, 30);
          }
        }
      };

      if (renderedPostersCountRef.current >= posters.length) {
        finish();
        return;
      }

      printReadyResolveRef.current = finish;
      setTimeout(finish, 8000);
    });

    if (typeof document !== 'undefined' && 'fonts' in document) {
      try {
        await document.fonts.ready;
      } catch {}
    }

    if (options?.onReadyToPrint) {
      options.onReadyToPrint();
    }

    window.print();

    if (options?.onDialogClosed) {
      options.onDialogClosed();
    }

    if (!options?.keepMountedUntilConfirmed) {
      setBatchPrintPosters(null);
    }
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
    <header className="sk-header">
      <div className="brand">
        <img className="brand-logo" src="/logo.png" alt="Logo oficial Skalee" />
        <div>
          <strong>Skalee Cartaz</strong>
          <small>Automação de Cartazes Promocionais · Operação Local</small>
        </div>
      </div>

      <div className="sk-header-tools">
        {/* Seletor Visual de Formatos de Cartaz */}
        <div className="sk-format-selector-wrap" ref={formatMenuRef}>
          <button
            type="button"
            className="sk-format-btn"
            onClick={() => setShowFormatMenu(prev => !prev)}
            aria-expanded={showFormatMenu}
            aria-haspopup="listbox"
            title="Formato atual do papel para os cartazes"
          >
            <span className="sk-status-dot" style={{ background: '#2563eb' }} />
            <span>Formato: <strong>A5 Vertical (148 × 210 mm)</strong></span>
            <span style={{ fontSize: 9, color: '#64748b', marginLeft: 2 }}>▼</span>
          </button>

          {showFormatMenu && (
            <div className="sk-format-dropdown" role="listbox" aria-label="Formatos oficiais do Skalee Cartaz">
              <div className="sk-format-dropdown-heading">Formatos Oficiais</div>
              
              {/* 1. A6 Vertical */}
              <button
                type="button"
                className="sk-format-option"
                disabled
                title="Suporte planejado para as próximas etapas"
                role="option"
                aria-selected={false}
              >
                <span>A6 Vertical (105 × 148 mm)</span>
                <span className="sk-format-badge soon">Em breve</span>
              </button>

              {/* 2. A5 Vertical (Ativo) */}
              <button
                type="button"
                className="sk-format-option active"
                onClick={() => setShowFormatMenu(false)}
                role="option"
                aria-selected={true}
              >
                <span>A5 Vertical (148 × 210 mm)</span>
                <span className="sk-format-badge active">Ativo</span>
              </button>

              {/* 3. A4 Vertical */}
              <button
                type="button"
                className="sk-format-option"
                disabled
                title="Suporte planejado para as próximas etapas"
                role="option"
                aria-selected={false}
              >
                <span>A4 Vertical (210 × 297 mm)</span>
                <span className="sk-format-badge soon">Em breve</span>
              </button>

              {/* 4. A3 Vertical */}
              <button
                type="button"
                className="sk-format-option"
                disabled
                title="Suporte planejado para as próximas etapas"
                role="option"
                aria-selected={false}
              >
                <span>A3 Vertical (297 × 420 mm)</span>
                <span className="sk-format-badge soon">Em breve</span>
              </button>

              {/* 5. Expositor A3 2x2 */}
              <button
                type="button"
                className="sk-format-option"
                disabled
                title="Uma arte distribuída em 4 folhas A3 verticais (2 colunas × 2 linhas)"
                role="option"
                aria-selected={false}
              >
                <div>
                  <div>Expositor A3 2×2 (594 × 840 mm)</div>
                  <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>4 folhas A3 em 2 colunas × 2 linhas</div>
                </div>
                <span className="sk-format-badge soon">Em breve</span>
              </button>
            </div>
          )}
        </div>

        {/* Indicador de Operação Local */}
        <div
          className="sk-offline-pill"
          title="Processamento e banco de dados executando localmente no seu computador"
        >
          <span className="sk-status-dot" />
          <span>Execução Local</span>
        </div>
      </div>
    </header>

    <nav className="sk-navigation navigation" aria-label="Navegação principal">
      <button
        type="button"
        className={`sk-nav-tab ${section === 'editor' ? 'active' : ''}`}
        disabled={busy}
        onClick={() => setSection('editor')}
      >
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
        </svg>
        <span>Editor de Cartazes</span>
      </button>

      <button
        type="button"
        className={`sk-nav-tab ${section === 'library' ? 'active' : ''}`}
        disabled={busy}
        onClick={() => { setSection('library'); run(refresh); }}
      >
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        <span>Meus Cartazes</span>
      </button>

      <button
        type="button"
        className={`sk-nav-tab ${section === 'import' ? 'active' : ''}`}
        disabled={busy}
        onClick={() => setSection('import')}
      >
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
        <span>Importação de Preços</span>
      </button>

      <button
        type="button"
        className={`sk-nav-tab ${section === 'offers' ? 'active' : ''}`}
        disabled={busy}
        onClick={() => { setSection('offers'); run(refresh); }}
      >
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5c.266 0 .52.105.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
        </svg>
        <span>Pastas de Ofertas</span>
      </button>

      <button
        type="button"
        className={`sk-nav-tab ${section === 'scantech' ? 'active' : ''}`}
        disabled={busy}
        onClick={() => { setSection('scantech'); run(refresh); }}
      >
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
        </svg>
        <span>Criar Cartaz Scantech</span>
      </button>

      <button
        type="button"
        className={`sk-nav-tab ${section === 'conductor' ? 'active' : ''}`}
        disabled={busy}
        onClick={() => { setSection('conductor'); run(refresh); }}
      >
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v2a2 2 0 002 2h6a2 2 0 002-2v-2h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z" clipRule="evenodd" />
        </svg>
        <span>Condutor de Impressão</span>
        {conductorQueue.length > 0 && (
          <span className="sk-nav-counter">{conductorQueue.length}</span>
        )}
      </button>
    </nav>
    <div className="notifications" aria-live="polite">{busy && <p role="status">Aguarde…</p>}{message && <p className="success" role="status">{message}</p>}{error && <p className="error-text" role="alert">{error}</p>}</div>
    <fieldset className="workspace" disabled={busy} aria-busy={busy}>
    {section === 'editor' ? (
      <div className="editor-workspace-wrap">
        {/* Barra de Ações do Documento */}
        <div className="editor-document-bar">
          <div className="editor-toolbar">
            <button type="button" className="editor-btn subtle" onClick={() => run(newDocument)}>
              + Novo Cartaz
            </button>
            <button
              type="button"
              className="editor-btn subtle"
              onClick={() => run(async () => {
                if (await editor.openReferencePsd()) {
                  setMessage('Modelo PSD carregado. Edite os campos e salve o novo cartaz.');
                }
              })}
            >
              Novo a partir de PSD
            </button>
            <button type="button" className="editor-btn subtle" onClick={() => run(() => open())}>
              Abrir
            </button>
            <button type="button" className="editor-btn primary" onClick={() => run(() => save())}>
              Salvar
            </button>
            <button type="button" className="editor-btn subtle" onClick={() => run(() => save(true))}>
              Salvar Como
            </button>
            <button
              type="button"
              className="editor-btn subtle"
              onClick={() => run(async () => {
                if (await editor.duplicate()) {
                  setMessage('Cópia criada no editor. Salve com outro nome.');
                }
              })}
            >
              Duplicar
            </button>
          </div>

          <div
            className={`editor-status-pill ${editor.dirty ? 'dirty' : 'saved'}`}
            title={editor.path ?? 'Cartaz novo — ainda não salvo'}
          >
            <span>{editor.dirty ? '● Alterações não salvas' : '✓ Salvo no computador'}</span>
            <span style={{ opacity: 0.6 }}>·</span>
            <span>{editor.path ? editor.path.split(/[\\/]/).pop() : 'Novo cartaz'}</span>
          </div>
        </div>

        {/* Layout Principal: Propriedades + Prévia A5 */}
        <div className="editor-layout">
          {/* Coluna 1: Painel de Propriedades Organizado */}
          <section className="editor-panel" aria-label="Propriedades da oferta">
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', margin: '0 0 4px 0' }}>Editar Oferta</h2>
              <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>Preencha os campos abaixo para atualizar instantaneamente o cartaz.</p>
            </div>

            {imported && !poster.artwork?.isReferenceTemplate && (
              <div className="import-warning" style={{ marginBottom: 14 }}>
                Arte PSD legada: somente preço e F7 são dinâmicos.
              </div>
            )}

            {poster.artwork?.isReferenceTemplate && (
              <div
                style={{
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  borderRadius: 8,
                  padding: '8px 12px',
                  marginBottom: 14,
                  fontSize: 11.5,
                  color: '#15803d',
                  fontWeight: 600,
                }}
              >
                Modelo PSD ativo: Categoria, Nome (Brush Hand New), Complemento, Embalagem, Preço e Validade editáveis.
              </div>
            )}

            {/* SEÇÃO 1: Identificação do Produto */}
            <div className="editor-section">
              <div className="editor-section-header">
                <span>1. Identificação do Produto</span>
              </div>

              {poster.artwork?.isReferenceTemplate && (
                <div className="editor-field">
                  <label>Categoria</label>
                  <input
                    className="editor-input"
                    value={((editor.document.product as any).category as string) || poster.category || ''}
                    maxLength={32}
                    onChange={e => editor.change('category', e.target.value.toUpperCase())}
                  />
                </div>
              )}

              <div className="editor-field">
                <label>Nome Principal</label>
                <input
                  className="editor-input"
                  style={{ fontWeight: 700 }}
                  disabled={imported && !poster.artwork?.isReferenceTemplate}
                  value={poster.name}
                  maxLength={32}
                  onChange={e => editor.change('name', e.target.value.toUpperCase())}
                />
              </div>

              <div className="editor-field">
                <label>Complemento / Detalhe</label>
                <input
                  className="editor-input"
                  disabled={imported && !poster.artwork?.isReferenceTemplate}
                  value={poster.detail}
                  maxLength={28}
                  onChange={e => editor.change('complement', e.target.value.toUpperCase())}
                />
              </div>
            </div>

            {/* SEÇÃO 2: Preço & Embalagem */}
            <div className="editor-section">
              <div className="editor-section-header">
                <span>2. Preço & Embalagem</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="editor-field">
                  <label>Preço (R$)</label>
                  <input
                    className="editor-input price-input"
                    inputMode="decimal"
                    value={poster.price}
                    onChange={e => editor.change('price', e.target.value)}
                  />
                </div>

                <div className="editor-field">
                  <label>Unidade / Embalagem</label>
                  {poster.artwork?.isReferenceTemplate ? (
                    <input
                      className="editor-input"
                      value={poster.unit}
                      maxLength={12}
                      onChange={e => editor.change('unit', e.target.value.toUpperCase())}
                    />
                  ) : (
                    <select
                      className="editor-select"
                      disabled={imported}
                      value={poster.unit}
                      onChange={e => editor.change('unit', e.target.value)}
                    >
                      {Array.from(new Set(['KG', 'UN', 'PCT', 'CX', 'LT', poster.unit])).map(unit => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {poster.artwork?.isReferenceTemplate && (
                <div className="editor-field" style={{ marginTop: 10 }}>
                  <label>Validade da Oferta</label>
                  <input
                    className="editor-input"
                    value={((editor.document.product as any).validityText as string) || poster.validityText || ''}
                    placeholder="Ex: 08/11/2026 ou OFERTA VÁLIDA ATÉ 25/10"
                    onChange={e => editor.change('validityText', e.target.value)}
                  />
                </div>
              )}

              {priceWarning && (
                <p className="error-text" role="alert" style={{ margin: '10px 0 0 0', fontSize: 12 }}>
                  {priceWarning}
                </p>
              )}

              {invertedLayers && (
                <button
                  type="button"
                  className="editor-btn subtle"
                  style={{ marginTop: 10, width: '100%' }}
                  onClick={() => editor.fixInvertedPsdLayers()}
                >
                  Corrigir inversão Reais/Centavos (restaurar preço original)
                </button>
              )}
            </div>

            {/* SEÇÃO 3: Dados Comerciais & Código F7 */}
            <div className="editor-section">
              <div className="editor-section-header">
                <span>3. Dados Comerciais</span>
              </div>

              <F7Field
                value={editor.document.product.productCode}
                onChange={value => editor.change('productCode', value)}
                matches={f7Matches.matches}
                checking={f7Matches.checking}
                error={f7Matches.error}
                onRefresh={f7Matches.refresh}
              />
            </div>

            {/* SEÇÃO 4: Ações de Impressão e Saída */}
            <div className="editor-section">
              <div className="editor-section-header">
                <span>4. Ações de Saída</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button
                  type="button"
                  className="editor-btn primary"
                  style={{ justifyContent: 'center', height: 40, fontSize: 13 }}
                  disabled={Boolean(priceWarning)}
                  onClick={() => run(async () => {
                    validPoster();
                    window.print();
                  })}
                >
                  🖨️ Imprimir A5
                </button>

                <button
                  type="button"
                  className="editor-btn secondary"
                  style={{ justifyContent: 'center', height: 40, fontSize: 12 }}
                  disabled={Boolean(priceWarning)}
                  onClick={() => run(async () => exportPng(validPoster()))}
                >
                  Exportar PNG 300 DPI
                </button>
              </div>

              <button
                type="button"
                className="editor-btn outline-blue"
                style={{ width: '100%', marginTop: 10, justifyContent: 'center', height: 38 }}
                onClick={() => run(async () => {
                  const p = validPoster();
                  setQueue(items => [...items, p]);
                  const item = createQueueItemFromPoster(p);
                  setConductorQueue(items => [...items, item]);
                  setMessage(`"${p.name}" adicionado ao Condutor de Impressão (${conductorQueue.length + 1} na fila).`);
                })}
              >
                + Adicionar ao Condutor de Impressão ({conductorQueue.length})
              </button>

              {/* Fila Temporária Integrada (Preservada conforme requisito 7) */}
              {queue.length > 0 && (
                <div className="editor-queue-box">
                  <h3>Cartazes no Condutor ({queue.length})</h3>
                  {queue.map((item, i) => (
                    <div key={i} className="editor-queue-item">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                        <strong>{item.name}</strong> {item.detail} · R$ {item.price}
                      </span>
                      <button
                        type="button"
                        className="editor-queue-remove"
                        aria-label={'Remover ' + item.name}
                        title="Remover cartaz da fila temporária"
                        onClick={() => {
                          setQueue(items => items.filter((_, j) => i !== j));
                          setConductorQueue(items => items.filter((_, j) => i !== j));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div style={{ marginTop: 6, fontSize: 10, color: '#94a3b8' }}>
                    Cartazes prontos para impressão em lote na aba Condutor de Impressão.
                  </div>
                </div>
              )}

              <p style={{ margin: '14px 0 0 0', fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                Impressão: papel A5 vertical, escala 100%, margens nenhuma e desative cabeçalhos/rodapés.
              </p>
            </div>
          </section>

          {/* Coluna 2: Hero Preview A5 Real */}
          <section className="editor-panel" aria-label="Prévia visual do cartaz">
            <div className="editor-preview-heading">
              <div>
                <h2>Pré-visualização do Cartaz</h2>
                <p>Proporção A5 Real · 148 × 210 mm (300 DPI)</p>
              </div>
              <span className="status" style={{ fontSize: 11, padding: '4px 10px' }}>
                Documento Editável Local
              </span>
            </div>

            <div className="editor-canvas-wrap">
              <PosterView poster={poster} />
            </div>
          </section>
        </div>
      </div>
    ) : section === 'library' ? (
      <div className="library-container">
        {data ? (
          <Library
            data={data}
            open={open}
            newDocument={newDocument}
            run={run}
            refresh={refresh}
            relocated={editor.relocate}
            removed={editor.removed}
            onAddToConductor={(cartaz, cartazPath) => {
              const existing = findDuplicateInQueue(conductorQueue, cartazPath);
              if (existing) {
                setMessage(`"${cartaz.product.name}" já está na fila do Condutor de Impressão.`);
              } else {
                const item = createQueueItemFromCartaz(cartaz, cartazPath, 'library');
                setConductorQueue(q => [...q, item]);
                setMessage(`"${cartaz.product.name}" adicionado ao Condutor de Impressão (${conductorQueue.length + 1} na fila).`);
              }
            }}
          />
        ) : (
          <section className="panel">
            <h2>Meus Cartazes</h2>
            <p>Abra o aplicativo desktop para usar a biblioteca local.</p>
            <button onClick={() => run(refresh)}>Tentar novamente</button>
          </section>
        )}
      </div>
    ) : null}
    <div hidden={section !== 'import'} className="library-container"><PriceImport run={run} editorGuard={editorGuard} getEditorGuard={() => guardRef.current} onFilesChanged={async paths => { await refresh(); await editor.refreshSaved(paths); }}/></div>
    <div hidden={section !== 'offers'} className="library-container"><OfferFolders libraryData={data} run={run} onPrintBatch={handlePrintBatch} onRefreshLibrary={refresh}/></div>
    <div hidden={section !== 'scantech'} className="library-container"><ScantechCreator libraryData={data} run={run} onPrintBatch={handlePrintBatch} onRefreshLibrary={refresh}/></div>
    <div hidden={section !== 'conductor'} className="library-container"><PrintConductor queue={conductorQueue} setQueue={setConductorQueue} libraryData={data} run={run} onPrintBatch={handlePrintBatch}/></div>
    </fieldset><div className="print-only">{batchPrintPosters && batchPrintPosters.length > 0 ? batchPrintPosters.map((p, i) => <div className="print-page" key={i}><PosterView poster={p} isPrint={true} onRendered={handlePosterRendered}/></div>) : <PosterView poster={poster} isPrint={true}/>}</div>
  </div>;
}
