import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { PosterView, type Poster } from './components/editor/PosterView';
import { SurgicalLayerEditor } from './components/editor/SurgicalLayerEditor';
import { exportPng } from './components/editor/exportPng';
import { Library } from './components/library/Library';
import { useCartaz } from './hooks/useCartaz';
import { listFiles, removeLibraryEntry, upsertLibraryEntry } from './features/cartazes/storage';
import type { Cartaz, Library as LibraryData } from './features/cartazes/types';
import { F7Field } from './components/editor/F7Field';
import { useF7Matches } from './hooks/useF7Matches';
import { formatCentsBr, posterFromDocument } from './features/cartazes/presentation';
import { PriceImport } from './components/importacao/PriceImport';
import { OfferFolders, type BatchEditItem } from './components/ofertas/OfferFolders';
import type { OfferCampaign } from './features/ofertas/types';
import { ScantechCreator } from './components/scantech/ScantechCreator';
import {
  clampPartAdjustment,
  computeHorizontalCenterDx,
  getEditableParts,
  getPartKey,
  hasInvertedPsdPriceParts,
  importedPriceWarning,
  isPriceGroupRole,
  PART_ROLE_LABELS,
  repairInvertedPsdArtwork,
} from './components/editor/importedRenderer';
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
import { priceToCents } from './features/cartazes/validation';
import { isTauri } from '@tauri-apps/api/core';
import { exportDerivedPsdDirect } from './features/scantech/directExport';
import { fetchTemplateBuffer } from './features/psd/templateService';
import { chooseSave } from './features/cartazes/storage';
import { openInPhotoshop } from './features/psd/service';
import { ConfirmModal, type ConfirmDialogRequest } from './components/common/ConfirmModal';
import { ShortcutsModal } from './components/common/ShortcutsModal';
import {
  createDebouncedAsyncSaver,
  INITIAL_ASYNC_SAVE_STATE,
  type AsyncSaveProgress,
  type AsyncSaveState,
  type DebouncedAsyncSaver,
} from './features/cartazes/asyncSave';
import { useMarqueeSelection } from './hooks/useMarqueeSelection';

export { useMarqueeSelection };

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

function getDemoCampaigns(demoLib: LibraryData): OfferCampaign[] {
  const now = new Date().toISOString();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const byName = (needle: string) => demoLib.entries.find(e => !e.folder && e.name.includes(needle));
  const parseId = (content?: string) => {
    try {
      return content ? (JSON.parse(content).id as string) : crypto.randomUUID();
    } catch {
      return crypto.randomUUID();
    }
  };

  const eRepolho = byName('repolho');
  const eCorona = byName('corona');
  const eArroz = byName('arroz');
  const eGuarana = byName('guarana');
  const eTomate = byName('tomate');
  const eFeijao = byName('feijao');

  return [
    {
      schemaVersion: 1,
      id: 'demo-campaign-semana',
      name: 'Ofertas da Semana',
      campaignDate: tomorrow,
      archived: false,
      sourceExcel: null,
      createdAt: now,
      updatedAt: now,
      items: [
        {
          id: 'demo-item-1',
          rowNumber: 2,
          f7: '001245',
          description: 'REPOLHO VERDE KG',
          scheduledPriceCents: 249,
          conflicting: false,
          issues: [],
          posters: eRepolho ? [{ cartazId: parseId(eRepolho.content), cartazPath: eRepolho.path, selected: true, copies: 2, status: 'preparado', printedAt: null }] : [],
        },
        {
          id: 'demo-item-2',
          rowNumber: 3,
          f7: '0025037',
          description: 'CERVEJA CORONA EXTRA LATA 350ML',
          scheduledPriceCents: 399,
          conflicting: false,
          issues: [],
          posters: eCorona ? [{ cartazId: parseId(eCorona.content), cartazPath: eCorona.path, selected: true, copies: 4, status: 'preparado', printedAt: null }] : [],
        },
        {
          id: 'demo-item-3',
          rowNumber: 4,
          f7: '0038340',
          description: 'ARROZ RAMPINELLI TIPO 1 5KG',
          scheduledPriceCents: 1899,
          conflicting: false,
          issues: [],
          posters: eArroz ? [{ cartazId: parseId(eArroz.content), cartazPath: eArroz.path, selected: true, copies: 2, status: 'pendente', printedAt: null }] : [],
        },
        {
          id: 'demo-item-4',
          rowNumber: 5,
          f7: '0029965',
          description: 'GUARANÁ ANTARCTICA TRADICIONAL 3L',
          scheduledPriceCents: 1049,
          conflicting: false,
          issues: [],
          posters: eGuarana ? [{ cartazId: parseId(eGuarana.content), cartazPath: eGuarana.path, selected: true, copies: 3, status: 'preparado', printedAt: null }] : [],
        },
        {
          id: 'demo-item-5',
          rowNumber: 6,
          f7: '0018450',
          description: 'TOMATE ITALIANO MÉDIO KG',
          scheduledPriceCents: 599,
          conflicting: false,
          issues: [],
          posters: eTomate ? [{ cartazId: parseId(eTomate.content), cartazPath: eTomate.path, selected: true, copies: 1, status: 'pendente', printedAt: null }] : [],
        },
        {
          id: 'demo-item-6',
          rowNumber: 7,
          f7: '0015020',
          description: 'FEIJÃO CARIOCA TIPO 1 1KG',
          scheduledPriceCents: 649,
          conflicting: false,
          issues: [],
          posters: eFeijao ? [{ cartazId: parseId(eFeijao.content), cartazPath: eFeijao.path, selected: false, copies: 1, status: 'impresso', printedAt: now }] : [],
        },
      ],
    },
  ];
}

export default function App() {
  const [confirmState, setConfirmState] = useState<{
    request: ConfirmDialogRequest;
    resolve: (value: boolean) => void;
  } | null>(null);
  const confirmAction = useCallback((request: ConfirmDialogRequest) => {
    return new Promise<boolean>(resolve => {
      setConfirmState(prev => {
        if (prev) prev.resolve(false);
        return { request, resolve };
      });
    });
  }, []);
  const resolveConfirm = useCallback((accepted: boolean) => {
    setConfirmState(prev => {
      if (prev) prev.resolve(accepted);
      return null;
    });
  }, []);

  const editor = useCartaz({ confirmAction });
  const editorGuard = { path: editor.path, dirty: editor.dirty };
  const guardRef = useRef(editorGuard);
  guardRef.current = editorGuard;
  const queryParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isDemoMode = queryParams?.get('demo') === '1' || !isTauri();
  const [section, setSection] = useState(() => queryParams?.get('tab') || 'editor');
  const [data, setData] = useState<LibraryData | null>(() => (isDemoMode ? getDemoLibrary() : null));
  const [demoCampaigns] = useState<OfferCampaign[]>(() => (isDemoMode && data ? getDemoCampaigns(data) : []));
  const f7Matches = useF7Matches(editor.document.product.productCode, editor.path, data?.entries);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [conductorQueue, setConductorQueue] = useState<ConductorQueueItem[]>([]);
  const conductorQueueRef = useRef(conductorQueue);
  conductorQueueRef.current = conductorQueue;
  const [batchPrintPosters, setBatchPrintPosters] = useState<Poster[] | null>(null);
  const [batchPrintFormat, setBatchPrintFormat] = useState<PosterFormatConfig | null>(null);
  const [showFormatMenu, setShowFormatMenu] = useState(() => (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('formatMenu') === '1' : false));
  const formatMenuRef = useRef<HTMLDivElement>(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [showCanvasGrid, setShowCanvasGrid] = useState(false);
  const [lockPriceGroup, setLockPriceGroup] = useState(false);
  const [selectedPartKey, setSelectedPartKey] = useState<string | null>(null);
  const [batchEditSession, setBatchEditSession] = useState<{ items: BatchEditItem[]; index: number } | null>(null);
  const [linkedArtworkEdit, setLinkedArtworkEdit] = useState<{ path: string | null; document: Cartaz } | null>(null);
  const [boxPriceDraft, setBoxPriceDraft] = useState<string | null>(null);
  const [librarySelectedPaths, setLibrarySelectedPaths] = useState<Set<string>>(new Set());
  const [offerSelectedItemIds, setOfferSelectedItemIds] = useState<Set<string>>(new Set());
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const savedPref = localStorage.getItem('skalee_autosave_enabled');
      if (savedPref !== null) return savedPref === 'true';
    }
    return true;
  });
  const [asyncSaveState, setAsyncSaveState] = useState<AsyncSaveState>(INITIAL_ASYNC_SAVE_STATE);
  const asyncSaverRef = useRef<DebouncedAsyncSaver | null>(null);
  const saveRequestRef = useRef<{ as: boolean; skipOverwriteConfirm: boolean }>({
    as: false,
    skipOverwriteConfirm: false,
  });
  const [confirmationModal, setConfirmationModal] = useState<{
    entryIds: string[];
    productName: string;
    formatLabel: string;
    copies: number;
  } | null>(null);

  const workspaceMarqueeEnabled =
    (section === 'library' || section === 'offers') &&
    !busy &&
    !confirmState &&
    !showCustomModal &&
    !showHistoryModal &&
    !showShortcutsModal &&
    !linkedArtworkEdit &&
    !confirmationModal;

  const activeWorkspaceSelection =
    section === 'library' ? librarySelectedPaths : offerSelectedItemIds;

  const handleWorkspaceSelectionChange = useCallback(
    (next: Set<string>) => {
      if (section === 'library') {
        setLibrarySelectedPaths(next);
      } else if (section === 'offers') {
        setOfferSelectedItemIds(next);
      }
    },
    [section]
  );

  const {
    marqueeRect: workspaceMarqueeRect,
    isDragging: isWorkspaceMarqueeDragging,
    handleMouseDown: handleWorkspaceMarqueeMouseDown,
  } = useMarqueeSelection({
    containerRef: mainContentRef,
    selectedIds: activeWorkspaceSelection,
    onSelectionChange: handleWorkspaceSelectionChange,
    enabled: workspaceMarqueeEnabled,
  });
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

  useEffect(() => {
    setSelectedPartKey(null);
  }, [editor.document.id, editor.path]);

  useEffect(() => {
    asyncSaverRef.current?.reset();
  }, [editor.document.id]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showShortcutsModal) setShowShortcutsModal(false);
      else if (showFormatMenu) setShowFormatMenu(false);
      else if (showCustomModal) setShowCustomModal(false);
      else if (confirmationModal) setConfirmationModal(null);
      else if (selectedPartKey) setSelectedPartKey(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showShortcutsModal, showFormatMenu, showCustomModal, confirmationModal, selectedPartKey]);

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
  const [isSurgicalOpen, setIsSurgicalOpen] = useState(false);
  const editorQueueItems = conductorQueue.filter(item => item.sourceType === 'editor');
  const poster: Poster = posterFromDocument(editor.document, editor.price);
  const safeEditorUnitCents = (() => {
    try {
      return priceToCents(editor.price);
    } catch {
      return editor.document.product.priceCents;
    }
  })();
  const editorBoxQty = Number(editor.document.product.boxQuantity) || 12;
  const editorBoxPriceDisplay =
    boxPriceDraft !== null
      ? boxPriceDraft
      : formatCentsBr(editor.document.product.boxPriceCents ?? safeEditorUnitCents * editorBoxQty);
  const imported = editor.document.layout.template === 'imported-psd';
  const editableParts = poster.artwork ? getEditableParts(poster.artwork) : [];
  const selectedPart = selectedPartKey
    ? editableParts.find(part => getPartKey(part) === selectedPartKey) ?? null
    : null;
  const selectedPartAdj = selectedPart ? clampPartAdjustment(selectedPart.adjustments) : null;
  const hasAnyPartAdjustment = editableParts.some(part => {
    if (!part.adjustments) return false;
    const adj = clampPartAdjustment(part.adjustments);
    return adj.dx !== 0 || adj.dy !== 0 || adj.scale !== 1;
  });
  const hasTextRole = (role: 'category' | 'title' | 'complement' | 'packaging') =>
    Boolean(poster.artwork?.templateParts?.some(part => part.role === role));
  const invertedLayers = poster.artwork ? hasInvertedPsdPriceParts(poster.artwork) : false;
  const priceWarning = poster.artwork ? (invertedLayers ? 'As camadas de Reais e Centavos estão invertidas nesta arte PSD. Clique em "Corrigir inversão Reais/Centavos" abaixo antes de salvar ou imprimir.' : importedPriceWarning(poster.artwork, poster.price)) : '';
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
      setBatchPrintFormat(null);
      return;
    }

    const effectiveFormat = options?.formatConfig || activeFormat;
    setBatchPrintFormat(effectiveFormat);
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
      setBatchPrintFormat(null);
    }
    removeDynamicPrintStyles();
  };
  const run = (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    action().catch(ex => setError(String(ex))).finally(() => { locked.current = false; setBusy(false); });
  };
  const performSaveInternal = async (opts: {
    as?: boolean;
    skipOverwriteConfirm?: boolean;
    isAutoSave?: boolean;
    onProgress?: (progress: AsyncSaveProgress) => void;
  }) => {
    const saved = await editor.save(Boolean(opts.as), {
      skipOverwriteConfirm: opts.skipOverwriteConfirm,
      isAutoSave: opts.isAutoSave,
      onProgress: opts.onProgress,
    });
    if (saved) {
      if (!opts.isAutoSave) {
        setMessage('Cartaz salvo no computador.');
      }
      // Incremental in-memory update avoids re-scanning 3,000+ files from disk on every save.
      setData(prev => upsertLibraryEntry(prev, saved.path, saved.document));
      return true;
    }
    return false;
  };
  const performSaveRef = useRef(performSaveInternal);
  performSaveRef.current = performSaveInternal;

  useEffect(() => {
    const saver = createDebouncedAsyncSaver({
      debounceMs: 900,
      performSave: ({ reason, onProgress }) => {
        const isAutoSave = reason === 'auto';
        const req = saveRequestRef.current;
        return performSaveRef.current({
          as: isAutoSave ? false : req.as,
          skipOverwriteConfirm: isAutoSave ? true : req.skipOverwriteConfirm,
          isAutoSave,
          onProgress,
        });
      },
      onStateChange: next => {
        setAsyncSaveState(next);
      },
    });
    asyncSaverRef.current = saver;
    return () => {
      saver.dispose();
      asyncSaverRef.current = null;
    };
  }, []);

  // Debounced auto-save for already-saved documents so edits persist smoothly without freezing the editor
  useEffect(() => {
    const saver = asyncSaverRef.current;
    if (!saver) return;
    if (!autoSaveEnabled || !editor.dirty || !editor.path || Boolean(priceWarning)) {
      if (!editor.dirty) saver.cancel();
      return;
    }
    if (!editor.document.product.name.trim()) return;
    try {
      priceToCents(editor.price);
    } catch {
      return;
    }
    saver.schedule();
  }, [
    autoSaveEnabled,
    editor.revision,
    editor.dirty,
    editor.path,
    editor.price,
    editor.document.product.name,
    priceWarning,
  ]);

  const newDocument = async () => {
    asyncSaverRef.current?.reset();
    if (await editor.newDocument()) setSection('editor');
  };
  const open = async (path?: string) => {
    asyncSaverRef.current?.reset();
    if (await editor.open(path)) { setSection('editor'); setMessage('Cartaz aberto.'); }
  };
  const openOfferPoster = async (path: string, scheduledPriceCents?: number) => {
    asyncSaverRef.current?.reset();
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

  // Non-blocking manual save: uses the async save pipeline so the editor stays responsive while writing
  const save = async (as = false, skipOverwriteConfirm = false) => {
    setError('');
    const saver = asyncSaverRef.current;
    if (!saver) {
      try {
        return await performSaveInternal({ as, skipOverwriteConfirm, isAutoSave: false });
      } catch (ex) {
        setError(String(ex));
        return false;
      }
    }
    saveRequestRef.current = { as, skipOverwriteConfirm };
    try {
      const ok = await saver.flush('manual');
      const finalState = saver.getState();
      if (!ok && finalState.phase === 'error' && finalState.error) {
        setError(finalState.error);
      }
      return ok;
    } finally {
      saveRequestRef.current = { as: false, skipOverwriteConfirm: false };
    }
  };

  const startBatchEdit = async (items: BatchEditItem[]) => {
    if (items.length === 0) return;
    setBatchEditSession({ items, index: 0 });
    await openOfferPoster(items[0].path, items[0].scheduledPriceCents);
    setMessage(`Edição em lote iniciada (1 de ${items.length}): ${items[0].description}`);
  };

  const navigateBatchEdit = async (nextIndex: number, saveCurrentFirst: boolean) => {
    if (!batchEditSession) return;
    if (saveCurrentFirst && editor.dirty) {
      const ok = await save(false, true);
      if (!ok) return;
    }
    if (nextIndex < 0) return;
    if (nextIndex >= batchEditSession.items.length) {
      setBatchEditSession(null);
      setMessage('Edição em lote concluída! Todos os produtos selecionados foram revisados.');
      return;
    }
    const target = batchEditSession.items[nextIndex];
    setBatchEditSession({ ...batchEditSession, index: nextIndex });
    await openOfferPoster(target.path, target.scheduledPriceCents);
    setMessage(`Lote ${nextIndex + 1} de ${batchEditSession.items.length}: ${target.description}`);
  };

  const validPoster = () => { const d = editor.current(); if (!d.product.name.trim()) throw new Error('Informe o nome do produto.'); return posterFromDocument(d); };

  const printActivePoster = async () => {
    const p = validPoster();
    const isExpositor = activeFormat.paper === 'expositor-a3-2x2';

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
      await handlePrintBatch([p], {
        formatConfig: activeFormat,
        onReadyToPrint: () => {
          updatePrintHistoryStatus(entryIds, 'sent');
        },
        onDialogClosed: () => {
          setConfirmationModal({
            entryIds,
            productName: p.name,
            formatLabel: getFormatLabel(activeFormat),
            copies: 1,
          });
        },
      });
    }
  };

  // Global & Editor operator keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (confirmState || showCustomModal || showHistoryModal || Boolean(linkedArtworkEdit)) {
        return;
      }

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTextField = tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);

      if (!isTextField && e.key === '?') {
        e.preventDefault();
        setShowShortcutsModal(prev => !prev);
        return;
      }

      if (showShortcutsModal) return;

      if (section === 'editor' && !isSurgicalOpen) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save(false, false);
          return;
        }
        if (e.altKey && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          if (!priceWarning) {
            run(printActivePoster);
          }
          return;
        }
        if (batchEditSession && e.altKey && e.key === 'ArrowRight') {
          e.preventDefault();
          run(() => navigateBatchEdit(batchEditSession.index + 1, true));
          return;
        }
        if (batchEditSession && e.altKey && e.key === 'ArrowLeft') {
          e.preventDefault();
          run(() => navigateBatchEdit(batchEditSession.index - 1, false));
          return;
        }

        if (!isTextField && imported) {
          if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'g') {
            e.preventDefault();
            setShowCanvasGrid(prev => !prev);
            return;
          }
          if (selectedPartKey && selectedPart && selectedPartAdj) {
            const applySelectedOrGroupAdjustment = (nextDx: number, nextDy: number, nextScale: number) => {
              if (lockPriceGroup && isPriceGroupRole(selectedPart.role)) {
                const deltaDx = nextDx - selectedPartAdj.dx;
                const deltaDy = nextDy - selectedPartAdj.dy;
                const scaleRatio = selectedPartAdj.scale > 0 ? nextScale / selectedPartAdj.scale : 1;
                const batch: Record<string, { dx: number; dy: number; scale: number }> = {};
                for (const p of editableParts) {
                  if (isPriceGroupRole(p.role)) {
                    const cur = clampPartAdjustment(p.adjustments);
                    batch[getPartKey(p)] = clampPartAdjustment({
                      dx: cur.dx + deltaDx,
                      dy: cur.dy + deltaDy,
                      scale: Number((cur.scale * scaleRatio).toFixed(2)),
                    });
                  }
                }
                editor.updateMultiplePartAdjustments(batch);
              } else {
                editor.updatePartAdjustment(selectedPartKey, { dx: nextDx, dy: nextDy, scale: nextScale });
              }
            };
            const step = e.shiftKey ? 10 : 2;
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              applySelectedOrGroupAdjustment(selectedPartAdj.dx, selectedPartAdj.dy - step, selectedPartAdj.scale);
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              applySelectedOrGroupAdjustment(selectedPartAdj.dx, selectedPartAdj.dy + step, selectedPartAdj.scale);
              return;
            }
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              applySelectedOrGroupAdjustment(selectedPartAdj.dx - step, selectedPartAdj.dy, selectedPartAdj.scale);
              return;
            }
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              applySelectedOrGroupAdjustment(selectedPartAdj.dx + step, selectedPartAdj.dy, selectedPartAdj.scale);
              return;
            }
            if (e.key === '+' || e.key === '=') {
              e.preventDefault();
              applySelectedOrGroupAdjustment(
                selectedPartAdj.dx,
                selectedPartAdj.dy,
                Number(Math.min(2.5, selectedPartAdj.scale + 0.05).toFixed(2))
              );
              return;
            }
            if (e.key === '-' || e.key === '_') {
              e.preventDefault();
              applySelectedOrGroupAdjustment(
                selectedPartAdj.dx,
                selectedPartAdj.dy,
                Number(Math.max(0.4, selectedPartAdj.scale - 0.05).toFixed(2))
              );
              return;
            }
            if (e.key === 'Delete') {
              e.preventDefault();
              if (lockPriceGroup && isPriceGroupRole(selectedPart.role)) {
                const batch: Record<string, null> = {};
                for (const p of editableParts) {
                  if (isPriceGroupRole(p.role)) batch[getPartKey(p)] = null;
                }
                editor.updateMultiplePartAdjustments(batch);
              } else {
                editor.resetPartAdjustments(selectedPartKey);
              }
              return;
            }
          }
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    section,
    isSurgicalOpen,
    imported,
    lockPriceGroup,
    editableParts,
    selectedPart,
    selectedPartKey,
    selectedPartAdj,
    batchEditSession,
    priceWarning,
    confirmState,
    showShortcutsModal,
    showCustomModal,
    showHistoryModal,
    linkedArtworkEdit,
    editor,
    activeFormat,
  ]);

  const handleExportOrOpenPsd = async (openPhotoshop = false) => {
    const p = validPoster();
    const d = editor.current();
    const cleanName = (p.name || 'cartaz').replace(/[/\\?%*:|"<>]/g, '').trim() || 'cartaz';
    const suggestedName = `${cleanName}.psd`;

    let chosenPath: string | null = null;
    if (editor.path && !openPhotoshop) {
      chosenPath = editor.path.replace(/\.skcartaz$/i, '.psd');
    }

    if (isTauri() && !chosenPath) {
      chosenPath = await chooseSave(suggestedName);
      if (!chosenPath) return;
      if (!chosenPath.toLowerCase().endsWith('.psd')) {
        chosenPath = chosenPath.replace(/\.[^.]+$/, '') + '.psd';
      }
    }

    const wholeVal = formatCentsBr(d.product.priceCents).split(',')[0];
    const fractionVal = formatCentsBr(d.product.priceCents).split(',')[1];
    const boxWholeVal = d.product.hasBoxPrice && d.product.boxPriceCents
      ? formatCentsBr(d.product.boxPriceCents).split(',')[0]
      : undefined;
    const boxFractionVal = d.product.hasBoxPrice && d.product.boxPriceCents
      ? formatCentsBr(d.product.boxPriceCents).split(',')[1]
      : undefined;

    let sourcePath = d.layout.template === 'imported-psd' ? d.layout.artwork.source.sourcePath : undefined;
    let sourceBuffer: ArrayBuffer | undefined;
    const isCaixaMode = Boolean(d.product.hasBoxPrice);
    const hasExistingCaixaLayers = d.layout.template === 'imported-psd' &&
      d.layout.artwork.layers.some(l => /caixa\s*com/i.test(l.name || l.text || ''));

    if (isCaixaMode && !hasExistingCaixaLayers) {
      sourceBuffer = await fetchTemplateBuffer('caixa');
      sourcePath = undefined;
    } else if (!sourcePath || sourcePath.startsWith('/templates/')) {
      sourceBuffer = await fetchTemplateBuffer(editor.posterModel);
      sourcePath = undefined;
    }

    const artwork = d.layout.template === 'imported-psd' ? d.layout.artwork : undefined;
    const wholePart = artwork?.priceParts?.find(part => part.role === 'whole');
    const fractionPart = artwork?.priceParts?.find(part => part.role === 'fraction');
    const catPart = artwork?.templateParts?.find(part => part.role === 'category');
    const titlePart = artwork?.templateParts?.find(part => part.role === 'title');
    const compPart = artwork?.templateParts?.find(part => part.role === 'complement');
    const packPart = artwork?.templateParts?.find(part => part.role === 'packaging');
    const valPart = artwork?.priceParts?.find(part => part.role === 'validity');

    const expResult = await exportDerivedPsdDirect({
      sourcePsdPath: sourcePath || undefined,
      sourcePsdBuffer: sourceBuffer,
      outputPsdPath: chosenPath || suggestedName,
      allowSamePath: true,
      category: d.product.category,
      title: d.product.name,
      complement: d.product.complement,
      packaging: d.product.unit,
      whole: wholeVal,
      fraction: fractionVal,
      validityText: d.product.validityText,
      hasBoxPrice: Boolean(d.product.hasBoxPrice),
      boxQuantity: Number(d.product.boxQuantity) || 12,
      boxUnitLabel: d.product.boxUnitLabel || 'UND.',
      boxWhole: boxWholeVal,
      boxFraction: boxFractionVal,
      boxPackageType: d.product.boxPackageType,
      boxPackageLabel: d.product.boxPackageLabel,
      unitBadgeMode: d.product.unitBadgeMode,
      productImage: d.product.productImage,
      roles: {
        wholeLayerId: wholePart?.layerId,
        fractionLayerId: fractionPart?.layerId,
        categoryLayerId: catPart?.layerId,
        titleLayerId: titlePart?.layerId,
        complementLayerId: compPart?.layerId,
        packagingLayerId: packPart?.layerId,
        validityLayerId: valPart?.layerId,
      },
    });

    if (expResult.ok) {
      const finalPsdPath = chosenPath || suggestedName;
      if (!isTauri() && expResult.bytes) {
        const blob = new Blob([expResult.bytes], { type: 'image/vnd.adobe.photoshop' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        a.click();
        URL.revokeObjectURL(url);
      }
      if (openPhotoshop && isTauri()) {
        try {
          await openInPhotoshop(finalPsdPath);
          setMessage(`PSD gerado e aberto no Photoshop: ${finalPsdPath}`);
        } catch (e) {
          setMessage(`PSD gerado: ${finalPsdPath} (não foi possível abrir no Photoshop automaticamente).`);
        }
      } else {
        setMessage(`PSD editável exportado com sucesso: ${finalPsdPath}`);
      }
    } else {
      throw new Error(expResult.error || 'Falha ao exportar PSD editável.');
    }
  };
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
            <span>Formato: <strong className="sk-tabular">{getFormatLabel(activeFormat)}</strong></span>
            {printerSheetA4 && (activeFormat.paper === 'A5' || activeFormat.paper === 'A6') && (
              <span
                className="sk-format-sheet-tag"
                title="Folha física da impressora travada em A4 com arte centralizada no topo"
              >
                · Folha A4 Topo
              </span>
            )}
            <span className="sk-format-caret" aria-hidden="true">▾</span>
          </button>

          {showFormatMenu && (
            <div className="sk-format-dropdown" role="listbox" aria-label="Formatos oficiais do Skalee Cartaz">
              <div className="sk-format-dropdown-heading">Formatos Oficiais</div>

              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A6' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A6', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A6'}
              >
                <span className="sk-tabular">A6 Vertical (105 × 148 mm)</span>
                {activeFormat.paper === 'A6' && <span className="sk-format-active-label">Ativo</span>}
              </button>

              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A5' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A5', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A5'}
              >
                <span className="sk-tabular">A5 Vertical (148 × 210 mm)</span>
                {activeFormat.paper === 'A5' && <span className="sk-format-active-label">Ativo</span>}
              </button>

              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A4' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A4', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A4'}
              >
                <span className="sk-tabular">A4 Vertical (210 × 297 mm)</span>
                {activeFormat.paper === 'A4' && <span className="sk-format-active-label">Ativo</span>}
              </button>

              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'A3' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('A3', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'A3'}
              >
                <span className="sk-tabular">A3 Vertical (297 × 420 mm)</span>
                {activeFormat.paper === 'A3' && <span className="sk-format-active-label">Ativo</span>}
              </button>

              <button
                type="button"
                className={`sk-format-option ${activeFormat.paper === 'expositor-a3-2x2' ? 'active' : ''}`}
                onClick={() => handleSelectFormat('expositor-a3-2x2', 'portrait')}
                role="option"
                aria-selected={activeFormat.paper === 'expositor-a3-2x2'}
                title="Uma arte distribuída em 4 folhas A3 verticais (2 colunas × 2 linhas)"
              >
                <div>
                  <div className="sk-tabular">Expositor A3 2×2 (594 × 840 mm)</div>
                  <div className="sk-format-option-sub">4 folhas A3 em 2 colunas × 2 linhas</div>
                </div>
                {activeFormat.paper === 'expositor-a3-2x2' && <span className="sk-format-active-label">Ativo</span>}
              </button>

              <div className="sk-format-dropdown-heading" style={{ marginTop: 8 }}>Segurança da Impressora</div>
              <label className={`sk-format-sheet-card ${printerSheetA4 ? 'is-checked' : ''}`}>
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
                />
                <div className="sk-format-sheet-copy">
                  <strong>Folha física sempre A4 (Topo Central)</strong>
                  <span>Trava a saída física em A4. Cartazes A5 e A6 saem no topo central sem desconfigurar a impressora.</span>
                </div>
              </label>

              <div className="sk-format-dropdown-heading" style={{ marginTop: 6 }}>Opção Adicional</div>

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
                {activeFormat.paper === 'custom' && <span className="sk-format-active-label">Ativo</span>}
              </button>
            </div>
          )}
        </div>

        {/* Botão de Atalhos do Operador */}
        <button
          type="button"
          className="editor-btn subtle"
          onClick={() => setShowShortcutsModal(true)}
          title="Ver atalhos rápidos de teclado (?)"
        >
          Atalhos (?)
        </button>

        {/* Botão de Histórico de Impressão */}
        <button
          type="button"
          className="editor-btn subtle"
          onClick={() => setShowHistoryModal(true)}
          title="Consultar histórico local e persistente de impressões"
        >
          Histórico
        </button>

        {/* Alternador de Modo Escuro / Claro */}
        <button
          type="button"
          className="sk-theme-btn"
          onClick={() => setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Alternar para Modo Claro' : 'Alternar para Modo Escuro'}
          aria-label={theme === 'dark' ? 'Alternar para Modo Claro' : 'Alternar para Modo Escuro'}
        >
          <span>{theme === 'dark' ? 'Modo Claro' : 'Modo Escuro'}</span>
        </button>
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
            onClick={() => { setSection('library'); if (!data) run(refresh); }}
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
            onClick={() => { setSection('offers'); if (!data) run(refresh); }}
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
            onClick={() => { setSection('scantech'); if (!data) run(refresh); }}
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
            onClick={() => { setSection('conductor'); if (!data) run(refresh); }}
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

      <div
        ref={mainContentRef}
        className={`sk-main-content sk-marquee-surface ${isWorkspaceMarqueeDragging ? 'is-marquee-dragging' : ''}`}
        role="main"
        onMouseDown={handleWorkspaceMarqueeMouseDown}
      >
        <div className="notifications" aria-live="polite">
          {busy && <p role="status">Aguarde…</p>}
          {message && <p className="success" role="status">{message}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>

        <fieldset className="workspace" disabled={busy} aria-busy={busy}>
    {section === 'editor' ? (
      <div className="editor-workspace-wrap">
        {batchEditSession && (
          <div className="sk-batch-bar" role="region" aria-label="Navegação da edição em lote">
            <div className="sk-batch-bar-info">
              <span className="sk-batch-counter sk-tabular">
                Lote {batchEditSession.index + 1} / {batchEditSession.items.length}
              </span>
              <strong>{batchEditSession.items[batchEditSession.index]?.description}</strong>
              {batchEditSession.items[batchEditSession.index]?.f7 && (
                <span className="sk-batch-f7 sk-tabular">
                  F7 {batchEditSession.items[batchEditSession.index].f7}
                </span>
              )}
            </div>
            <div className="sk-batch-bar-actions">
              <button
                type="button"
                className="editor-btn subtle"
                disabled={batchEditSession.index === 0}
                onClick={() => run(() => navigateBatchEdit(batchEditSession.index - 1, false))}
                title="Voltar ao produto anterior (Alt+←)"
              >
                ← Anterior
              </button>
              <button
                type="button"
                className="editor-btn subtle"
                onClick={() => run(() => navigateBatchEdit(batchEditSession.index + 1, false))}
                title="Ir para o próximo sem salvar alterações"
              >
                Pular
              </button>
              <button
                type="button"
                className="editor-btn primary"
                onClick={() => run(() => navigateBatchEdit(batchEditSession.index + 1, true))}
                title="Salvar este cartaz e abrir o próximo (Alt+→)"
              >
                {batchEditSession.index + 1 < batchEditSession.items.length
                  ? 'Salvar e Próximo (Alt+→)'
                  : 'Salvar e Concluir'}
              </button>
              <button
                type="button"
                className="editor-btn subtle"
                onClick={() => setBatchEditSession(null)}
                title="Sair do modo de edição em sequência"
              >
                Encerrar
              </button>
            </div>
          </div>
        )}

        {/* Barra de Ações do Documento (Ciclo de vida enxuto + salvamento assíncrono não bloqueante) */}
        <div className="editor-document-bar">
          <div className="editor-toolbar">
            <button type="button" className="editor-btn subtle" onClick={() => run(async () => { await editor.newOfficial('oferta'); })}>
              + Oferta
            </button>
            <button type="button" className="editor-btn subtle sk-btn-tint-green" onClick={() => run(async () => { await editor.newOfficial('caixa'); })}>
              + Caixa
            </button>
            <button type="button" className="editor-btn subtle sk-btn-tint-amber" onClick={() => run(async () => { await editor.newOfficial('vencimento'); })}>
              + Vencimento
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
              Novo de PSD
            </button>
            <span className="sk-toolbar-divider" aria-hidden="true" />
            <button type="button" className="editor-btn subtle" onClick={() => run(() => open())}>
              Abrir
            </button>
            <button
              type="button"
              className="editor-btn primary"
              onClick={() => { void save(false, false); }}
              title="Salvar cartaz sem travar o editor (Ctrl+S)"
            >
              {asyncSaveState.phase === 'saving' ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              type="button"
              className="editor-btn subtle"
              onClick={() => { void save(true, false); }}
              title="Salvar uma cópia com outro nome"
            >
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

          <div className="sk-save-status-cluster">
            <label
              className="sk-autosave-toggle"
              title="Salva alterações automaticamente após uma breve pausa na edição (somente para cartazes já salvos)"
            >
              <input
                type="checkbox"
                checked={autoSaveEnabled}
                onChange={e => {
                  const checked = e.target.checked;
                  setAutoSaveEnabled(checked);
                  if (!checked) asyncSaverRef.current?.cancel();
                  if (typeof window !== 'undefined') {
                    try {
                      localStorage.setItem('skalee_autosave_enabled', String(checked));
                    } catch {}
                  }
                }}
              />
              <span>Auto-salvar</span>
            </label>

            <div
              className={`sk-doc-status ${
                asyncSaveState.phase === 'saving'
                  ? 'is-saving'
                  : asyncSaveState.phase === 'scheduled'
                  ? 'is-scheduled'
                  : asyncSaveState.phase === 'error'
                  ? 'is-error'
                  : editor.dirty
                  ? 'is-dirty'
                  : 'is-saved'
              }`}
              role="status"
              aria-live="polite"
              title={
                asyncSaveState.phase === 'error'
                  ? asyncSaveState.error ?? 'Erro ao salvar'
                  : asyncSaveState.phase === 'saving' || asyncSaveState.phase === 'scheduled'
                  ? asyncSaveState.stage
                  : editor.path ?? 'Cartaz novo — ainda não salvo'
              }
            >
              {asyncSaveState.phase === 'saving' ? (
                <>
                  <span className="sk-save-spinner" aria-hidden="true" />
                  <span className="sk-tabular">
                    {asyncSaveState.stage || 'Salvando…'} {asyncSaveState.percent}%
                  </span>
                </>
              ) : asyncSaveState.phase === 'scheduled' ? (
                <span>Salvando em instantes…</span>
              ) : asyncSaveState.phase === 'error' ? (
                <>
                  <span>Falha ao salvar</span>
                  <button
                    type="button"
                    className="sk-save-retry-btn"
                    onClick={() => { void save(false, true); }}
                  >
                    Tentar novamente
                  </button>
                </>
              ) : editor.dirty ? (
                <span>Alterações não salvas</span>
              ) : (
                <span className="sk-tabular">
                  {asyncSaveState.lastSavedAt
                    ? `Salvo às ${new Date(asyncSaveState.lastSavedAt).toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    : 'Salvo no computador'}
                </span>
              )}
              <span aria-hidden="true">·</span>
              <span className="sk-doc-filename">{editor.path ? editor.path.split(/[\\/]/).pop() : 'Novo cartaz'}</span>
            </div>
          </div>

          {(asyncSaveState.phase === 'saving' || asyncSaveState.phase === 'scheduled') && (
            <div
              className={`sk-doc-progress-track ${asyncSaveState.phase === 'scheduled' ? 'is-scheduled' : ''}`}
              role="progressbar"
              aria-label={asyncSaveState.stage || 'Progresso do salvamento'}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={asyncSaveState.percent}
            >
              <div
                className="sk-doc-progress-fill"
                style={{ width: `${Math.max(8, asyncSaveState.percent)}%` }}
              />
            </div>
          )}
        </div>

        {/* Layout Principal: Propriedades + Prévia Proporcional OU Editor Cirúrgico */}
        {isSurgicalOpen ? (
          <SurgicalLayerEditor
            document={editor.document}
            price={editor.price}
            activeFormat={activeFormat}
            onChangeField={editor.change}
            onExportPsd={handleExportOrOpenPsd}
            onSwitchModel={editor.switchModel}
            onClose={() => setIsSurgicalOpen(false)}
            isBusy={busy}
          />
        ) : (
          <div className="editor-layout">
          {/* Coluna 1: Painel de Propriedades Organizado */}
          <section className="editor-panel" aria-label="Propriedades da oferta">
            <div className="sk-editor-panel-head">
              <h2>Editar Oferta</h2>
              <p>Preencha os campos abaixo para atualizar instantaneamente o cartaz.</p>
            </div>

            {/* SELETOR DE MODELO DE LAYOUT */}
            <div className="sk-model-switcher">
              <div className="sk-model-switcher-head">
                <span className="sk-model-switcher-title">Modelo de Layout</span>
                <span className={`sk-model-active-text is-${editor.posterModel}`}>
                  {editor.posterModel === 'vencimento'
                    ? 'Vencimento'
                    : editor.posterModel === 'caixa'
                    ? 'Caixa Fechada'
                    : 'Oferta Normal'}
                </span>
              </div>
              <div className="sk-model-grid">
                <button
                  type="button"
                  className={`sk-model-btn ${editor.posterModel === 'oferta' ? 'active is-oferta' : ''}`}
                  onClick={() => run(async () => {
                    if (editor.posterModel !== 'oferta') {
                      await editor.switchModel('oferta');
                      setMessage('Modelo alterado para Oferta Normal.');
                    }
                  })}
                >
                  Oferta
                </button>
                <button
                  type="button"
                  className={`sk-model-btn ${editor.posterModel === 'caixa' ? 'active is-caixa' : ''}`}
                  onClick={() => run(async () => {
                    if (editor.posterModel !== 'caixa') {
                      await editor.switchModel('caixa');
                      setMessage('Modelo alterado para Caixa Fechada / Atacado.');
                    }
                  })}
                >
                  Caixa
                </button>
                <button
                  type="button"
                  className={`sk-model-btn ${editor.posterModel === 'vencimento' ? 'active is-vencimento' : ''}`}
                  onClick={() => run(async () => {
                    if (editor.posterModel !== 'vencimento') {
                      await editor.switchModel('vencimento');
                      setMessage('Modelo alterado para Próximo ao Vencimento.');
                    }
                  })}
                >
                  Vencimento
                </button>
              </div>
            </div>

            {imported && !poster.artwork?.isReferenceTemplate && (
              <div className="sk-warn-banner">
                Arte PSD legada: os textos ainda não estão preparados para edição.
              </div>
            )}

            {poster.artwork?.isReferenceTemplate && (
              <div className="sk-info-banner">
                Modelo PSD ativo: somente os campos de texto mapeados são editáveis.
              </div>
            )}

            {imported && (
              <button
                type="button"
                className="editor-btn subtle sk-full-width-btn"
                style={{ marginBottom: 10 }}
                onClick={() => run(async () => setLinkedArtworkEdit({ path: editor.path, document: editor.current() }))}
              >
                Preparar textos do PSD para edição
              </button>
            )}

            <button
              type="button"
              className="editor-btn sk-btn-surgical"
              title="Abre o painel de padronização de arte e edição cirúrgica de camadas PSD"
              onClick={() => setIsSurgicalOpen(true)}
            >
              Editor de Camadas Cirúrgicas (PSD)
            </button>

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
                    value={editor.document.product.category || poster.category || ''}
                    maxLength={100}
                    onChange={e => editor.change('category', e.target.value.toUpperCase())}
                  />
                </div>
              )}

              <div className="editor-field">
                <label>Nome Principal</label>
                <input
                  className="editor-input sk-input-strong"
                  disabled={imported && !hasTextRole('title')}
                  value={poster.name}
                  maxLength={100}
                  onChange={e => editor.change('name', e.target.value.toUpperCase())}
                />
              </div>

              <div className="editor-field">
                <label>Complemento / Detalhe</label>
                <input
                  className="editor-input"
                  disabled={imported && !hasTextRole('complement')}
                  value={poster.detail}
                  maxLength={100}
                  onChange={e => editor.change('complement', e.target.value.toUpperCase())}
                />
              </div>
            </div>

            {/* SEÇÃO 2: Preço & Embalagem */}
            <div className="editor-section">
              <div className="editor-section-header">
                <span>2. Preço & Embalagem</span>
              </div>

              <div className="sk-two-col-grid">
                <div className="editor-field">
                  <label>Preço (R$)</label>
                  <input
                    className="editor-input price-input sk-tabular"
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
                <div className="sk-validity-section">
                  <div className="sk-two-col-grid sk-validity-grid">
                    <div className="editor-field">
                      <label htmlFor="sk-validity-date">Data de Vencimento</label>
                      <input
                        id="sk-validity-date"
                        className="editor-input sk-validity-input sk-tabular"
                        value={editor.document.product.validityText || poster.validityText || ''}
                        placeholder="Ex: 02/12 ou 28/10"
                        onChange={e => editor.change('validityText', e.target.value)}
                      />
                    </div>
                    <div className="editor-field">
                      <label>Rodapé Oficial</label>
                      <div className="sk-validity-status-row" aria-live="polite">
                        <span>Aplicado automaticamente</span>
                      </div>
                    </div>
                  </div>
                  <dl className="sk-validity-list">
                    <div className="sk-validity-list-row">
                      <dt>Aviso</dt>
                      <dd>Item próximo ao vencimento</dd>
                    </div>
                    <div className="sk-validity-list-row">
                      <dt>Condição</dt>
                      <dd>Não efetuamos a troca</dd>
                    </div>
                  </dl>
                </div>
              ) : (poster.artwork?.priceParts.some(part => part.role === 'validity') || editor.document.product.validityText) && (
                <div className="editor-field sk-validity-fallback">
                  <label htmlFor="sk-offer-validity">Validade da Oferta</label>
                  <input
                    id="sk-offer-validity"
                    className="editor-input sk-tabular"
                    value={editor.document.product.validityText || poster.validityText || ''}
                    placeholder="Ex: 08/11/2026 ou OFERTA VÁLIDA ATÉ 25/10"
                    onChange={e => editor.change('validityText', e.target.value)}
                  />
                </div>
              )}

              {/* MÓDULO OPCIONAL: Caixa Fechada / Atacado (Preço Duplo) — indisponível no modo Vencimento */}
              {editor.posterModel !== 'vencimento' && (
              <div className={`sk-box-module ${editor.document.product.hasBoxPrice ? 'is-active' : ''}`}>
                <label className="sk-box-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(editor.document.product.hasBoxPrice)}
                    onChange={async e => {
                      const checked = e.target.checked;
                      editor.change('hasBoxPrice', checked);
                      setBoxPriceDraft(null);
                      if (checked) {
                        editor.change('boxQuantity', editorBoxQty);
                        editor.change('boxUnitLabel', editor.document.product.boxUnitLabel || 'UND.');
                        if (!editor.document.product.boxPriceCents) {
                          editor.change('boxPriceCents', safeEditorUnitCents * editorBoxQty);
                        }
                        if (editor.posterModel !== 'caixa') {
                          await editor.switchModel('caixa');
                          setMessage('Layout ajustado automaticamente para Caixa Fechada.');
                        }
                      } else if (editor.posterModel === 'caixa') {
                        await editor.switchModel('oferta');
                        setMessage('Layout retornado para Oferta Normal.');
                      }
                    }}
                  />
                  <span>Ativar Caixa Fechada (Atacado / Combo)</span>
                </label>

                {Boolean(editor.document.product.hasBoxPrice) && (
                  <div className="sk-box-grid">
                    <div>
                      <label className="sk-mini-label">Qtd. Caixa</label>
                      <input
                        type="number"
                        className="editor-input sk-input-compact sk-tabular"
                        min={1}
                        value={editorBoxQty}
                        onChange={e => {
                          const qty = Math.max(1, parseInt(e.target.value, 10) || 1);
                          setBoxPriceDraft(null);
                          editor.change('boxQuantity', qty);
                        }}
                      />
                    </div>
                    <div>
                      <label className="sk-mini-label">Rótulo</label>
                      <input
                        className="editor-input sk-input-compact"
                        value={editor.document.product.boxUnitLabel || 'UND.'}
                        onChange={e => editor.change('boxUnitLabel', e.target.value.toUpperCase())}
                      />
                    </div>
                    <div>
                      <label className="sk-mini-label">Preço Total (R$)</label>
                      <input
                        className="editor-input price-input sk-input-compact sk-tabular"
                        inputMode="decimal"
                        value={editorBoxPriceDisplay}
                        onChange={e => {
                          const raw = e.target.value;
                          setBoxPriceDraft(raw);
                          try {
                            editor.change('boxPriceCents', priceToCents(raw));
                          } catch {
                            // Permite digitação parcial sem erro (ex: "32,")
                          }
                        }}
                        onBlur={() => setBoxPriceDraft(null)}
                      />
                    </div>
                    <div>
                      <button
                        type="button"
                        className="editor-btn subtle sk-btn-calc"
                        title="Recalcular = Preço unitário × Quantidade"
                        onClick={() => {
                          setBoxPriceDraft(null);
                          editor.change('boxPriceCents', safeEditorUnitCents * editorBoxQty);
                        }}
                      >
                        Calcular
                      </button>
                    </div>
                  </div>
                )}
              </div>
              )}

              {priceWarning && (
                <p className="error-text sk-inline-alert" role="alert">
                  {priceWarning}
                </p>
              )}

              {invertedLayers && (
                <button
                  type="button"
                  className="editor-btn subtle sk-full-width-btn"
                  style={{ marginTop: 10 }}
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
                <div className="sk-warn-banner">
                  <strong>Aviso de Resolução:</strong> {resolutionCheck.warning}
                </div>
              )}

              <div className="sk-two-col-grid">
                <button
                  type="button"
                  className="editor-btn primary sk-action-primary"
                  disabled={Boolean(priceWarning)}
                  title="Imprimir cartaz atual (Alt+P)"
                  onClick={() => run(printActivePoster)}
                >
                  Imprimir {activeFormat.paper === 'expositor-a3-2x2' ? 'Expositor 2×2' : activeFormat.paper}
                </button>

                <button
                  type="button"
                  className="editor-btn secondary sk-action-secondary"
                  disabled={Boolean(priceWarning)}
                  onClick={() => run(async () => exportPng(validPoster(), activeFormat))}
                >
                  Exportar PNG 300 DPI
                </button>
              </div>

              <div className={isTauri() ? 'sk-two-col-grid sk-mt-10' : 'sk-mt-10'}>
                <button
                  type="button"
                  className="editor-btn subtle sk-btn-psd"
                  disabled={Boolean(priceWarning)}
                  onClick={() => run(() => handleExportOrOpenPsd(false))}
                >
                  Exportar PSD (.psd)
                </button>
                {isTauri() && (
                  <button
                    type="button"
                    className="editor-btn subtle sk-btn-photoshop"
                    disabled={Boolean(priceWarning)}
                    title="Gera o arquivo PSD e abre diretamente no Photoshop para você conferir as camadas e o visual"
                    onClick={() => run(() => handleExportOrOpenPsd(true))}
                  >
                    Abrir no Photoshop
                  </button>
                )}
              </div>

              <button
                type="button"
                className="editor-btn outline-blue sk-full-width-btn sk-mt-10"
                onClick={() => run(async () => {
                  const p = validPoster();
                  const item = createQueueItemFromPoster(p);
                  item.paperFormat = activeFormat.paper;
                  item.orientation = activeFormat.orientation;
                  item.customWidthMm = activeFormat.customWidthMm;
                  item.customHeightMm = activeFormat.customHeightMm;
                  setConductorQueue(items => [...items, item]);
                  setMessage(`"${p.name}" adicionado ao Condutor de Impressão (${conductorQueue.length + 1} na fila).`);
                })}
              >
                + Adicionar ao Condutor ({conductorQueue.length})
              </button>

              {/* Fila Rápida derivada da fonte única conductorQueue (remoção segura por ID) */}
              {editorQueueItems.length > 0 && (
                <div className="editor-queue-box">
                  <h3>Cartazes do Editor no Condutor ({editorQueueItems.length})</h3>
                  {editorQueueItems.map(item => (
                    <div key={item.id} className="editor-queue-item">
                      <span className="sk-queue-item-label">
                        <strong>{item.name}</strong> {item.detail} · <span className="sk-tabular">R$ {item.price}</span>
                      </span>
                      <button
                        type="button"
                        className="editor-queue-remove"
                        aria-label={'Remover ' + item.name}
                        title="Remover cartaz da fila do Condutor"
                        onClick={() => {
                          setConductorQueue(items => items.filter(q => q.id !== item.id));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="sk-queue-footnote">
                    Sincronizado em tempo real com a aba Condutor de Impressão.
                  </div>
                </div>
              )}

              <p className="sk-print-tip">
                Impressão: papel {getFormatLabel(activeFormat)}, escala 100%, margens nenhuma e desative cabeçalhos/rodapés.
              </p>
            </div>
          </section>

          {/* Coluna 2: Hero Preview Proporcional Real */}
          <section className="editor-panel" aria-label="Prévia visual do cartaz">
            <div className="editor-preview-heading">
              <div>
                <h2>Pré-visualização do Cartaz</h2>
                <p className="sk-tabular">
                  {getFormatLabel(activeFormat)} · {getFormatDimensionsMm(activeFormat).width} × {getFormatDimensionsMm(activeFormat).height} mm · 300 DPI
                </p>
              </div>
              <span className="sk-preview-meta">
                {imported ? 'Arte PSD Editável' : 'Modelo Clássico'}
              </span>
            </div>

            {imported && editableParts.length > 0 && (
              <div className="sk-canvas-toolbar" role="toolbar" aria-label="Ajuste direto de camadas na arte">
                <div className="sk-canvas-toolbar-left">
                  <button
                    type="button"
                    className={`editor-btn subtle sk-canvas-tool-btn ${showCanvasGrid ? 'is-active' : ''}`}
                    onClick={() => setShowCanvasGrid(prev => !prev)}
                    aria-pressed={showCanvasGrid}
                    title="Mostrar ou ocultar grade de alinhamento na prévia (G)"
                  >
                    Grade (G)
                  </button>

                  <button
                    type="button"
                    className={`editor-btn subtle sk-canvas-tool-btn ${lockPriceGroup ? 'is-active' : ''}`}
                    onClick={() => setLockPriceGroup(prev => !prev)}
                    aria-pressed={lockPriceGroup}
                    title="Mover e redimensionar Reais, Centavos, Vírgula e Traço juntos em bloco"
                  >
                    Preço junto
                  </button>

                  <label className="sk-canvas-layer-picker">
                    <span className="sr-only">Camada selecionada</span>
                    <select
                      className="editor-select sk-canvas-select"
                      value={selectedPartKey ?? ''}
                      onChange={e => setSelectedPartKey(e.target.value || null)}
                      title="Clique direto na arte ou escolha uma camada para mover/redimensionar"
                    >
                      <option value="">Clique na arte ou selecione camada…</option>
                      {editableParts.map(part => {
                        const key = getPartKey(part);
                        return (
                          <option key={key} value={key}>
                            {PART_ROLE_LABELS[part.role] ?? part.role}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>

                {selectedPartKey && selectedPart && selectedPartAdj ? (
                  <div className="sk-nudge-group">
                    <label className="sk-nudge-field" title="Deslocamento horizontal (setas ← / →)">
                      <span>X</span>
                      <input
                        type="number"
                        className="editor-input sk-nudge-input sk-tabular"
                        value={selectedPartAdj.dx}
                        onChange={e => {
                          const nextDx = Number(e.target.value) || 0;
                          if (lockPriceGroup && isPriceGroupRole(selectedPart.role)) {
                            const delta = nextDx - selectedPartAdj.dx;
                            const batch: Record<string, { dx: number; dy: number; scale: number }> = {};
                            for (const p of editableParts) {
                              if (isPriceGroupRole(p.role)) {
                                const cur = clampPartAdjustment(p.adjustments);
                                batch[getPartKey(p)] = clampPartAdjustment({ ...cur, dx: cur.dx + delta });
                              }
                            }
                            editor.updateMultiplePartAdjustments(batch);
                          } else {
                            editor.updatePartAdjustment(selectedPartKey, {
                              ...selectedPartAdj,
                              dx: nextDx,
                            });
                          }
                        }}
                      />
                    </label>
                    <label className="sk-nudge-field" title="Deslocamento vertical (setas ↑ / ↓)">
                      <span>Y</span>
                      <input
                        type="number"
                        className="editor-input sk-nudge-input sk-tabular"
                        value={selectedPartAdj.dy}
                        onChange={e => {
                          const nextDy = Number(e.target.value) || 0;
                          if (lockPriceGroup && isPriceGroupRole(selectedPart.role)) {
                            const delta = nextDy - selectedPartAdj.dy;
                            const batch: Record<string, { dx: number; dy: number; scale: number }> = {};
                            for (const p of editableParts) {
                              if (isPriceGroupRole(p.role)) {
                                const cur = clampPartAdjustment(p.adjustments);
                                batch[getPartKey(p)] = clampPartAdjustment({ ...cur, dy: cur.dy + delta });
                              }
                            }
                            editor.updateMultiplePartAdjustments(batch);
                          } else {
                            editor.updatePartAdjustment(selectedPartKey, {
                              ...selectedPartAdj,
                              dy: nextDy,
                            });
                          }
                        }}
                      />
                    </label>
                    <label className="sk-nudge-field" title="Tamanho relativo da camada (+ / -)">
                      <span>Tam</span>
                      <input
                        type="number"
                        min={40}
                        max={250}
                        step={5}
                        className="editor-input sk-nudge-input sk-nudge-scale sk-tabular"
                        value={Math.round(selectedPartAdj.scale * 100)}
                        onChange={e => {
                          const pct = Math.max(40, Math.min(250, Number(e.target.value) || 100));
                          const nextScale = Number((pct / 100).toFixed(2));
                          if (lockPriceGroup && isPriceGroupRole(selectedPart.role)) {
                            const ratio = selectedPartAdj.scale > 0 ? nextScale / selectedPartAdj.scale : 1;
                            const batch: Record<string, { dx: number; dy: number; scale: number }> = {};
                            for (const p of editableParts) {
                              if (isPriceGroupRole(p.role)) {
                                const cur = clampPartAdjustment(p.adjustments);
                                batch[getPartKey(p)] = clampPartAdjustment({
                                  ...cur,
                                  scale: Number((cur.scale * ratio).toFixed(2)),
                                });
                              }
                            }
                            editor.updateMultiplePartAdjustments(batch);
                          } else {
                            editor.updatePartAdjustment(selectedPartKey, {
                              ...selectedPartAdj,
                              scale: nextScale,
                            });
                          }
                        }}
                      />
                      <span className="sk-nudge-unit">%</span>
                    </label>
                    <button
                      type="button"
                      className="editor-btn subtle sk-canvas-tool-btn"
                      onClick={() => {
                        if (!poster.artwork) return;
                        if (lockPriceGroup && isPriceGroupRole(selectedPart.role)) {
                          const priceParts = editableParts.filter(p => isPriceGroupRole(p.role));
                          let minLeft = Infinity;
                          let maxRight = -Infinity;
                          for (const p of priceParts) {
                            const cur = clampPartAdjustment(p.adjustments);
                            const cx = (p.bounds.left + p.bounds.right) / 2 + cur.dx;
                            const hw = ((p.bounds.right - p.bounds.left) / 2) * cur.scale;
                            minLeft = Math.min(minLeft, cx - hw);
                            maxRight = Math.max(maxRight, cx + hw);
                          }
                          const groupCenter = (minLeft + maxRight) / 2;
                          const delta = Math.round(poster.artwork.canvas.width / 2 - groupCenter);
                          const batch: Record<string, { dx: number; dy: number; scale: number }> = {};
                          for (const p of priceParts) {
                            const cur = clampPartAdjustment(p.adjustments);
                            batch[getPartKey(p)] = clampPartAdjustment({ ...cur, dx: cur.dx + delta });
                          }
                          editor.updateMultiplePartAdjustments(batch);
                        } else {
                          const centeredDx = computeHorizontalCenterDx(selectedPart, poster.artwork);
                          editor.updatePartAdjustment(selectedPartKey, {
                            ...selectedPartAdj,
                            dx: centeredDx,
                          });
                        }
                      }}
                      title="Centralizar horizontalmente na arte"
                    >
                      Centralizar
                    </button>
                    <button
                      type="button"
                      className="editor-btn subtle sk-canvas-tool-btn"
                      onClick={() => {
                        if (lockPriceGroup && isPriceGroupRole(selectedPart.role)) {
                          const batch: Record<string, null> = {};
                          for (const p of editableParts) {
                            if (isPriceGroupRole(p.role)) batch[getPartKey(p)] = null;
                          }
                          editor.updateMultiplePartAdjustments(batch);
                        } else {
                          editor.resetPartAdjustments(selectedPartKey);
                        }
                      }}
                      title="Restaurar posição e tamanho originais desta camada (Delete)"
                    >
                      Resetar
                    </button>
                  </div>
                ) : (
                  <div className="sk-canvas-hint">
                    <span>Arraste na prévia (imã automático · Alt solta) · Alça azul redimensiona</span>
                    {hasAnyPartAdjustment && (
                      <button
                        type="button"
                        className="editor-btn subtle sk-canvas-tool-btn"
                        onClick={() => editor.resetPartAdjustments()}
                        title="Restaurar posição e tamanho de todas as camadas ajustadas"
                      >
                        Resetar tudo
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="editor-canvas-wrap">
              <PosterView
                poster={poster}
                formatConfig={activeFormat}
                showGrid={showCanvasGrid}
                selectedPartKey={selectedPartKey}
                lockPriceGroup={lockPriceGroup}
                onSelectPart={imported ? setSelectedPartKey : undefined}
                onUpdatePartAdjustment={imported ? editor.updatePartAdjustment : undefined}
                onUpdateMultiplePartAdjustments={imported ? editor.updateMultiplePartAdjustments : undefined}
              />
            </div>
          </section>
        </div>
        )}
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
            removed={removedPath => {
              editor.removed(removedPath);
              setData(prev => removeLibraryEntry(prev, removedPath));
              setLibrarySelectedPaths(prev => {
                if (!prev.has(removedPath)) return prev;
                const next = new Set(prev);
                next.delete(removedPath);
                return next;
              });
            }}
            isActive={section === 'library'}
            requestConfirmation={confirmAction}
            selectedPaths={librarySelectedPaths}
            onSelectedPathsChange={setLibrarySelectedPaths}
            onNotify={setMessage}
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
    <div hidden={section !== 'offers'} className="library-container">
      <OfferFolders
        libraryData={data}
        run={run}
        onPrintBatch={handlePrintBatch}
        onEditPoster={openOfferPoster}
        onRefreshLibrary={refresh}
        isActive={section === 'offers'}
        requestConfirmation={confirmAction}
        selectedItemIds={offerSelectedItemIds}
        onSelectedItemIdsChange={setOfferSelectedItemIds}
        onStartBatchEdit={startBatchEdit}
        initialCampaigns={demoCampaigns}
        onAddToConductor={(cartaz, cartazPath) => {
          setConductorQueue(prev => {
            if (findDuplicateInQueue(prev, cartazPath)) return prev;
            const item = createQueueItemFromCartaz(cartaz, cartazPath, 'library');
            return [...prev, item];
          });
          setMessage(`Cartaz "${cartaz.product.name}" enviado ao Condutor de Impressão.`);
        }}
        onAddBatchToConductor={entries => {
          const next = [...conductorQueueRef.current];
          let addedCount = 0;
          for (const entry of entries) {
            if (findDuplicateInQueue(next, entry.path)) continue;
            const item = createQueueItemFromCartaz(entry.cartaz, entry.path, 'library');
            if (entry.copies && entry.copies > 1) {
              item.copies = entry.copies;
            }
            next.push(item);
            addedCount++;
          }
          if (addedCount > 0) {
            conductorQueueRef.current = next;
            setConductorQueue(next);
            setMessage(`${addedCount} cartaz(es) adicionado(s) à Fila de Impressão (Condutor).`);
          } else {
            setMessage('Todos os cartazes selecionados já estão na Fila de Impressão.');
          }
          return addedCount;
        }}
      />
    </div>
    <div hidden={section !== 'scantech'} className="library-container"><ScantechCreator libraryData={data} run={run} onPrintBatch={handlePrintBatch} onRefreshLibrary={refresh}/></div>
    <div hidden={section !== 'conductor'} className="library-container"><PrintConductor queue={conductorQueue} setQueue={setConductorQueue} libraryData={data} run={run} onPrintBatch={handlePrintBatch}/></div>
    </fieldset>
    {workspaceMarqueeRect && (
      <div
        className="sk-marquee-box"
        role="presentation"
        aria-hidden="true"
        data-testid="workspace-marquee-box"
        style={{
          left: workspaceMarqueeRect.left,
          top: workspaceMarqueeRect.top,
          width: workspaceMarqueeRect.width,
          height: workspaceMarqueeRect.height,
        }}
      />
    )}
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
      <div
        className="modal-backdrop"
        onMouseDown={e => {
          if (e.target === e.currentTarget) setShowCustomModal(false);
        }}
      >
        <form
          className="panel modal sk-lib-modal sk-confirm-modal"
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
          <h2 className="sk-confirm-title">Formato de Papel Personalizado</h2>
          <p className="sk-confirm-description">
            Configure as dimensões físicas da folha em milímetros (mm).
          </p>

          <div className="sk-two-col-grid">
            <label className="sk-modal-field-label">
              Largura (mm)
              <input
                type="number"
                min={50}
                max={2000}
                required
                className="editor-input sk-tabular"
                style={{ marginTop: 6 }}
                value={customWInput}
                onChange={e => setCustomWInput(e.target.value)}
              />
            </label>

            <label className="sk-modal-field-label">
              Altura (mm)
              <input
                type="number"
                min={50}
                max={2000}
                required
                className="editor-input sk-tabular"
                style={{ marginTop: 6 }}
                value={customHInput}
                onChange={e => setCustomHInput(e.target.value)}
              />
            </label>
          </div>

          <div style={{ marginTop: 14 }}>
            <span className="sk-modal-field-label" style={{ marginBottom: 6 }}>
              Orientação
            </span>
            <div className="sk-radio-row">
              <label className="sk-radio-option">
                <input
                  type="radio"
                  name="custom-orient"
                  checked={customOrientInput === 'portrait'}
                  onChange={() => setCustomOrientInput('portrait')}
                />
                Vertical (Retrato)
              </label>
              <label className="sk-radio-option">
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

          <div className="toolbar sk-modal-actions">
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
      <div
        className="modal-backdrop"
        onMouseDown={e => {
          if (e.target === e.currentTarget) setConfirmationModal(null);
        }}
      >
        <div
          className="panel modal sk-lib-modal sk-confirm-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar Impressão Física"
        >
          <h2 className="sk-confirm-title sk-confirm-title--primary">
            Confirmar Saída na Impressora
          </h2>
          <p className="sk-confirm-description">
            A impressão de <strong>"{confirmationModal.productName}"</strong> ({confirmationModal.formatLabel}) saiu corretamente na impressora física?
          </p>
          <div className="sk-modal-note">
            A confirmação manual do operador garante que apenas cartazes efetivamente impressos contem como confirmados no histórico.
          </div>
          <div className="toolbar sk-modal-actions">
            <button
              type="button"
              className="editor-btn subtle"
              onClick={() => setConfirmationModal(null)}
              title="Registrar apenas como 'Enviada' sem confirmar saída física"
            >
              Não Confirmar / Falha
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
              Confirmar Impressão
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Modal Reutilizável de Confirmação (Descarte / Backup ao Sobrescrever) */}
    <ConfirmModal
      request={confirmState?.request ?? null}
      onConfirm={() => resolveConfirm(true)}
      onCancel={() => resolveConfirm(false)}
    />

    {/* Modal de Histórico de Impressão */}
    <PrintHistoryModal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} />

    {/* Modal de Atalhos de Teclado do Operador */}
    <ShortcutsModal isOpen={showShortcutsModal} onClose={() => setShowShortcutsModal(false)} />

    <div className="print-only">
      {batchPrintPosters && batchPrintPosters.length > 0 ? (
        batchPrintPosters.map((p, i) => (
          <div className="print-page" key={i}>
            <PosterView
              poster={p}
              isPrint={true}
              formatConfig={p.formatConfig || batchPrintFormat || activeFormat}
              onRendered={handlePosterRendered}
            />
          </div>
        ))
      ) : (
        <div className="print-page">
          <PosterView
            poster={poster}
            isPrint={true}
            formatConfig={batchPrintFormat || activeFormat}
          />
        </div>
      )}
    </div>
  </div>;
}
