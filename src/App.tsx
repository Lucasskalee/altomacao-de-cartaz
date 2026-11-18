import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { PosterView, type Poster } from './components/editor/PosterView';
import { exportPng } from './components/editor/exportPng';
import { Library } from './components/library/Library';
import { useCartaz } from './hooks/useCartaz';
import { listFiles } from './features/cartazes/storage';
import type { Cartaz, Library as LibraryData } from './features/cartazes/types';
import { F7Field } from './components/editor/F7Field';
import { useF7Matches } from './hooks/useF7Matches';
import { formatCentsBr, posterFromDocument } from './features/cartazes/presentation';
import { PriceImport } from './components/importacao/PriceImport';
import { OfferFolders } from './components/ofertas/OfferFolders';
import { ScantechCreator } from './components/scantech/ScantechCreator';
import { hasInvertedPsdPriceParts, importedPriceWarning, repairInvertedPsdArtwork } from './components/editor/importedRenderer';
import { PrintConductor } from './components/condutor/PrintConductor';
import { createQueueItemFromCartaz, createQueueItemFromPoster, findDuplicateInQueue } from './features/condutor/service';
import type { ConductorQueueItem } from './features/condutor/types';
import { createDocument, serialize } from './features/cartazes/serialization';
import type { PaperSize, Orientation, PosterFormatConfig } from './features/formatos/types';
import {
  applyDynamicPrintStyles,
  removeDynamicPrintStyles,
  getFormatDimensionsMm,
  getFormatLabel,
  checkPosterResolution,
} from './features/formatos/service';
import { addPrintHistoryEntries, updatePrintHistoryStatus } from './features/history/service';
import { PrintHistoryModal } from './components/history/PrintHistoryModal';
import { expandExpositorToA3Posters } from './features/formatos/expositor';
import { isTauri } from '@tauri-apps/api/core';

const EditLinkedPsd = lazy(() =>
  import('./components/ofertas/EditLinkedPsd').then(module => ({ default: module.EditLinkedPsd }))
);

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
  const isDemoMode = queryParams?.get('demo') === '1' || !isTauri();
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
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [linkedArtworkEdit, setLinkedArtworkEdit] = useState<{ path: string | null; document: Cartaz } | null>(null);
  const [confirmationModal, setConfirmationModal] = useState<{
    entryIds: string[];
    productName: string;
    formatLabel: string;
    copies: number;
  } | null>(null);
  const [customWInput, setCustomWInput] = useState('148');
  const [customHInput, setCustomHInput] = useState('210');
  const [customOrientInput, setCustomOrientInput] = useState<Orientation>('portrait');
  const [printerSheetA4, setPrinterSheetA4] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('skalee_printer_sheet_a4');
      if (saved !== null) return saved === 'true';
    }
    return true; // Padrão: folha física A4 com arte centralizada no topo
  });

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('skalee_theme');
      if (saved === 'dark' || saved === 'light') return saved;
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    }
    return 'dark'; // Padrão: Modo Escuro idêntico ao Controle de Validade
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('skalee_sidebar_collapsed') === 'true';
    }
    return false;
  });

  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem('skalee_sidebar_collapsed', String(next));
      }
      return next;
    });
  };

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      try {
        localStorage.setItem('skalee_theme', theme);
      } catch {}
    }
  }, [theme]);

  const activeFormat: PosterFormatConfig = {
    paper: editor.document.layout.paper || 'A5',
    orientation: editor.document.layout.orientation || 'portrait',
    customWidthMm: editor.document.layout.customWidthMm,
    customHeightMm: editor.document.layout.customHeightMm,
    printerSheetA4,
  };

  const handleSelectFormat = (paper: PaperSize, orientation: Orientation = 'portrait', customW?: number, customH?: number) => {
    editor.changeLayout({
      paper,
      orientation,
      customWidthMm: customW,
      customHeightMm: customH,
    });
    setShowFormatMenu(false);
  };

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
  const hasTextRole = (role: 'category' | 'title' | 'complement' | 'packaging') =>
    Boolean(poster.artwork?.templateParts?.some(part => part.role === role));
  const invertedLayers=poster.artwork?hasInvertedPsdPriceParts(poster.artwork):false;
  const priceWarning=poster.artwork?(invertedLayers?'As camadas de Reais e Centavos estão invertidas nesta arte PSD. Clique em "Corrigir inversão Reais/Centavos" abaixo antes de salvar ou imprimir.':importedPriceWarning(poster.artwork,poster.price)):'';
  const resolutionCheck = poster.artwork?.canvas?.width && poster.artwork?.canvas?.height
    ? checkPosterResolution(activeFormat, poster.artwork.canvas.width, poster.artwork.canvas.height)
    : null;
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
      formatConfig?: PosterFormatConfig;
    }
  ) => {
    if (!posters || posters.length === 0) {
      setBatchPrintPosters(null);
      return;
    }

    const effectiveFormat = options?.formatConfig || activeFormat;
    applyDynamicPrintStyles(effectiveFormat);

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
    removeDynamicPrintStyles();
  };
  const run = (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    action().catch(ex => setError(String(ex))).finally(() => { locked.current = false; setBusy(false); });
  };
  const newDocument = async () => { if (await editor.newDocument()) setSection('editor'); };
  const open = async (path?: string) => { if (await editor.open(path)) { setSection('editor'); setMessage('Cartaz aberto.'); } };
  const openOfferPoster = async (path: string, scheduledPriceCents?: number) => {
    const result = await editor.open(path, true);
    if (!result) return;
    if (typeof scheduledPriceCents === 'number' && scheduledPriceCents > 0) {
      editor.change('price', formatCentsBr(scheduledPriceCents));
    }
    setSection('editor');
    if (result.preparationError) {
      setError(`Cartaz aberto, mas não foi possível preparar os textos automaticamente: ${result.preparationError} Use "Preparar textos do PSD para edição" para revisar ou selecionar o PSD original.`);
    } else if (result.prepared) {
      setMessage('Textos preparados automaticamente. Confira os campos e a prévia; use Salvar Como para preservar o original.');
    } else {
      setMessage('Cartaz aberto.');
    }
  };
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
            <span>Formato: <strong>{getFormatLabel(activeFormat)}</strong></span>
            {printerSheetA4 && (activeFormat.paper === 'A5' || activeFormat.paper === 'A6') && (
              <span
                style={{
                  fontSize: 10,
                  background: '#dbeafe',
                  color: '#1e40af',
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontWeight: 700,
                  marginLeft: 4,
                }}
                title="Folha física da impressora travada em A4 com arte centralizada no topo"
              >
                Folha A4 Topo
              </span>
            )}
            <span style={{ fontSize: 9, color: '#64748b', marginLeft: 2 }}>▼</span>
          </button>

          {showFormatMenu && (
            <div className="sk-format-dropdown" role="listbox" aria-label="Formatos oficiais do Skalee Cartaz">
              <div className="sk-format-dropdown-heading">Formatos Oficiais</div>

              {/* 1. A6 Vertical */}
              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A6' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A6', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A6'}
              >
                <span>A6 Vertical (105 × 148 mm)</span>
                {activeFormat.paper === 'A6' && (
                  <span className="sk-format-badge active">Ativo</span>
                )}
              </button>

              {/* 2. A5 Vertical */}
              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A5' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A5', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A5'}
              >
                <span>A5 Vertical (148 × 210 mm)</span>
                {activeFormat.paper === 'A5' && (
                  <span className="sk-format-badge active">Ativo</span>
                )}
              </button>

              {/* 3. A4 Vertical */}
              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A4' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A4', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A4'}
              >
                <span>A4 Vertical (210 × 297 mm)</span>
                {activeFormat.paper === 'A4' && (
                  <span className="sk-format-badge active">Ativo</span>
                )}
              </button>

              {/* 4. A3 Vertical */}
              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A3' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A3', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A3'}
              >
                <span>A3 Vertical (297 × 420 mm)</span>
                {activeFormat.paper === 'A3' && (
                  <span className="sk-format-badge active">Ativo</span>
                )}
              </button>

              {/* 5. Expositor A3 2x2 */}
              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'expositor-a3-2x2' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('expositor-a3-2x2', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'expositor-a3-2x2'}
                title="Uma arte distribuída em 4 folhas A3 verticais (2 colunas × 2 linhas)"
              >
                <div>
                  <div>Expositor A3 2×2 (594 × 840 mm)</div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>4 folhas A3 em 2 colunas × 2 linhas</div>
                </div>
                {activeFormat.paper === 'expositor-a3-2x2' && (
                  <span className="sk-format-badge active">Ativo</span>
                )}
              </button>

              <div className="sk-format-dropdown-heading" style={{ marginTop: 8 }}>Segurança da Impressora</div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '8px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: printerSheetA4 ? '#eff6ff' : '#f8fafc',
                  borderRadius: 8,
                  border: printerSheetA4 ? '1px solid #bfdbfe' : '1px solid #e2e8f0',
                  margin: '4px 6px',
                }}
              >
                <input
                  type="checkbox"
                  checked={printerSheetA4}
                  onChange={e => {
                    const val = e.target.checked;
                    setPrinterSheetA4(val);
                    if (typeof window !== 'undefined') {
                      localStorage.setItem('skalee_printer_sheet_a4', String(val));
                    }
                  }}
                  style={{ accentColor: '#2563eb', width: 16, height: 16, marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <strong style={{ display: 'block', color: '#1e293b', fontSize: 12 }}>
                    Folha física sempre A4 (Topo Central)
                  </strong>
                  <span style={{ fontSize: 10.5, color: '#64748b', lineHeight: 1.3, display: 'block' }}>
                    Trava a saída física em A4. Cartazes A5 e A6 saem no topo central sem desconfigurar a impressora.
                  </span>
                </div>
              </label>

              <div className="sk-format-dropdown-heading" style={{ marginTop: 6 }}>Opção Adicional</div>

              {/* 6. Formato Personalizado */}
              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'custom' ? 'active' : ''}`}
                onClick={() => {
                  setShowFormatMenu(false);
                  setShowCustomModal(true);
                }}
                role="option"
                aria-selected={activeFormat.paper === 'custom'}
              >
                <span>Personalizado (largura × altura mm)…</span>
                {activeFormat.paper === 'custom' && (
                  <span className="sk-format-badge active">Ativo</span>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Botão de Histórico de Impressão */}
        <button
          type="button"
          className="editor-btn subtle"
          onClick={() => setShowHistoryModal(true)}
          title="Consultar histórico local e persistente de impressões"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
        >
          <span>📋</span>
          <span>Histórico</span>
        </button>

        {/* Alternador de Modo Escuro / Claro */}
        <button
          type="button"
          className="sk-theme-btn"
          onClick={() => setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Alternar para Modo Claro' : 'Alternar para Modo Escuro'}
          aria-label={theme === 'dark' ? 'Alternar para Modo Claro' : 'Alternar para Modo Escuro'}
        >
          <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
          <span>{theme === 'dark' ? 'Modo Claro' : 'Modo Escuro'}</span>
        </button>

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

    <div className="sk-body-layout">
      {/* Barra de Navegação Lateral Estilo Controle de Validade */}
      <aside className={`sk-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`} aria-label="Menu Lateral">
        <div className="sk-sidebar-header">
          {!sidebarCollapsed && <span className="sk-sidebar-title">NAVEGAÇÃO</span>}
          <button
            type="button"
            className="sk-sidebar-toggle"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
            aria-label={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        <nav className="sk-sidebar-nav" aria-label="Navegação lateral">
          <button
            type="button"
            className={`sk-sidebar-item ${section === 'editor' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => setSection('editor')}
            title="Editor de Cartazes"
          >
            <div className="sk-sidebar-icon">
              <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
              </svg>
            </div>
            {!sidebarCollapsed && <span className="sk-sidebar-label">Editor de Cartazes</span>}
          </button>

          <button
            type="button"
            className={`sk-sidebar-item ${section === 'library' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => { setSection('library'); run(refresh); }}
            title="Meus Cartazes"
          >
            <div className="sk-sidebar-icon">
              <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
            </div>
            {!sidebarCollapsed && <span className="sk-sidebar-label">Meus Cartazes</span>}
          </button>

          <button
            type="button"
            className={`sk-sidebar-item ${section === 'import' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => setSection('import')}
            title="Importação de Preços"
          >
            <div className="sk-sidebar-icon">
              <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </div>
            {!sidebarCollapsed && <span className="sk-sidebar-label">Importação de Preços</span>}
          </button>

          <button
            type="button"
            className={`sk-sidebar-item ${section === 'offers' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => { setSection('offers'); run(refresh); }}
            title="Pastas de Ofertas"
          >
            <div className="sk-sidebar-icon">
              <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                <path fillRule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5c.266 0 .52.105.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            </div>
            {!sidebarCollapsed && <span className="sk-sidebar-label">Pastas de Ofertas</span>}
          </button>

          <button
            type="button"
            className={`sk-sidebar-item ${section === 'scantech' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => { setSection('scantech'); run(refresh); }}
            title="Criar Cartaz Scantech"
          >
            <div className="sk-sidebar-icon">
              <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
              </svg>
            </div>
            {!sidebarCollapsed && <span className="sk-sidebar-label">Criar Cartaz Scantech</span>}
          </button>

          <button
            type="button"
            className={`sk-sidebar-item ${section === 'conductor' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => { setSection('conductor'); run(refresh); }}
            title="Condutor de Impressão"
          >
            <div className="sk-sidebar-icon">
              <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                <path fillRule="evenodd" d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v2a2 2 0 002 2h6a2 2 0 002-2v-2h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z" clipRule="evenodd" />
              </svg>
            </div>
            {!sidebarCollapsed && <span className="sk-sidebar-label">Condutor de Impressão</span>}
            {conductorQueue.length > 0 && (
              <span className="sk-sidebar-badge">{conductorQueue.length}</span>
            )}
          </button>
        </nav>
      </aside>

      <div className="sk-main-content" role="main">
        <div className="notifications" aria-live="polite">
          {busy && <p role="status">Aguarde…</p>}
          {message && <p className="success" role="status">{message}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>

        <fieldset className="workspace" disabled={busy} aria-busy={busy}>
    {section === 'editor' ? (
      <div className="editor-workspace-wrap">
        {/* Barra de Ações do Documento */}
        <div className="editor-document-bar">
          <div className="editor-toolbar">
            <button type="button" className="editor-btn subtle" onClick={() => run(async () => { await editor.newOfficial('oferta'); })}>
              + Novo (Oferta)
            </button>
            <button type="button" className="editor-btn subtle" style={{ color: '#b45309', borderColor: '#fde68a', background: '#fffbeb' }} onClick={() => run(async () => { await editor.newOfficial('vencimento'); })}>
              + Novo (Vencimento)
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

            {/* SELETOR DE MODELO DE LAYOUT */}
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: '10px 12px',
                marginBottom: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>Modelo de Layout</span>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: editor.posterModel === 'vencimento' ? '#fef3c7' : '#e0e7ff',
                    color: editor.posterModel === 'vencimento' ? '#92400e' : '#3730a3',
                  }}
                >
                  {editor.posterModel === 'vencimento' ? '⏳ Vencimento' : '🏷️ Oferta Normal'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <button
                  type="button"
                  style={{
                    padding: '7px 10px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 7,
                    border: editor.posterModel === 'oferta' ? '2px solid #2563eb' : '1px solid #cbd5e1',
                    background: editor.posterModel === 'oferta' ? '#eff6ff' : '#ffffff',
                    color: editor.posterModel === 'oferta' ? '#1d4ed8' : '#475569',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                  onClick={() => run(async () => {
                    if (editor.posterModel !== 'oferta') {
                      await editor.switchModel('oferta');
                      setMessage('Modelo alterado para Oferta Normal.');
                    }
                  })}
                >
                  🏷️ Oferta Normal
                </button>
                <button
                  type="button"
                  style={{
                    padding: '7px 10px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 7,
                    border: editor.posterModel === 'vencimento' ? '2px solid #d97706' : '1px solid #cbd5e1',
                    background: editor.posterModel === 'vencimento' ? '#fffbeb' : '#ffffff',
                    color: editor.posterModel === 'vencimento' ? '#b45309' : '#475569',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                  onClick={() => run(async () => {
                    if (editor.posterModel !== 'vencimento') {
                      await editor.switchModel('vencimento');
                      setMessage('Modelo alterado para Próximo ao Vencimento.');
                    }
                  })}
                >
                  ⏳ Vencimento
                </button>
              </div>
            </div>

            {imported && !poster.artwork?.isReferenceTemplate && (
              <div className="import-warning" style={{ marginBottom: 14 }}>
                Arte PSD legada: os textos ainda não estão preparados para edição.
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
                Modelo PSD ativo: somente os campos de texto mapeados são editáveis.
              </div>
            )}

            {imported && (
              <button
                type="button"
                className="editor-btn subtle"
                style={{ marginBottom: 14 }}
                onClick={() => run(async () => setLinkedArtworkEdit({ path: editor.path, document: editor.current() }))}
              >
                Preparar textos do PSD para edição
              </button>
            )}

            {/* SEÇÃO 1: Identificação do Produto */}
            <div className="editor-section">
              <div className="editor-section-header">
                <span>1. Identificação do Produto</span>
              </div>

              {hasTextRole('category') && (
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
                  disabled={imported && !hasTextRole('title')}
                  value={poster.name}
                  maxLength={32}
                  onChange={e => editor.change('name', e.target.value.toUpperCase())}
                />
              </div>

              <div className="editor-field">
                <label>Complemento / Detalhe</label>
                <input
                  className="editor-input"
                  disabled={imported && !hasTextRole('complement')}
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
                  {hasTextRole('packaging') ? (
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

              {editor.posterModel === 'vencimento' ? (
                <div className="editor-field" style={{ marginTop: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#b45309', fontWeight: 700 }}>
                    ⏳ Data de Vencimento do Produto
                  </label>
                  <input
                    className="editor-input"
                    style={{ borderColor: '#f59e0b', background: '#fffbeb', fontWeight: 700 }}
                    value={((editor.document.product as any).validityText as string) || poster.validityText || ''}
                    placeholder="Ex: 02/12 ou 28/10"
                    onChange={e => editor.change('validityText', e.target.value)}
                  />
                  <small style={{ color: '#92400e', fontSize: 11, marginTop: 4, display: 'block' }}>
                    O rodapé oficial ("ITEM PRÓXIMO AO VENCIMENTO" / "NÃO EFETUAMOS A TROCA") será aplicado automaticamente.
                  </small>
                </div>
              ) : (poster.artwork?.priceParts.some(part => part.role === 'validity') || ((editor.document.product as any).validityText)) && (
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

              {resolutionCheck?.isInsufficient && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: '8px 10px',
                    background: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: 6,
                    color: '#b45309',
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  ⚠️ <strong>Aviso de Resolução:</strong> {resolutionCheck.warning}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button
                  type="button"
                  className="editor-btn primary"
                  style={{ justifyContent: 'center', height: 40, fontSize: 13 }}
                  disabled={Boolean(priceWarning)}
                  onClick={() => run(async () => {
                    const p = validPoster();
                    const isExpositor = activeFormat.paper === 'expositor-a3-2x2';

                    // 1. Registra no histórico como 'requested'
                    const entries = addPrintHistoryEntries([{
                      productName: p.name,
                      f7: editor.document.product.productCode ? String(editor.document.product.productCode) : undefined,
                      formatLabel: getFormatLabel(activeFormat),
                      paper: activeFormat.paper,
                      orientation: activeFormat.orientation,
                      copies: isExpositor ? 4 : 1,
                      status: 'requested',
                    }]);
                    const entryIds = entries.map(e => e.id);

                    if (isExpositor) {
                      // Divide o Expositor A3 2×2 em 4 folhas A3 verticais com overlap e marcas
                      const expositorPosters = expandExpositorToA3Posters(p);
                      await handlePrintBatch(expositorPosters, {
                        formatConfig: { paper: 'A3', orientation: 'portrait' },
                        onReadyToPrint: () => {
                          updatePrintHistoryStatus(entryIds, 'sent');
                        },
                        onDialogClosed: () => {
                          setConfirmationModal({
                            entryIds,
                            productName: p.name,
                            formatLabel: 'Expositor A3 2×2 (4 folhas A3)',
                            copies: 4,
                          });
                        },
                      });
                    } else {
                      applyDynamicPrintStyles(activeFormat);
                      try {
                        updatePrintHistoryStatus(entryIds, 'sent');
                        window.print();
                        setConfirmationModal({
                          entryIds,
                          productName: p.name,
                          formatLabel: getFormatLabel(activeFormat),
                          copies: 1,
                        });
                      } finally {
                        removeDynamicPrintStyles();
                      }
                    }
                  })}
                >
                  🖨️ Imprimir {getFormatLabel(activeFormat)}
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
                  item.paperFormat = activeFormat.paper;
                  item.orientation = activeFormat.orientation;
                  item.customWidthMm = activeFormat.customWidthMm;
                  item.customHeightMm = activeFormat.customHeightMm;
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
                Impressão: papel {getFormatLabel(activeFormat)}, escala 100%, margens nenhuma e desative cabeçalhos/rodapés.
              </p>
            </div>
          </section>

          {/* Coluna 2: Hero Preview Proporcional Real */}
          <section className="editor-panel" aria-label="Prévia visual do cartaz">
            <div className="editor-preview-heading">
              <div>
                <h2>Pré-visualização do Cartaz</h2>
                <p>
                  Proporção {getFormatLabel(activeFormat)} · {getFormatDimensionsMm(activeFormat).width} × {getFormatDimensionsMm(activeFormat).height} mm (300 DPI)
                </p>
              </div>
              <span className="status" style={{ fontSize: 11, padding: '4px 10px' }}>
                Documento Editável Local
              </span>
            </div>

            <div className="editor-canvas-wrap">
              <PosterView poster={poster} formatConfig={activeFormat} />
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
    <div hidden={section !== 'offers'} className="library-container"><OfferFolders libraryData={data} run={run} onPrintBatch={handlePrintBatch} onEditPoster={openOfferPoster} onRefreshLibrary={refresh}/></div>
    <div hidden={section !== 'scantech'} className="library-container"><ScantechCreator libraryData={data} run={run} onPrintBatch={handlePrintBatch} onRefreshLibrary={refresh}/></div>
    <div hidden={section !== 'conductor'} className="library-container"><PrintConductor queue={conductorQueue} setQueue={setConductorQueue} libraryData={data} run={run} onPrintBatch={handlePrintBatch}/></div>
    </fieldset>
    </div>
    </div>

    {linkedArtworkEdit && (
      <Suspense fallback={<div className="modal-backdrop" role="status">Carregando ferramentas para editar o PSD…</div>}>
        <EditLinkedPsd
          document={linkedArtworkEdit.document}
          close={() => setLinkedArtworkEdit(null)}
          save={async document => {
            editor.stageDocument(document, linkedArtworkEdit.path);
            setLinkedArtworkEdit(null);
            setMessage('Textos preparados. Edite os campos mapeados e use Salvar Como para preservar o original.');
          }}
        />
      </Suspense>
    )}

    {/* Modal de Formato Personalizado */}
    {showCustomModal && (
      <div className="modal-backdrop">
        <form
          className="panel modal sk-lib-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Configurar Formato Personalizado"
          onSubmit={e => {
            e.preventDefault();
            const w = Math.max(50, Math.min(2000, Number(customWInput) || 148));
            const h = Math.max(50, Math.min(2000, Number(customHInput) || 210));
            handleSelectFormat('custom', customOrientInput, w, h);
            setShowCustomModal(false);
          }}
        >
          <h2>Formato de Papel Personalizado</h2>
          <p style={{ margin: '4px 0 16px', fontSize: 12.5, color: '#64748b' }}>
            Configure as dimensões físicas da folha em milímetros (mm).
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#334155' }}>
              Largura (mm)
              <input
                type="number"
                min={50}
                max={2000}
                required
                className="editor-input"
                style={{ marginTop: 6 }}
                value={customWInput}
                onChange={e => setCustomWInput(e.target.value)}
              />
            </label>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#334155' }}>
              Altura (mm)
              <input
                type="number"
                min={50}
                max={2000}
                required
                className="editor-input"
                style={{ marginTop: 6 }}
                value={customHInput}
                onChange={e => setCustomHInput(e.target.value)}
              />
            </label>
          </div>

          <div style={{ marginTop: 14 }}>
            <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 6 }}>
              Orientação
            </span>
            <div style={{ display: 'flex', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="custom-orient"
                  checked={customOrientInput === 'portrait'}
                  onChange={() => setCustomOrientInput('portrait')}
                />
                Vertical (Retrato)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="custom-orient"
                  checked={customOrientInput === 'landscape'}
                  onChange={() => setCustomOrientInput('landscape')}
                />
                Horizontal (Paisagem)
              </label>
            </div>
          </div>

          <div className="toolbar" style={{ marginTop: 22, justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="editor-btn subtle" onClick={() => setShowCustomModal(false)}>
              Cancelar
            </button>
            <button type="submit" className="editor-btn primary">
              Aplicar Formato
            </button>
          </div>
        </form>
      </div>
    )}

    {/* Modal de Confirmação Manual de Impressão */}
    {confirmationModal && (
      <div className="modal-backdrop">
        <div
          className="panel modal sk-lib-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar Impressão Física"
          style={{ maxWidth: 460 }}
        >
          <h2 style={{ color: '#1e40af', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🖨️</span> Confirmar Saída na Impressora
          </h2>
          <p style={{ margin: '12px 0 16px', fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
            A impressão de <strong>"{confirmationModal.productName}"</strong> ({confirmationModal.formatLabel}) saiu corretamente na impressora física?
          </p>
          <div style={{ background: '#f8fafc', padding: '10px 12px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, color: '#64748b', marginBottom: 18 }}>
            ℹ️ A confirmação manual do operador garante que apenas cartazes efetivamente impressos contem como confirmados no histórico.
          </div>
          <div className="toolbar" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="editor-btn subtle"
              onClick={() => setConfirmationModal(null)}
              title="Registrar apenas como 'Enviada' sem confirmar saída física"
            >
              ✕ Não Confirmar / Falha
            </button>
            <button
              type="button"
              className="editor-btn primary"
              onClick={() => {
                updatePrintHistoryStatus(confirmationModal.entryIds, 'confirmed');
                setConfirmationModal(null);
                setMessage(`Impressão de "${confirmationModal.productName}" confirmada pelo operador.`);
              }}
              title="Confirmar que o papel saiu corretamente da impressora"
            >
              ✓ Sim, Confirmar Impressão
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Modal de Histórico de Impressão */}
    <PrintHistoryModal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} />

    <div className="print-only">
      {batchPrintPosters && batchPrintPosters.length > 0 ? (
        batchPrintPosters.map((p, i) => (
          <div className="print-page" key={i}>
            <PosterView poster={p} isPrint={true} onRendered={handlePosterRendered} />
          </div>
        ))
      ) : (
        <div className="print-page">
          <PosterView poster={poster} isPrint={true} />
        </div>
      )}
    </div>
  </div>;
}
