import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { PosterView, type Poster } from '../editor/PosterView';
import { hasInvertedPsdPriceParts, repairInvertedPsdArtwork } from '../editor/importedRenderer';
import { posterFromDocument } from '../../features/cartazes/presentation';
import { serialize } from '../../features/cartazes/serialization';
import { indexCartazes, type IndexedCartaz } from '../../features/cartazes/f7';
import { chooseSave, remove as removeLibraryFile, saveDocument, saveExportDocument } from '../../features/cartazes/storage';
import type { Cartaz, Library as LibraryData } from '../../features/cartazes/types';
import type { ConfirmDialogRequest } from '../common/ConfirmModal';
import { useMarqueeSelection } from '../../hooks/useMarqueeSelection';
import { hasActiveModalDialog, isTextEditingElement } from '../../features/cartazes/keyboard';
import {
  columnLetter,
  detectHeaderRowIndex,
  extractCampaignItemsFromSheet,
  parseExcelPriceToCents,
  parseXlsx,
  suggestColumnMapping,
  type ColumnMapping,
  type ExcelWorkbook,
} from '../../features/ofertas/excel';
import {
  applyExcelToCampaign,
  archiveCampaign,
  buildCampaignMatchViews,
  buildCampaignPsdSuggestions,
  buildCartazPathFromPsd,
  buildOfferPsdCartazTargetPath,
  buildPsdBatchConfirmationSummary,
  confirmBatchPrinted,
  createCampaign,
  deleteCampaign,
  detectPsdPaperFormat,
  duplicateCampaign,
  executePsdBatchLinking,
  formatCampaignDateToValidity,
  getDefaultSelectionForSuggestion,
  linkSavedPosterToCampaignItem,
  listCampaigns,
  psdFileNameToCartazFileName,
  removeCampaignItem,
  renameCampaign,
  saveCampaign,
  selectExcel,
  syncCampaignWithLibrary,
  unlinkPosterFromCampaignItem,
  updateAllPostersSelection,
  updateCampaignItemDescription,
  updatePosterSelection,
  updateScheduledPrice,
} from '../../features/ofertas/service';
import type {
  CampaignItem,
  CampaignMatchView,
  OfferCampaign,
  PrintStatus,
  PsdBatchLinkResult,
  PsdImportOfferContext,
  PsdPairingSelection,
  PsdSuggestionReason,
} from '../../features/ofertas/types';
import {
  chooseScantechExportFolder,
  chooseScantechPsdFolder,
  executeScantechDirectExportJob,
  scanScantechPsdFolder,
} from '../../features/scantech/service';
import { exportDerivedPsdDirect } from '../../features/scantech/directExport';
import type { ScannedPsdEntry, ScantechExportJob } from '../../features/scantech/types';
import { readPsdByPath } from '../../features/psd/service';
import { analyzePsd, buildArtwork } from '../../features/psd/importer';
import { formatCentsBr, splitCentsToParts } from '../../features/cartazes/presentation';
import { fileName, priceToCents } from '../../features/cartazes/validation';
import type { PaperFormat } from '../../features/cartazes/types';

const PsdImport = lazy(() =>
  import('../library/PsdImport').then(module => ({ default: module.PsdImport }))
);
type PsdPairingFilter =
  | 'todos'
  | PsdSuggestionReason
  | 'ambiguous'
  | 'selected-batch'
  | 'already-linked';

export type FormatTab = 'todos' | 'A6' | 'A5' | 'A5-flv' | 'A4' | 'A3' | 'expositor-a3-2x2';

export function isFlvItem(description?: string, posterProductName?: string): boolean {
  const d = (description || '').trim();
  const n = (posterProductName || '').trim();
  // Regra prioritária solicitada: produtos que começam com FLV. ou FLV (ex: FLV.ABACATE KG, FLV BANANA)
  if (/^flv[\s.]/i.test(d) || /^flv[\s.]/i.test(n)) {
    return true;
  }
  // Termos de hortifruti comuns no setor
  const upper = `${d} ${n}`.toUpperCase();
  return (
    upper.includes('HORTIFRUTI') ||
    upper.includes('FRUTAS E VERDURAS') ||
    /\bFLV\b/i.test(upper)
  );
}

export function getPosterPaperFormat(doc?: Cartaz | null, path?: string): PaperFormat {
  if (doc?.layout?.paper && ['A6', 'A5', 'A4', 'A3', 'expositor-a3-2x2'].includes(doc.layout.paper)) {
    return doc.layout.paper as PaperFormat;
  }
  const upper = (path || '').toUpperCase();
  if (upper.includes('PEQUENO') || upper.includes('A6')) return 'A6';
  if (upper.includes('MÉDIO') || upper.includes('MEDIO') || upper.includes('A5')) return 'A5';
  if (upper.includes('EXTERNO') || upper.includes('EXPOSITOR') || upper.includes('2X2')) return 'expositor-a3-2x2';
  if (upper.includes('AÇOUGUE') || upper.includes('ACOUGUE') || upper.includes('A3')) return 'A3';
  if (upper.includes('A4')) return 'A4';
  return 'A6';
}

export function getFormatBadge(format: PaperFormat): { label: string; icon: string; bg: string; text: string } {
  switch (format) {
    case 'A6': return { label: 'Pequeno (A6)', icon: '🏷️', bg: '#fef3c7', text: '#92400e' };
    case 'A5': return { label: 'Médio (A5)', icon: '📐', bg: '#e0e7ff', text: '#3730a3' };
    case 'A4': return { label: 'Cartaz A4', icon: '📄', bg: '#dcfce7', text: '#166534' };
    case 'A3': return { label: 'Açougue (A3)', icon: '🥩', bg: '#fee2e2', text: '#991b1b' };
    case 'expositor-a3-2x2': return { label: 'Externos (2×2)', icon: '🏢', bg: '#f3e8ff', text: '#6b21a8' };
    default: return { label: format, icon: '📋', bg: '#f1f5f9', text: '#475569' };
  }
}

export type BatchEditItem = {
  path: string;
  scheduledPriceCents?: number;
  f7: string;
  description: string;
};

export type OfferExportScope = 'all' | 'print-marked' | 'checked-rows';

export type ExportCandidate = {
  item: CampaignItem;
  cartazPath: string;
  doc: Cartaz;
};

/**
 * Pure helper selecting exportable posters based on the chosen export scope:
 * - 'all': every linked poster in the campaign
 * - 'print-marked': posters with print checkbox enabled (`m.state.selected`)
 * - 'checked-rows': posters belonging to items selected via row checkboxes / marquee drag
 */
export function selectExportCandidates(
  views: CampaignMatchView[],
  scope: OfferExportScope,
  selectedItemIds: Set<string>
): ExportCandidate[] {
  const candidates: ExportCandidate[] = [];
  const candidateKeys = new Set<string>();

  for (const v of views) {
    if (scope === 'checked-rows' && !selectedItemIds.has(v.item.id)) continue;
    for (const m of v.matchedPosters) {
      if (!m.scheduledDocument) continue;
      if (scope === 'print-marked' && !m.state.selected) continue;
      const candidateKey = `${v.item.id}::${m.state.cartazPath.replace(/\//g, '\\').toLocaleLowerCase('en-US')}`;
      if (candidateKeys.has(candidateKey)) continue;
      candidateKeys.add(candidateKey);
      candidates.push({
        item: v.item,
        cartazPath: m.state.cartazPath,
        doc: m.scheduledDocument,
      });
    }
  }
  return candidates;
}

type Props = {
  libraryData: LibraryData | null;
  run: (action: () => Promise<void>) => void;
  onPrintBatch: (posters: Poster[], options?: any) => void;
  onEditPoster?: (path: string, scheduledPriceCents?: number) => Promise<void>;
  onRefreshLibrary?: () => Promise<void>;
  isActive?: boolean;
  onAddToConductor?: (cartaz: Cartaz, path: string) => void;
  onAddBatchToConductor?: (entries: { cartaz: Cartaz; path: string; copies?: number }[]) => number;
  onStartBatchEdit?: (items: BatchEditItem[]) => Promise<void>;
  requestConfirmation?: (request: ConfirmDialogRequest) => Promise<boolean>;
  selectedItemIds?: Set<string>;
  onSelectedItemIdsChange?: (next: Set<string>) => void;
  initialCampaigns?: OfferCampaign[];
  initialActiveId?: string | null;
  initialPsdFolder?: string | null;
  initialScannedPsds?: ScannedPsdEntry[];
  initialShowPsdModal?: boolean;
  initialShowBatchConfirmStep?: boolean;
  initialPsdPairingSelections?: Record<string, PsdPairingSelection>;
  initialBatchLinkResult?: PsdBatchLinkResult | null;
  initialPsdScanError?: string | null;
};

const money = (cents: number | null) =>
  cents === null ? '—' : `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

const tomorrowIso = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function OfferFolders({
  libraryData,
  run,
  onPrintBatch,
  onEditPoster,
  onRefreshLibrary,
  isActive = true,
  onAddToConductor,
  onAddBatchToConductor,
  onStartBatchEdit,
  requestConfirmation,
  selectedItemIds: controlledSelectedItemIds,
  onSelectedItemIdsChange,
  initialCampaigns = [],
  initialActiveId = null,
  initialPsdFolder = null,
  initialScannedPsds = [],
  initialShowPsdModal = false,
  initialShowBatchConfirmStep = false,
  initialPsdPairingSelections = {},
  initialBatchLinkResult = null,
  initialPsdScanError = null,
}: Props) {
  const [campaigns, setCampaigns] = useState<OfferCampaign[]>(initialCampaigns);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(
    initialActiveId ?? (initialCampaigns[0]?.id || null)
  );
  const [showArchived, setShowArchived] = useState(false);

  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDate, setNewFolderDate] = useState(tomorrowIso);

  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [renameDate, setRenameDate] = useState('');

  // Excel import modal state
  const [workbook, setWorkbook] = useState<ExcelWorkbook | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping>({ f7Col: 0, descriptionCol: 1, priceCol: 2 });

  // PSD import modal state from "Sem cartaz" row
  const [psdOfferContext, setPsdOfferContext] = useState<PsdImportOfferContext | null>(null);
  // Filter & preview inside active campaign
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'todos' | 'com-cartaz' | 'sem-cartaz' | PrintStatus>('todos');
  const [formatTab, setFormatTab] = useState<FormatTab>('todos');
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [compactViewMode, setCompactViewMode] = useState(true);
  const [actionsOpen, setActionsOpen] = useState(true);
  const [expandedActionsKeys, setExpandedActionsKeys] = useState<Set<string>>(new Set());
  const [collapsedActionsKeys, setCollapsedActionsKeys] = useState<Set<string>>(new Set());
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState('');
  const [editingDescriptionId, setEditingDescriptionId] = useState<string | null>(null);
  const [editingDescriptionValue, setEditingDescriptionValue] = useState('');

  // Batch print tracking
  const [batchSize, setBatchSize] = useState(10);
  const [awaitingPrintConfirm, setAwaitingPrintConfirm] = useState<{ keys: Set<string>; count: number } | null>(null);
  // Item-level multi-selection for batch print / conductor / export / sequential edit / delete
  const [internalSelectedItemIds, setInternalSelectedItemIds] = useState<Set<string>>(new Set());
  const isSelectionControlled =
    controlledSelectedItemIds !== undefined && onSelectedItemIdsChange !== undefined;
  const selectedItemIds = isSelectionControlled ? controlledSelectedItemIds : internalSelectedItemIds;
  const selectedItemIdsRef = useRef(selectedItemIds);
  selectedItemIdsRef.current = selectedItemIds;
  const setSelectedItemIds = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      if (isSelectionControlled) {
        const next = typeof updater === 'function' ? updater(selectedItemIdsRef.current) : updater;
        onSelectedItemIdsChange(next);
      } else {
        setInternalSelectedItemIds(updater);
      }
    },
    [isSelectionControlled, onSelectedItemIdsChange]
  );

  const lastSelectedItemIdRef = useRef<string | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const masterCheckboxRef = useRef<HTMLInputElement | null>(null);

  const {
    marqueeRect,
    isDragging: isMarqueeDragging,
    handleMouseDown: handleTableMarqueeMouseDown,
  } = useMarqueeSelection({
    containerRef: tableWrapRef,
    selectedIds: selectedItemIds,
    onSelectionChange: next => {
      setSelectedItemIds(next);
    },
    enabled: isActive && !isSelectionControlled,
  });

  useEffect(() => {
    setSelectedItemIds(new Set());
    lastSelectedItemIdRef.current = null;
  }, [activeId, setSelectedItemIds]);

  const askConfirm = async (req: ConfirmDialogRequest): Promise<boolean> => {
    if (requestConfirmation) return await requestConfirmation(req);
    return true;
  };

  // Pasta de PSDs de referência e pareamento revisável por produto da campanha (detecção automática por padrão)
  const [scannedPsds, setScannedPsds] = useState<ScannedPsdEntry[]>(initialScannedPsds);
  const [psdFolder, setPsdFolder] = useState<string | null>(initialPsdFolder);
  const [psdPaperSize, setPsdPaperSize] = useState<PaperFormat | 'auto'>('auto');
  const [showPsdManagerModal, setShowPsdManagerModal] = useState(initialShowPsdModal);
  const [psdFilterText, setPsdFilterText] = useState('');
  const [psdReasonFilter, setPsdReasonFilter] = useState<PsdPairingFilter>('todos');
  const [psdPage, setPsdPage] = useState(0);
  const [isScanningPsds, setIsScanningPsds] = useState(false);
  const [psdPairingSelections, setPsdPairingSelections] = useState<Record<string, PsdPairingSelection>>(
    initialPsdPairingSelections
  );
  const [showBatchConfirmStep, setShowBatchConfirmStep] = useState(initialShowBatchConfirmStep);
  const [batchLinking, setBatchLinking] = useState(false);
  const [batchLinkResult, setBatchLinkResult] = useState<PsdBatchLinkResult | null>(initialBatchLinkResult);
  const [psdScanError, setPsdScanError] = useState<string | null>(initialPsdScanError);

  // Exportação em lote da pasta de ofertas
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormatPsd, setExportFormatPsd] = useState(true);
  const [exportFormatSk, setExportFormatSk] = useState(true);
  const [exportScope, setExportScope] = useState<OfferExportScope>('all');
  const [exportOrganizeByFormat, setExportOrganizeByFormat] = useState(true);
  const [exportFolder, setExportFolder] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [exportResult, setExportResult] = useState<{
    psdCount: number;
    skCount: number;
    candidateCount: number;
    errors: string[];
  } | null>(null);

  const libraryIndex = useMemo(() => indexCartazes(libraryData?.entries ?? []), [libraryData]);

  const reloadCampaigns = async () => {
    const res = await listCampaigns();
    setCampaigns(res.campaigns);
    setLoadErrors(res.errors);
    if (!activeId && res.campaigns.length > 0) {
      const firstActive = res.campaigns.find(c => !c.archived) ?? res.campaigns[0];
      setActiveId(firstActive.id);
    }
  };

  useEffect(() => {
    if (!isTauri() && initialCampaigns.length > 0) {
      return;
    }
    let mounted = true;
    listCampaigns()
      .then(res => {
        if (!mounted) return;
        setCampaigns(res.campaigns);
        setLoadErrors(res.errors);
        if (res.campaigns.length > 0) {
          const first = res.campaigns.find(c => !c.archived) ?? res.campaigns[0];
          setActiveId(first.id);
        }
      })
      .catch(err => {
        if (mounted) setLoadErrors([String(err)]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const activeCampaign = useMemo(
    () => campaigns.find(c => c.id === activeId) ?? null,
    [campaigns, activeId]
  );

  const pendingSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pendingSaveTimeoutRef.current) {
        clearTimeout(pendingSaveTimeoutRef.current);
      }
    };
  }, []);

  const scheduleCampaignSave = (updated: OfferCampaign) => {
    if (!isTauri()) return;
    if (pendingSaveTimeoutRef.current) {
      clearTimeout(pendingSaveTimeoutRef.current);
    }
    pendingSaveTimeoutRef.current = setTimeout(() => {
      saveCampaign(updated).catch(err => {
        console.error('Falha ao salvar campanha em segundo plano:', err);
      });
    }, 350);
  };

  const handleTogglePosterSelection = (
    itemId: string,
    cartazPath: string,
    selected: boolean
  ) => {
    if (!activeCampaign) return;
    const updated = updatePosterSelection(activeCampaign, itemId, cartazPath, { selected });
    // Atualização otimista imediata na memória do React (0ms de latência)
    setCampaigns(prev => prev.map(c => (c.id === updated.id ? updated : c)));
    scheduleCampaignSave(updated);
  };

  const handleCopiesChange = (
    itemId: string,
    cartazPath: string,
    copies: number
  ) => {
    if (!activeCampaign) return;
    const updated = updatePosterSelection(activeCampaign, itemId, cartazPath, { copies });
    setCampaigns(prev => prev.map(c => (c.id === updated.id ? updated : c)));
    scheduleCampaignSave(updated);
  };

  const handleStatusChange = (
    itemId: string,
    cartazPath: string,
    status: PrintStatus
  ) => {
    if (!activeCampaign) return;
    const updated = updatePosterSelection(activeCampaign, itemId, cartazPath, { status });
    setCampaigns(prev => prev.map(c => (c.id === updated.id ? updated : c)));
    scheduleCampaignSave(updated);
  };

  const handleSelectAllFiltered = (selected: boolean) => {
    if (!activeCampaign) return;
    const filteredItemIds = new Set(filteredViews.map(v => v.item.id));
    const updated = updateAllPostersSelection(activeCampaign, selected, filteredItemIds);
    setCampaigns(prev => prev.map(c => (c.id === updated.id ? updated : c)));
    scheduleCampaignSave(updated);
  };

  const persistUpdate = async (updated: OfferCampaign) => {
    const saved = isTauri() ? await saveCampaign(updated) : updated;
    setCampaigns(prev => {
      const idx = prev.findIndex(c => c.id === saved.id);
      if (idx === -1) return [saved, ...prev];
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
    return saved;
  };

  const handleCreateCampaign = async () => {
    const created = createCampaign(newFolderName || 'Ofertas de Amanhã', newFolderDate);
    const saved = await persistUpdate(created);
    setActiveId(saved.id);
    setNewFolderName('');
  };

  const handleRenameCampaign = async () => {
    if (!activeCampaign) return;
    const updated = renameCampaign(activeCampaign, renameText, renameDate);
    await persistUpdate(updated);
    setRenaming(false);
  };

  const handleDuplicateCampaign = async () => {
    if (!activeCampaign) return;
    const copy = duplicateCampaign(activeCampaign);
    const saved = await persistUpdate(copy);
    setActiveId(saved.id);
  };

  const handleArchiveToggle = async () => {
    if (!activeCampaign) return;
    const updated = archiveCampaign(activeCampaign, !activeCampaign.archived);
    await persistUpdate(updated);
  };

  const handleDeleteCampaign = async () => {
    if (!activeCampaign) return;
    const confirmMessage =
      `Tem certeza que deseja excluir a pasta de ofertas "${activeCampaign.name}"?\n\n` +
      `• Esta ação apaga apenas o registro desta pasta de ofertas.\n` +
      `• Seus cartazes da biblioteca, preços normais vigentes e arquivos PSD NÃO serão alterados nem apagados.`;

    if (!window.confirm(confirmMessage)) return;

    await deleteCampaign(activeCampaign.id);
    setCampaigns(prev => {
      const remaining = prev.filter(c => c.id !== activeCampaign.id);
      const nextActive = remaining.find(c => !c.archived) ?? remaining[0] ?? null;
      setActiveId(nextActive ? nextActive.id : null);
      return remaining;
    });
    setRenaming(false);
    setAwaitingPrintConfirm(null);
  };

  const handleOpenExcel = async () => {
    const selected = await selectExcel();
    if (!selected) return;
    const wb = parseXlsx(selected.buffer, selected.name);
    setWorkbook(wb);
    setSheetIdx(0);
    const firstSheet = wb.sheets[0];
    const autoHeader = firstSheet ? detectHeaderRowIndex(firstSheet.rows) : 0;
    setHeaderRow(autoHeader);
    const headers = firstSheet?.rows[autoHeader] ?? [];
    setMapping(suggestColumnMapping(headers));
  };

  const activeSheet = workbook?.sheets[sheetIdx] ?? null;

  const handleSheetChange = (idx: number) => {
    setSheetIdx(idx);
    const sheet = workbook?.sheets[idx];
    const autoHeader = sheet ? detectHeaderRowIndex(sheet.rows) : 0;
    setHeaderRow(autoHeader);
    const row = sheet?.rows[autoHeader] ?? [];
    setMapping(suggestColumnMapping(row));
  };

  const handleHeaderRowChange = (rIdx: number) => {
    setHeaderRow(rIdx);
    const row = activeSheet?.rows[rIdx] ?? [];
    setMapping(suggestColumnMapping(row));
  };

  const extractionPreview = useMemo(() => {
    if (!activeSheet) return null;
    return extractCampaignItemsFromSheet(activeSheet, headerRow, mapping);
  }, [activeSheet, headerRow, mapping]);

  const handleConfirmExcelImport = async () => {
    if (!activeCampaign || !workbook || !activeSheet || !extractionPreview) return;
    const updated = applyExcelToCampaign(activeCampaign, extractionPreview, libraryIndex, {
      fileName: workbook.fileName,
      sheetName: activeSheet.name,
      headerRowIndex: headerRow,
      mapping,
    });
    await persistUpdate(updated);
    setWorkbook(null);
  };

  const handleSyncLibrary = async () => {
    if (!activeCampaign) return;
    if (onRefreshLibrary) await onRefreshLibrary();
    const synced = syncCampaignWithLibrary(activeCampaign, libraryIndex);
    await persistUpdate(synced);
  };

  const buildCartazFromPsd = async (
    psdData: { name: string; path: string; buffer: ArrayBuffer },
    item: CampaignItem,
    paperSize: PaperFormat | 'auto'
  ): Promise<Cartaz> => {
    const resolvedPaper: PaperFormat = paperSize === 'auto'
      ? detectPsdPaperFormat(psdData.path || psdData.name, item.description)
      : paperSize;

    const analysis = await analyzePsd(psdData.buffer, psdData.name, psdData.path);
    const roles = analysis.suggested;
    if (!roles.whole || !roles.fraction) {
      throw new Error(`Não foi possível detectar as camadas de preço no PSD "${psdData.name}".`);
    }
    let artwork = buildArtwork(analysis, roles, analysis.templateSuggested);
    let libraryBasePriceCents: number | null = null;
    if (hasInvertedPsdPriceParts(artwork)) {
      const repaired = repairInvertedPsdArtwork(artwork);
      artwork = repaired.artwork;
      libraryBasePriceCents = repaired.correctedPriceCents;
    } else if (analysis.metadata.price.trim()) {
      try {
        libraryBasePriceCents = priceToCents(analysis.metadata.price);
      } catch {
        libraryBasePriceCents = null;
      }
    }

    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      product: {
        name: (item.description || 'PRODUTO').trim().toUpperCase(),
        complement: '',
        unit: 'UN',
        priceCents: libraryBasePriceCents ?? (item.scheduledPriceCents || 100),
        productCode: item.f7 || null,
        validityText: analysis.metadata.validityText || '',
      },
      layout: {
        template: 'imported-psd',
        paper: resolvedPaper,
        orientation: 'portrait',
        artwork,
      },
      metadata: {
        createdAt: now,
        updatedAt: now,
      },
    };
  };

  const handleChoosePsdFolder = async () => {
    setPsdScanError(null);
    let folder: string | null = null;
    try {
      folder = await chooseScantechPsdFolder();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPsdScanError(msg);
      setShowPsdManagerModal(true);
      throw err;
    }
    if (!folder) return;

    setPsdFolder(folder);
    const normFolder = folder.toLowerCase();
    if (/pequeno|a6/i.test(normFolder)) {
      setPsdPaperSize('A6');
    } else if (/m[eé]dio|a5/i.test(normFolder)) {
      setPsdPaperSize('A5');
    } else if (/a4/i.test(normFolder)) {
      setPsdPaperSize('A4');
    } else if (/a[cç]ougue|a3/i.test(normFolder)) {
      if (/m[eé]dio/i.test(normFolder)) {
        setPsdPaperSize('A5');
      } else {
        setPsdPaperSize('A3');
      }
    } else if (/externo|expositor/i.test(normFolder)) {
      setPsdPaperSize('expositor-a3-2x2');
    } else {
      setPsdPaperSize('auto');
    }
    setBatchLinkResult(null);
    setShowBatchConfirmStep(false);
    setPsdPairingSelections({});
    setPsdPage(0);
    setShowPsdManagerModal(true);
    setIsScanningPsds(true);

    try {
      const entries = await scanScantechPsdFolder(folder);
      setScannedPsds(entries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setScannedPsds([]);
      setPsdScanError(`Falha ao ler os arquivos PSD da pasta "${folder}": ${msg}`);
      throw err;
    } finally {
      setIsScanningPsds(false);
    }
  };

  const handleAssignPsdToOfferItem = async (
    itemId: string,
    psdPath: string,
    paperSize: PaperFormat | 'auto' = psdPaperSize
  ) => {
    if (!activeCampaign) return;
    const item = activeCampaign.items.find(i => i.id === itemId);
    const psdEntry = scannedPsds.find(p => p.path === psdPath) ?? {
      name: psdPath.split(/[\\/]/).pop() || psdPath,
      path: psdPath,
      size: 0,
    };
    if (!item) {
      throw new Error('Produto da campanha não encontrado para vincular a arte PSD.');
    }

    const resolvedPaper: PaperFormat = paperSize === 'auto'
      ? detectPsdPaperFormat(psdEntry.path || psdEntry.name, item.description)
      : paperSize;

    const targetPath = buildCartazPathFromPsd(
      libraryData?.root || '',
      psdEntry.path || psdEntry.name,
      resolvedPaper
    );

    const alreadyExists = libraryData?.entries.some(
      e => !e.folder && e.path.toLowerCase() === targetPath.toLowerCase()
    );
    if (alreadyExists && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const fileName = targetPath.split(/[\\/]/).pop();
      if (!window.confirm(`O cartaz "${fileName}" já existe na biblioteca.\n\nDeseja substituir o arquivo existente pela nova referência PSD?`)) {
        return;
      }
    }

    setBatchLinking(true);
    setBatchLinkResult(null);
    try {
      const res = await executePsdBatchLinking(
        activeCampaign,
        [{ item, psd: psdEntry }],
        paperSize,
        libraryData?.root || '',
        {
          readPsd: readPsdByPath,
          buildCartazFromPsd,
          saveCartazDocument: (targetPath, doc) => saveDocument(targetPath, doc, true),
          persistCampaign: persistUpdate,
          refreshLibrary: onRefreshLibrary,
        }
      );
      setBatchLinkResult(res);
      if (res.success) {
        setPreviewKey(`${item.id}::${targetPath}`);
      }
    } finally {
      setBatchLinking(false);
    }
  };

  const handleExecuteConfirmedBatchLink = async (
    itemsToLink: { item: CampaignItem; psd: ScannedPsdEntry }[]
  ) => {
    if (!activeCampaign || itemsToLink.length === 0) return;

    const existingCount = itemsToLink.filter(entry => {
      const resolvedFormat = psdPaperSize === 'auto'
        ? detectPsdPaperFormat(entry.psd.path || entry.psd.name, entry.item.description)
        : psdPaperSize;
      const tPath = buildCartazPathFromPsd(
        libraryData?.root || '',
        entry.psd.path || entry.psd.name,
        resolvedFormat
      );
      return libraryData?.entries.some(e => !e.folder && e.path.toLowerCase() === tPath.toLowerCase());
    }).length;

    if (existingCount > 0 && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(`Atenção: ${existingCount} arquivo(s) .skcartaz já existem na biblioteca e serão atualizados.\n\nDeseja prosseguir com a substituição?`)) {
        return;
      }
    }

    setBatchLinking(true);
    setBatchLinkResult(null);
    try {
      const res = await executePsdBatchLinking(
        activeCampaign,
        itemsToLink,
        psdPaperSize,
        libraryData?.root || '',
        {
          readPsd: readPsdByPath,
          buildCartazFromPsd,
          saveCartazDocument: (targetPath, doc) => saveDocument(targetPath, doc, true),
          persistCampaign: persistUpdate,
          refreshLibrary: onRefreshLibrary,
        }
      );
      setBatchLinkResult(res);
      setShowBatchConfirmStep(false);
    } finally {
      setBatchLinking(false);
    }
  };

  const handleChooseExportFolder = async () => {
    const chosen = await chooseScantechExportFolder();
    if (chosen) setExportFolder(chosen);
  };

  const handleRunBatchExport = async () => {
    if (!activeCampaign) return;
    const desktopMode = isTauri();
    if (desktopMode && !exportFolder) return;
    if (!exportFormatPsd && !exportFormatSk) {
      throw new Error('Selecione pelo menos um formato de exportação (.PSD ou .skcartaz).');
    }

    setExporting(true);
    setExportProgress({ current: 0, total: 0, message: 'Preparando cartazes...' });
    setExportResult(null);

    try {
      const cleanCampName = activeCampaign.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-|-$/g, '');
      const subFolderName = `${cleanCampName}_${activeCampaign.campaignDate}`;
      const exportFolderBase = (exportFolder || '').replace(/[\\/]+$/, '');
      const isAlreadyCampFolder =
        exportFolderBase.toLowerCase().includes(activeCampaign.campaignDate) ||
        exportFolderBase.toLowerCase().includes(cleanCampName.toLowerCase());
      const targetFolder = isAlreadyCampFolder ? exportFolderBase : `${exportFolderBase}\\${subFolderName}`;

      const candidates = selectExportCandidates(matchViews, exportScope, selectedItemIds);

      if (candidates.length === 0) {
        throw new Error(
          exportScope === 'checked-rows'
            ? 'Nenhum dos produtos selecionados possui cartaz vinculado pronto para exportar.'
            : 'Nenhum cartaz com arte vinculada disponível para exportar.'
        );
      }

      setExportProgress({ current: 0, total: candidates.length, message: 'Iniciando exportação...' });

      let psdCount = 0;
      let skCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < candidates.length; i++) {
        const { item, cartazPath, doc } = candidates[i];
        setExportProgress({
          current: i + 1,
          total: candidates.length,
          message: `Exportando ${i + 1} de ${candidates.length}: F7 ${item.f7} - ${item.description}...`,
        });

        const targetFormat = getPosterPaperFormat(doc, cartazPath);
        const formatSubFolder =
          targetFormat === 'A6'
            ? 'PEQUENOS'
            : targetFormat === 'A5'
            ? 'MÉDIOS'
            : targetFormat === 'A4'
            ? 'CARTAZ A4'
            : targetFormat === 'A3'
            ? 'CARTAZ AÇOUGUE A3'
            : targetFormat === 'expositor-a3-2x2'
            ? 'CARTAZ EXTERNOS'
            : 'MÉDIOS';

        const destFolder = exportOrganizeByFormat ? `${targetFolder}\\${formatSubFolder}` : targetFolder;

        const baseSlug = (item.description || 'cartaz')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 50);
        const f7Tag = item.f7 ? `${item.f7}-` : '';
        const paperTag = doc.layout.paper ? `-[${doc.layout.paper}]` : '';

        // 1. Exporta .skcartaz
        if (exportFormatSk) {
          try {
            let skFileName: string;
            if (doc.layout.template === 'imported-psd' && doc.layout.artwork?.source?.fileName) {
              skFileName = psdFileNameToCartazFileName(doc.layout.artwork.source.fileName, doc.layout.paper);
            } else {
              skFileName = `${f7Tag}${baseSlug}${paperTag}-oferta.skcartaz`;
            }
            if (desktopMode) {
              const skPath = `${destFolder}\\${skFileName}`;
              await saveExportDocument(skPath, doc);
            } else {
              const blob = new Blob([serialize(doc)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = skFileName;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            skCount++;
          } catch (e) {
            errors.push(`SK ${item.f7}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 2. Exporta .psd editável preservando camadas e modelos
        if (exportFormatPsd && desktopMode) {
          if (doc.layout.template === 'imported-psd') {
            const artwork = doc.layout.artwork;
            const wholePart = artwork.priceParts.find(p => p.role === 'whole');
            const fractionPart = artwork.priceParts.find(p => p.role === 'fraction');
            const validityPart = artwork.priceParts.find(p => p.role === 'validity');

            if (wholePart && fractionPart && artwork.source.sourcePath) {
              const parts = splitCentsToParts(item.scheduledPriceCents);
              const psdFileName = artwork.source.fileName
                ? (artwork.source.fileName.endsWith('.psd') ? artwork.source.fileName : `${artwork.source.fileName}.psd`)
                : `${f7Tag}${baseSlug}${paperTag}-oferta.psd`;
              const outputPsdPath = `${destFolder}\\${psdFileName}`;

              const campaignValidity = formatCampaignDateToValidity(
                activeCampaign.campaignDate,
                artwork.posterModel
              );
              const targetValidity =
                typeof doc.product.validityText === 'string' && doc.product.validityText.trim()
                  ? doc.product.validityText.trim()
                  : campaignValidity;

              const wholeVal = parts.whole;
              const fractionVal = parts.fraction;
              const boxWholeVal = (doc.product as any).hasBoxPrice && (doc.product as any).boxPriceCents
                ? String(Math.floor((doc.product as any).boxPriceCents / 100))
                : undefined;
              const boxFractionVal = (doc.product as any).hasBoxPrice && (doc.product as any).boxPriceCents
                ? String((doc.product as any).boxPriceCents % 100).padStart(2, '0')
                : undefined;

              const titlePart = artwork.templateParts?.find(p => p.role === 'title');
              const compPart = artwork.templateParts?.find(p => p.role === 'complement');
              const packPart = artwork.templateParts?.find(p => p.role === 'packaging');
              const catPart = artwork.templateParts?.find(p => p.role === 'category');

              try {
                const res = await exportDerivedPsdDirect({
                  sourcePsdPath: artwork.source.sourcePath,
                  outputPsdPath,
                  allowSamePath: false,
                  title: doc.product.name,
                  complement: doc.product.complement,
                  packaging: doc.product.unit,
                  category: (doc.product as any).category,
                  whole: wholeVal,
                  fraction: fractionVal,
                  validityText: targetValidity || undefined,
                  hasBoxPrice: Boolean((doc.product as any).hasBoxPrice),
                  boxQuantity: Number((doc.product as any).boxQuantity) || 12,
                  boxUnitLabel: ((doc.product as any).boxUnitLabel as string) || 'UND.',
                  boxWhole: boxWholeVal,
                  boxFraction: boxFractionVal,
                  roles: {
                    wholeLayerId: wholePart.layerId,
                    fractionLayerId: fractionPart.layerId,
                    fractionRuleLayerId: artwork.priceParts?.find(p => p.role === 'fractionRule')?.layerId,
                    validityLayerId: validityPart?.layerId,
                    titleLayerId: titlePart?.layerId,
                    complementLayerId: compPart?.layerId,
                    packagingLayerId: packPart?.layerId,
                    categoryLayerId: catPart?.layerId,
                  },
                });

                if (res.ok) {
                  psdCount++;
                } else {
                  errors.push(`PSD ${item.f7}: ${res.error}`);
                }
              } catch (e) {
                errors.push(`PSD ${item.f7}: ${e instanceof Error ? e.message : String(e)}`);
              }
            } else {
              errors.push(`PSD ${item.f7}: PSD original não localizado ou camadas não mapeadas.`);
            }
          }
        }
      }

      setExportResult({ psdCount, skCount, candidateCount: candidates.length, errors });
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  const handlePsdSavedForOffer = async (path: string, savedDocument: Cartaz) => {
    if (!activeCampaign || !psdOfferContext) return;
    const replaceExisting = psdOfferContext.mode !== 'add';
    const linked = linkSavedPosterToCampaignItem(
      activeCampaign,
      psdOfferContext.offerItemId,
      path,
      savedDocument,
      replaceExisting
    );
    await persistUpdate(linked);
    if (onRefreshLibrary) await onRefreshLibrary();
    setPreviewKey(`${psdOfferContext.offerItemId}::${path}`);
  };

  const handleLinkLibraryPoster = async (offerItemId: string, poster: IndexedCartaz, replaceExisting = false) => {
    if (!activeCampaign) return;
    const linked = linkSavedPosterToCampaignItem(activeCampaign, offerItemId, poster.path, poster.document, replaceExisting);
    await persistUpdate(linked);
    setPreviewKey(`${offerItemId}::${poster.path}`);
  };

  const handleDeleteLibraryPoster = async (posterPath: string) => {
    await removeLibraryFile(posterPath);
    if (previewKey && previewKey.endsWith(`::${posterPath}`)) {
      setPreviewKey(null);
    }
    if (onRefreshLibrary) await onRefreshLibrary();
  };

  const handleRemoveMissingItems = async () => {
    if (!activeCampaign) return;
    const missingIds = new Set(matchViews.filter(v => v.missingPoster).map(v => v.item.id));
    if (missingIds.size === 0) return;
    let updated = activeCampaign;
    for (const itemId of missingIds) {
      updated = removeCampaignItem(updated, itemId);
    }
    await persistUpdate(updated);
  };

  const handleRepairInvertedPoster = async (cartazPath: string, doc: Cartaz) => {
    if (doc.layout.template !== 'imported-psd') return;
    const { artwork, correctedPriceCents } = repairInvertedPsdArtwork(doc.layout.artwork);
    const now = new Date().toISOString();
    const updatedDoc: Cartaz = {
      ...doc,
      product: {
        ...doc.product,
        priceCents: correctedPriceCents ?? doc.product.priceCents,
      },
      layout: {
        ...doc.layout,
        artwork,
      },
      metadata: {
        ...doc.metadata,
        updatedAt: now,
      },
    };
    await saveDocument(cartazPath, updatedDoc, true);
    if (onRefreshLibrary) await onRefreshLibrary();
  };

  const handleConvertAllToA6 = async () => {
    if (!activeCampaign) return;
    let convertedCount = 0;
    for (const v of matchViews) {
      for (const m of v.matchedPosters) {
        if (m.libraryCartaz) {
          const currentPaper = m.libraryCartaz.document.layout.paper;
          if (currentPaper !== 'A6') {
            const updatedDoc: Cartaz = {
              ...m.libraryCartaz.document,
              layout: {
                ...m.libraryCartaz.document.layout,
                paper: 'A6',
              },
              metadata: {
                ...m.libraryCartaz.document.metadata,
                updatedAt: new Date().toISOString(),
              },
            };
            const savePath = m.libraryCartaz.path || m.state.cartazPath;
            await saveDocument(savePath, updatedDoc, true);
            convertedCount++;
          }
        }
      }
      for (const unlinked of v.unlinkedLibraryPosters) {
        if (unlinked.document.layout.paper !== 'A6') {
          const updatedDoc: Cartaz = {
            ...unlinked.document,
            layout: {
              ...unlinked.document.layout,
              paper: 'A6',
            },
            metadata: {
              ...unlinked.document.metadata,
              updatedAt: new Date().toISOString(),
            },
          };
          await saveDocument(unlinked.path, updatedDoc, true);
          convertedCount++;
        }
      }
    }
    if (onRefreshLibrary) await onRefreshLibrary();
    setFormatTab('A6');
    alert(
      convertedCount > 0
        ? `${convertedCount} cartaz(es) foram alterados para Pequenos (A6) com sucesso!`
        : 'Todos os cartazes já estão configurados no formato Pequenos (A6).'
    );
  };

  const handleApplyPriceToLibrary = async (cartazPath: string, doc: Cartaz, newPriceCents: number) => {
    const updatedDoc: Cartaz = {
      ...doc,
      product: {
        ...doc.product,
        priceCents: newPriceCents,
      },
      metadata: {
        ...doc.metadata,
        updatedAt: new Date().toISOString(),
      },
    };
    await saveDocument(cartazPath, updatedDoc, true);
    if (onRefreshLibrary) await onRefreshLibrary();
  };

  const matchViews = useMemo(() => {
    if (!activeCampaign) return [];
    return buildCampaignMatchViews(activeCampaign, libraryIndex);
  }, [activeCampaign, libraryIndex]);

  const formatCounts = useMemo(() => {
    const counts: Record<FormatTab, number> = {
      todos: 0,
      A6: 0,
      A5: 0,
      'A5-flv': 0,
      A4: 0,
      A3: 0,
      'expositor-a3-2x2': 0,
    };
    for (const v of matchViews) {
      const firstMatchedDoc = v.matchedPosters[0]?.scheduledDocument || v.matchedPosters[0]?.libraryCartaz?.document;
      const isFlv = isFlvItem(v.item.description, firstMatchedDoc?.product?.name);
      for (const m of v.matchedPosters) {
        if (!m.libraryCartaz) continue;
        const fmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz.document, m.state.cartazPath);
        counts.todos++;
        if (fmt === 'A5') {
          if (isFlv) {
            counts['A5-flv']++;
          } else {
            counts.A5++;
          }
        } else if (fmt in counts) {
          counts[fmt as FormatTab]++;
        }
      }
    }
    return counts;
  }, [matchViews]);

  const currentFormatQueueCount = useMemo(() => {
    let count = 0;
    for (const v of matchViews) {
      const firstMatchedDoc = v.matchedPosters[0]?.scheduledDocument || v.matchedPosters[0]?.libraryCartaz?.document;
      const isFlv = isFlvItem(v.item.description, firstMatchedDoc?.product?.name);
      for (const m of v.matchedPosters) {
        if (!m.state.selected || !m.scheduledDocument || m.state.status === 'impresso') continue;
        if (formatTab !== 'todos') {
          const posterFmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz?.document, m.state.cartazPath);
          if (formatTab === 'A5-flv') {
            if (posterFmt !== 'A5' || !isFlv) continue;
          } else if (formatTab === 'A5') {
            if (posterFmt !== 'A5' || isFlv) continue;
          } else {
            if (posterFmt !== formatTab) continue;
          }
        }
        count++;
      }
    }
    return count;
  }, [matchViews, formatTab]);

  const filteredViews = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase('pt-BR');
    return matchViews.filter(v => {
      const firstMatchedDoc = v.matchedPosters[0]?.scheduledDocument || v.matchedPosters[0]?.libraryCartaz?.document;
      const isFlv = isFlvItem(v.item.description, firstMatchedDoc?.product?.name);
      if (q && !`${v.item.f7} ${v.item.description}`.toLocaleLowerCase('pt-BR').includes(q)) {
        return false;
      }
      if (statusFilter === 'com-cartaz') return v.matchedPosters.some(m => Boolean(m.libraryCartaz));
      if (statusFilter === 'sem-cartaz') return v.missingPoster;
      if (statusFilter === 'pendente' || statusFilter === 'preparado' || statusFilter === 'impresso') {
        return v.matchedPosters.some(m => m.state.status === statusFilter);
      }
      if (formatTab !== 'todos') {
        const hasMatchingFormat = v.matchedPosters.some(m => {
          if (!m.libraryCartaz) return false;
          const fmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz.document, m.state.cartazPath);
          if (formatTab === 'A5-flv') {
            return fmt === 'A5' && isFlv;
          }
          if (formatTab === 'A5') {
            return fmt === 'A5' && !isFlv;
          }
          return fmt === formatTab;
        });
        if (!hasMatchingFormat) return false;
      }
      return true;
    });
  }, [matchViews, searchQuery, statusFilter, formatTab]);

  const selectedPosterPreview = useMemo(() => {
    for (const v of matchViews) {
      for (const m of v.matchedPosters) {
        const key = `${v.item.id}::${m.state.cartazPath}`;
        if (key === previewKey && m.scheduledDocument) {
          return {
            item: v.item,
            posterState: m.state,
            currentPriceCents: m.currentPriceCents,
            priceMismatchReason: m.priceMismatchReason,
            poster: posterFromDocument(m.scheduledDocument),
            doc: m.scheduledDocument,
          };
        }
      }
    }
    for (const v of matchViews) {
      for (const m of v.matchedPosters) {
        if (m.scheduledDocument) {
          return {
            item: v.item,
            posterState: m.state,
            currentPriceCents: m.currentPriceCents,
            priceMismatchReason: m.priceMismatchReason,
            poster: posterFromDocument(m.scheduledDocument),
            doc: m.scheduledDocument,
          };
        }
      }
    }
    return null;
  }, [matchViews, previewKey]);

  // Lista de chaves de cartazes navegáveis na visualização atual (respeitando busca e filtros de formato)
  const navigablePosterKeys = useMemo(() => {
    const keys: string[] = [];
    for (const v of filteredViews) {
      const firstMatchedDoc = v.matchedPosters[0]?.scheduledDocument || v.matchedPosters[0]?.libraryCartaz?.document;
      const isFlv = isFlvItem(v.item.description, firstMatchedDoc?.product?.name);
      const posters = formatTab === 'todos'
        ? v.matchedPosters
        : v.matchedPosters.filter(m => {
            if (!m.libraryCartaz) return true;
            const fmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz.document, m.state.cartazPath);
            if (formatTab === 'A5-flv') {
              return fmt === 'A5' && isFlv;
            }
            if (formatTab === 'A5') {
              return fmt === 'A5' && !isFlv;
            }
            return fmt === formatTab;
          });
      if (posters.length > 0) {
        keys.push(`${v.item.id}::${posters[0].state.cartazPath}`);
      }
    }
    return keys;
  }, [filteredViews, formatTab]);

  const handleToggleRowSelect = (itemId: string, shiftKey: boolean) => {
    if (shiftKey && lastSelectedItemIdRef.current) {
      const ids = filteredViews.map(v => v.item.id);
      const startIdx = ids.indexOf(lastSelectedItemIdRef.current);
      const endIdx = ids.indexOf(itemId);
      if (startIdx !== -1 && endIdx !== -1) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        setSelectedItemIds(prev => {
          const next = new Set(prev);
          for (let i = from; i <= to; i++) next.add(ids[i]);
          return next;
        });
        lastSelectedItemIdRef.current = itemId;
        return;
      }
    }
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    lastSelectedItemIdRef.current = itemId;
  };

  const handleSelectVisibleItems = (checked: boolean) => {
    if (!checked) {
      setSelectedItemIds(new Set());
      lastSelectedItemIdRef.current = null;
      return;
    }
    setSelectedItemIds(new Set(filteredViews.map(v => v.item.id)));
  };

  const handleSelectPendingOrDivergent = () => {
    const ids = filteredViews
      .filter(v => v.matchedPosters.some(m => m.priceMismatchReason || m.state.status !== 'impresso'))
      .map(v => v.item.id);
    setSelectedItemIds(new Set(ids));
  };

  const selectedViews = useMemo(
    () => matchViews.filter(v => selectedItemIds.has(v.item.id)),
    [matchViews, selectedItemIds]
  );

  const selectedLinkedPosterCount = useMemo(
    () =>
      selectedViews.reduce(
        (acc, v) => acc + v.matchedPosters.filter(m => Boolean(m.scheduledDocument || m.libraryCartaz?.document)).length,
        0
      ),
    [selectedViews]
  );

  const allVisibleSelected =
    filteredViews.length > 0 && filteredViews.every(v => selectedItemIds.has(v.item.id));
  const someVisibleSelected =
    filteredViews.some(v => selectedItemIds.has(v.item.id));

  useEffect(() => {
    if (masterCheckboxRef.current) {
      masterCheckboxRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  const selectedBatchEditQueue = useMemo<BatchEditItem[]>(() => {
    const items: BatchEditItem[] = [];
    for (const v of selectedViews) {
      const firstMatchedDoc = v.matchedPosters[0]?.scheduledDocument || v.matchedPosters[0]?.libraryCartaz?.document;
      const isFlv = isFlvItem(v.item.description, firstMatchedDoc?.product?.name);
      const matchingPosters =
        formatTab === 'todos'
          ? v.matchedPosters
          : v.matchedPosters.filter(m => {
              if (!m.libraryCartaz) return false;
              const fmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz.document, m.state.cartazPath);
              if (formatTab === 'A5-flv') return fmt === 'A5' && isFlv;
              if (formatTab === 'A5') return fmt === 'A5' && !isFlv;
              return fmt === formatTab;
            });
      const target = matchingPosters.find(m => m.libraryCartaz) ?? v.matchedPosters.find(m => m.libraryCartaz);
      if (target) {
        items.push({
          path: target.state.cartazPath,
          scheduledPriceCents: v.item.scheduledPriceCents,
          f7: v.item.f7,
          description: v.item.description,
        });
      }
    }
    return items;
  }, [selectedViews, formatTab]);

  const handlePrintSelectedItems = () => {
    if (!activeCampaign || selectedViews.length === 0) return;
    const queue: Poster[] = [];
    const keys = new Set<string>();
    const blockedProducts: string[] = [];
    let distinctCount = 0;

    for (const v of selectedViews) {
      const firstMatchedDoc = v.matchedPosters[0]?.scheduledDocument || v.matchedPosters[0]?.libraryCartaz?.document;
      const isFlv = isFlvItem(v.item.description, firstMatchedDoc?.product?.name);
      for (const m of v.matchedPosters) {
        if (!m.scheduledDocument) continue;
        if (formatTab !== 'todos') {
          const posterFmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz?.document, m.state.cartazPath);
          if (formatTab === 'A5-flv' && (posterFmt !== 'A5' || !isFlv)) continue;
          if (formatTab === 'A5' && (posterFmt !== 'A5' || isFlv)) continue;
          if (formatTab !== 'A5-flv' && formatTab !== 'A5' && posterFmt !== formatTab) continue;
        }
        if (m.priceMismatchReason) {
          blockedProducts.push(`F7 ${v.item.f7} (${v.item.description}): ${m.priceMismatchReason}`);
          continue;
        }
        const poster = posterFromDocument(m.scheduledDocument);
        for (let c = 0; c < Math.max(1, m.state.copies); c++) {
          queue.push(poster);
        }
        const normPath = m.state.cartazPath.replace(/\//g, '\\').toLocaleLowerCase('en-US');
        keys.add(`${v.item.id}::${normPath}`);
        distinctCount++;
      }
    }

    if (blockedProducts.length > 0 && queue.length === 0) {
      throw new Error(`Impressão bloqueada por divergência de preço/camadas: ${blockedProducts[0]}`);
    }
    if (queue.length === 0) {
      throw new Error('Os produtos selecionados não possuem cartaz vinculado pronto para impressão.');
    }
    setAwaitingPrintConfirm({ keys, count: distinctCount });
    const targetPaper = formatTab === 'todos' ? 'A6' : formatTab === 'A5-flv' ? 'A5' : formatTab;
    onPrintBatch(queue, { formatConfig: { paper: targetPaper, orientation: 'portrait' } });
  };

  const handleSendSelectedToConductor = () => {
    if ((!onAddBatchToConductor && !onAddToConductor) || selectedViews.length === 0) return;
    const entries: { cartaz: Cartaz; path: string; copies?: number }[] = [];
    for (const v of selectedViews) {
      for (const m of v.matchedPosters) {
        const doc = m.scheduledDocument || m.libraryCartaz?.document;
        if (doc) {
          entries.push({ cartaz: doc, path: m.state.cartazPath, copies: m.state.copies });
        }
      }
    }
    if (entries.length === 0) return;
    if (onAddBatchToConductor) {
      onAddBatchToConductor(entries);
    } else if (onAddToConductor) {
      for (const entry of entries) {
        onAddToConductor(entry.cartaz, entry.path);
      }
    }
    setSelectedItemIds(new Set());
  };

  const handleOpenExportSelected = () => {
    setExportScope('checked-rows');
    setExportResult(null);
    setExportProgress(null);
    setShowExportModal(true);
  };

  const handleDeleteSelectedItems = async () => {
    if (!activeCampaign || selectedItemIds.size === 0) return;
    const count = selectedItemIds.size;
    const confirmed = await askConfirm({
      title: `Remover ${count} produto(s) selecionado(s)?`,
      description: `Os ${count} produto(s) marcados serão removidos desta pasta de ofertas.`,
      note: 'Os arquivos de cartaz na biblioteca local não serão apagados.',
      confirmLabel: `Remover ${count} item(ns)`,
      cancelLabel: 'Cancelar',
      tone: 'danger',
    });
    if (!confirmed) return;
    const updated: OfferCampaign = {
      ...activeCampaign,
      items: activeCampaign.items.filter(it => !selectedItemIds.has(it.id)),
      updatedAt: new Date().toISOString(),
    };
    await persistUpdate(updated);
    setSelectedItemIds(new Set());
    lastSelectedItemIdRef.current = null;
  };

  // Navegação e atalhos rápidos do operador (somente quando a aba Pastas de Ofertas está ativa)
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasActiveModalDialog() || isTextEditingElement(e.target)) {
        return;
      }

      if (e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        run(async () => {
          if (selectedItemIds.size > 0) {
            handlePrintSelectedItems();
          } else {
            handleTriggerPartialPrint(false);
          }
        });
        return;
      }

      if (e.key === 'Delete' && selectedItemIds.size > 0) {
        e.preventDefault();
        run(() => handleDeleteSelectedItems());
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (navigablePosterKeys.length === 0) return;
        e.preventDefault();

        const currentIndex = previewKey ? navigablePosterKeys.indexOf(previewKey) : -1;
        let nextIndex = 0;
        if (e.key === 'ArrowDown') {
          nextIndex = currentIndex < navigablePosterKeys.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : navigablePosterKeys.length - 1;
        }

        const nextKey = navigablePosterKeys[nextIndex];
        if (nextKey) {
          setPreviewKey(nextKey);
          const safeId = `poster-row-${nextKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          const el = document.getElementById(safeId);
          el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, navigablePosterKeys, previewKey, selectedItemIds, selectedViews, activeCampaign, formatTab]);

  const campaignStats = useMemo(() => {
    let totalItems = matchViews.length;
    let missing = 0;
    let pending = 0;
    let prepared = 0;
    let printed = 0;
    let divergent = 0;
    for (const v of matchViews) {
      if (v.missingPoster) missing++;
      for (const m of v.matchedPosters) {
        if (!m.libraryCartaz) continue;
        if (m.priceMismatchReason) divergent++;
        if (m.state.status === 'pendente') pending++;
        else if (m.state.status === 'preparado') prepared++;
        else if (m.state.status === 'impresso') printed++;
      }
    }
    return { totalItems, missing, pending, prepared, printed, divergent };
  }, [matchViews]);

  const psdSuggestions = useMemo(() => {
    if (!activeCampaign) return [];
    return buildCampaignPsdSuggestions(activeCampaign, scannedPsds);
  }, [activeCampaign, scannedPsds]);

  const psdSuggestionsByItemId = useMemo(() => {
    const map = new Map<string, (typeof psdSuggestions)[number]>();
    for (const s of psdSuggestions) {
      map.set(s.item.id, s);
    }
    return map;
  }, [psdSuggestions]);

  const pairingStats = useMemo(() => {
    let exactF7 = 0;
    let descriptionSimilar = 0;
    let ambiguous = 0;
    let noSuggestion = 0;
    let alreadyLinked = 0;
    for (const s of psdSuggestions) {
      if (s.alreadyLinked) alreadyLinked++;
      if (s.ambiguous) ambiguous++;
      if (s.reason === 'f7-exact') exactF7++;
      else if (s.reason === 'description-similar') descriptionSimilar++;
      else noSuggestion++;
    }
    return { exactF7, descriptionSimilar, ambiguous, noSuggestion, alreadyLinked };
  }, [psdSuggestions]);

  const batchConfirmationSummary = useMemo(
    () => buildPsdBatchConfirmationSummary(psdSuggestions, psdPairingSelections, scannedPsds),
    [psdSuggestions, psdPairingSelections, scannedPsds]
  );

  const filteredPsdSuggestions = useMemo(() => {
    const q = psdFilterText.trim().toLocaleLowerCase('pt-BR');
    return psdSuggestions.filter(s => {
      const sel = psdPairingSelections[s.item.id] ?? getDefaultSelectionForSuggestion(s);
      if (psdReasonFilter === 'f7-exact' && s.reason !== 'f7-exact') return false;
      if (psdReasonFilter === 'description-similar' && s.reason !== 'description-similar') return false;
      if (psdReasonFilter === 'no-suggestion' && s.reason !== 'no-suggestion') return false;
      if (psdReasonFilter === 'ambiguous' && !s.ambiguous) return false;
      if (psdReasonFilter === 'already-linked' && !s.alreadyLinked) return false;
      if (psdReasonFilter === 'selected-batch' && (!sel.includedInBatch || !sel.psdPath)) return false;

      if (!q) return true;
      const candidateNames = s.candidates.map(c => c.psd.name).join(' ');
      const selectedPsdName = scannedPsds.find(p => p.path === sel.psdPath)?.name ?? '';
      const haystack = `${s.item.f7} ${s.item.description} ${s.reasonLabel} ${candidateNames} ${selectedPsdName}`.toLocaleLowerCase(
        'pt-BR'
      );
      return haystack.includes(q);
    });
  }, [psdSuggestions, psdFilterText, psdReasonFilter, psdPairingSelections, scannedPsds]);

  const PSD_PAGE_SIZE = 40;
  const totalPsdPages = Math.ceil(filteredPsdSuggestions.length / PSD_PAGE_SIZE) || 1;
  const pagedPsdSuggestions = useMemo(() => {
    const start = psdPage * PSD_PAGE_SIZE;
    return filteredPsdSuggestions.slice(start, start + PSD_PAGE_SIZE);
  }, [filteredPsdSuggestions, psdPage]);

  const handleTriggerPartialPrint = (reprintPrinted = false) => {
    if (!activeCampaign) return;
    const queue: Poster[] = [];
    const keys = new Set<string>();
    const blockedProducts: string[] = [];
    const limit = Math.max(1, Math.min(200, batchSize));
    let distinctPostersCount = 0;
    for (const v of matchViews) {
      const firstMatchedDoc = v.matchedPosters[0]?.scheduledDocument || v.matchedPosters[0]?.libraryCartaz?.document;
      const isFlv = isFlvItem(v.item.description, firstMatchedDoc?.product?.name);
      for (const m of v.matchedPosters) {
        if (!m.state.selected || !m.scheduledDocument) continue;
        if (!reprintPrinted && m.state.status === 'impresso') continue;
        if (formatTab !== 'todos') {
          const posterFmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz?.document, m.state.cartazPath);
          if (formatTab === 'A5-flv') {
            if (posterFmt !== 'A5' || !isFlv) continue;
          } else if (formatTab === 'A5') {
            if (posterFmt !== 'A5' || isFlv) continue;
          } else {
            if (posterFmt !== formatTab) continue;
          }
        }
        if (m.priceMismatchReason) {
          blockedProducts.push(`F7 ${v.item.f7} (${v.item.description}): ${m.priceMismatchReason}`);
          continue;
        }
        if (distinctPostersCount >= limit) break;
        const poster = posterFromDocument(m.scheduledDocument);
        for (let c = 0; c < m.state.copies; c++) {
          queue.push(poster);
        }
        const normPath = m.state.cartazPath.replace(/\//g, '\\').toLocaleLowerCase('en-US');
        keys.add(`${v.item.id}::${normPath}`);
        distinctPostersCount++;
      }
      if (distinctPostersCount >= limit) break;
    }
    if (blockedProducts.length > 0 && queue.length === 0) {
      throw new Error(
        `Impressão bloqueada por divergência de preço/camadas: ${blockedProducts[0]}`
      );
    }
    if (queue.length === 0) {
      throw new Error(
        reprintPrinted
          ? 'Selecione ao menos um cartaz válido para reimprimir.'
          : `Não há cartazes selecionados ${formatTab !== 'todos' ? `no formato ${formatTab} ` : ''}com status Preparado/Pendente para imprimir.`
      );
    }
    setAwaitingPrintConfirm({ keys, count: distinctPostersCount });
    const targetPaper = formatTab === 'todos' ? 'A6' : formatTab === 'A5-flv' ? 'A5' : formatTab;
    onPrintBatch(queue, { formatConfig: { paper: targetPaper, orientation: 'portrait' } });
  };

  const handlePrintSinglePoster = (
    doc?: Cartaz | null,
    cartazPath?: string,
    copies = 1,
    explicitPoster?: Poster
  ) => {
    const poster = explicitPoster ?? (doc ? posterFromDocument(doc) : null);
    if (!poster) return;
    const targetPaper = getPosterPaperFormat(doc, cartazPath);
    const queue: Poster[] = [];
    for (let i = 0; i < copies; i++) {
      queue.push(poster);
    }
    onPrintBatch(queue, { formatConfig: { paper: targetPaper, orientation: 'portrait' } });
  };

  const handleExportSinglePosterPsd = async (
    doc?: Cartaz | null,
    item?: CampaignItem | null,
    cartazPath?: string
  ) => {
    if (!doc) throw new Error('Nenhum cartaz selecionado para exportar.');
    if (doc.layout.template !== 'imported-psd' || !doc.layout.artwork?.source?.sourcePath) {
      throw new Error('Este cartaz não possui arquivo PSD original vinculado.');
    }

    const artwork = doc.layout.artwork;
    const wholePart = artwork.priceParts?.find(p => p.role === 'whole');
    const fractionPart = artwork.priceParts?.find(p => p.role === 'fraction');
    if (!wholePart || !fractionPart) {
      throw new Error('As camadas de preço (inteiro/centavos) não estão mapeadas neste cartaz.');
    }

    const chosenFolder = await chooseScantechExportFolder();
    if (!chosenFolder) return;

    const targetFormat = getPosterPaperFormat(doc, cartazPath);
    const desc = item?.description || doc.product.name || 'cartaz';
    const baseSlug = desc
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const f7Tag = item?.f7 ? `${item.f7}-` : '';
    const paperTag = targetFormat ? `-[${targetFormat}]` : '';
    const isBox = Boolean((doc.product as any)?.hasBoxPrice);
    const boxTag = isBox ? '-CAIXA' : '';
    const psdFileName = `${f7Tag}${baseSlug}${paperTag}${boxTag}-oferta.psd`;
    const cleanFolder = chosenFolder.replace(/[\\/]+$/, '');
    const outputPsdPath = `${cleanFolder}\\${psdFileName}`;

    const scheduledCents = item?.scheduledPriceCents ?? doc.product.priceCents ?? 0;
    const parts = splitCentsToParts(scheduledCents);

    const campaignValidity = activeCampaign
      ? formatCampaignDateToValidity(activeCampaign.campaignDate, artwork.posterModel)
      : undefined;
    const targetValidity =
      typeof doc.product.validityText === 'string' && doc.product.validityText.trim()
        ? doc.product.validityText.trim()
        : campaignValidity;

    const boxWholeVal = (doc.product as any).hasBoxPrice && (doc.product as any).boxPriceCents
      ? String(Math.floor((doc.product as any).boxPriceCents / 100))
      : undefined;
    const boxFractionVal = (doc.product as any).hasBoxPrice && (doc.product as any).boxPriceCents
      ? String((doc.product as any).boxPriceCents % 100).padStart(2, '0')
      : undefined;

    const titlePart = artwork.templateParts?.find(p => p.role === 'title');
    const compPart = artwork.templateParts?.find(p => p.role === 'complement');
    const packPart = artwork.templateParts?.find(p => p.role === 'packaging');
    const catPart = artwork.templateParts?.find(p => p.role === 'category');

    const res = await exportDerivedPsdDirect({
      sourcePsdPath: artwork.source.sourcePath,
      outputPsdPath,
      allowSamePath: false,
      title: doc.product.name,
      complement: doc.product.complement,
      packaging: doc.product.unit,
      category: (doc.product as any).category,
      whole: parts.whole,
      fraction: parts.fraction,
      validityText: targetValidity || undefined,
      hasBoxPrice: Boolean((doc.product as any).hasBoxPrice),
      boxQuantity: Number((doc.product as any).boxQuantity) || 12,
      boxUnitLabel: ((doc.product as any).boxUnitLabel as string) || 'UND.',
      boxWhole: boxWholeVal,
      boxFraction: boxFractionVal,
      roles: {
        wholeLayerId: wholePart.layerId,
        fractionLayerId: fractionPart.layerId,
        fractionRuleLayerId: artwork.priceParts?.find(p => p.role === 'fractionRule')?.layerId,
        validityLayerId: artwork.priceParts?.find(p => p.role === 'validity')?.layerId,
        titleLayerId: titlePart?.layerId,
        complementLayerId: compPart?.layerId,
        packagingLayerId: packPart?.layerId,
        categoryLayerId: catPart?.layerId,
      },
    });

    if (!res.ok) {
      throw new Error(`Falha ao exportar PSD: ${res.error}`);
    }

    alert(`✅ Arquivo PSD exportado com sucesso!\n\nArquivo: ${psdFileName}\nPasta: ${cleanFolder}`);
  };

  const handleAddPosterVersion = async (
    offerItemId: string,
    sourcePoster: IndexedCartaz,
    targetFormat: PaperFormat,
    isBox = false,
    boxPackageType: 'caixa' | 'fardo' = 'caixa'
  ) => {
    if (!activeCampaign) return;
    const sourceDoc = sourcePoster.document;
    const originalPath = sourcePoster.path;

    const dir = originalPath.substring(0, Math.max(originalPath.lastIndexOf('/'), originalPath.lastIndexOf('\\')));
    const baseName = originalPath
      .substring(dir.length + 1)
      .replace(/\.skcartaz$/i, '')
      .replace(/-\[(A6|A5|A4|A3|expositor-a3-2x2)\]/gi, '')
      .replace(/-(CAIXA|FARDO)/gi, '');
    const sep = originalPath.includes('/') ? '/' : '\\';
    const boxTag = isBox ? (boxPackageType === 'fardo' ? '-FARDO' : '-CAIXA') : '';
    const newFileName = `${baseName}-[${targetFormat}]${boxTag}.skcartaz`;
    const newPath = dir ? `${dir}${sep}${newFileName}` : newFileName;

    const item = activeCampaign.items.find(i => i.id === offerItemId);
    const unitPriceCents = item?.scheduledPriceCents ?? sourceDoc.product.priceCents ?? 0;
    let boxQty = 12;
    let boxPriceCents = unitPriceCents * 12;

    if (isBox) {
      const typeLabel = boxPackageType === 'fardo' ? 'Fardo' : 'Caixa';
      const qtyStr = window.prompt(
        `Configurar Preço por ${typeLabel} no cartaz ${targetFormat} de "${sourceDoc.product.name}":\n\nQuantas unidades vêm no ${typeLabel.toLowerCase()}?`,
        '12'
      );
      if (qtyStr === null) return;
      boxQty = Math.max(1, parseInt(qtyStr, 10) || 12);

      const defaultPriceFormatted = formatCentsBr(unitPriceCents * boxQty);
      const priceStr = window.prompt(
        `Qual o preço total do ${typeLabel.toLowerCase()} com ${boxQty} unidades? (em R$)`,
        defaultPriceFormatted
      );
      if (priceStr === null) return;
      const cleanPrice = priceStr.replace(/\./g, '').replace(',', '.');
      const parsedPrice = parseFloat(cleanPrice);
      boxPriceCents = !isNaN(parsedPrice) && parsedPrice > 0 ? Math.round(parsedPrice * 100) : (unitPriceCents * boxQty);
    }

    const now = new Date().toISOString();
    const newDoc: Cartaz = {
      ...sourceDoc,
      id: crypto.randomUUID(),
      layout: {
        ...sourceDoc.layout,
        paper: targetFormat,
      },
      product: {
        ...sourceDoc.product,
        ...(isBox
          ? {
              hasBoxPrice: true,
              boxPackageType,
              boxQuantity: boxQty,
              boxUnitLabel: ((sourceDoc.product as any).boxUnitLabel as string) || 'UND.',
              boxPriceCents,
            }
          : {
              hasBoxPrice: false,
              boxPriceCents: undefined,
            }),
      },
      metadata: {
        ...sourceDoc.metadata,
        createdAt: now,
        updatedAt: now,
      },
    };

    await saveDocument(newPath, newDoc, true);
    const linked = linkSavedPosterToCampaignItem(
      activeCampaign,
      offerItemId,
      newPath,
      newDoc,
      false
    );
    await persistUpdate(linked);
    if (onRefreshLibrary) await onRefreshLibrary();
    setPreviewKey(`${offerItemId}::${newPath}`);
  };

  const handleConfirmPrinted = async () => {
    if (!activeCampaign || !awaitingPrintConfirm) return;
    const updated = confirmBatchPrinted(activeCampaign, awaitingPrintConfirm.keys);
    await persistUpdate(updated);
    setAwaitingPrintConfirm(null);
  };

  const visibleCampaigns = campaigns.filter(c => showArchived || !c.archived);

  return (
    <section className="panel offer-folders">
      <div className="library-heading">
        <div>
          <h2>Pastas de Ofertas</h2>
          <p>Programe ofertas futuras via Excel (.xlsx, .xls) e imprima cartazes sem alterar os preços vigentes da biblioteca.</p>
        </div>
        <div className="toolbar">
          <label className="f7-filter" style={{ marginTop: 0 }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
            />
            Mostrar arquivadas
          </label>
          <button className="subtle" onClick={() => run(reloadCampaigns)}>
            Atualizar pastas
          </button>
        </div>
      </div>

      {loadErrors.map(err => (
        <p className="error-text" role="alert" key={err}>
          {err}
        </p>
      ))}

      <div className="library-layout">
        <aside aria-label="Lista de pastas de ofertas">
          <form
            className="offer-create-form"
            onSubmit={e => {
              e.preventDefault();
              run(handleCreateCampaign);
            }}
          >
            <label>
              Nova pasta de ofertas
              <input
                placeholder="Ex.: Ofertas de Amanhã"
                maxLength={80}
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
              />
            </label>
            <label>
              Data da campanha
              <input
                type="date"
                required
                value={newFolderDate}
                onChange={e => setNewFolderDate(e.target.value)}
              />
            </label>
            <button type="submit" style={{ width: '100%' }}>
              + Criar Pasta de Ofertas
            </button>
          </form>

          <div className="offer-folder-list">
            {visibleCampaigns.map(c => (
              <button
                key={c.id}
                className={c.id === activeId ? 'folder selected' : 'folder'}
                onClick={() => {
                  setActiveId(c.id);
                  setRenaming(false);
                  setAwaitingPrintConfirm(null);
                }}
              >
                <strong>{c.name}</strong>
                <small style={{ display: 'block', fontSize: '11px', opacity: 0.8 }}>
                  Data: {c.campaignDate} · {c.items.length} produto(s)
                  {c.archived ? ' · [Arquivada]' : ''}
                </small>
              </button>
            ))}
            {visibleCampaigns.length === 0 && (
              <p className="empty" style={{ padding: '16px 8px' }}>
                Nenhuma pasta de ofertas encontrada. Crie uma acima para começar.
              </p>
            )}
          </div>
        </aside>

        <div>
          {!activeCampaign ? (
            <p className="empty">Selecione ou crie uma pasta de ofertas à esquerda.</p>
          ) : (
            <>
              <div className="offer-campaign-header">
                <div>
                  <h3>
                    {activeCampaign.name}{' '}
                    <span className="status">Campanha: {activeCampaign.campaignDate}</span>
                    {activeCampaign.archived && (
                      <span className="comparison-status conflict" style={{ marginLeft: 8 }}>
                        Arquivada
                      </span>
                    )}
                  </h3>
                  <small className="document-path">
                    ID: {activeCampaign.id}
                    {activeCampaign.sourceExcel
                      ? ` · Planilha: ${activeCampaign.sourceExcel.fileName} (${activeCampaign.sourceExcel.sheetName})`
                      : ' · Nenhuma planilha importada ainda'}
                  </small>
                </div>
                <div className="toolbar">
                  <button onClick={() => run(handleOpenExcel)}>Importar Excel (.xlsx, .xls)</button>
                  <button
                    className={psdFolder ? '' : 'subtle'}
                    onClick={() => {
                      if (psdFolder) {
                        setShowPsdManagerModal(true);
                      } else {
                        run(handleChoosePsdFolder);
                      }
                    }}
                  >
                    📁 {psdFolder ? `Pasta PSDs (${scannedPsds.length} ref.)` : 'Procurar Pasta de PSDs'}
                  </button>
                  <button className="subtle" onClick={() => setShowPsdManagerModal(true)}>
                    ⚡ Pareamento PSD ({psdPaperSize})
                  </button>
                  <button className="subtle" onClick={() => run(handleSyncLibrary)}>
                    Localizar cartazes na biblioteca
                  </button>
                  <button
                    type="button"
                    className={`subtle sk-offer-mode-btn ${compactViewMode ? 'is-compact' : ''}`}
                    onClick={() => setCompactViewMode(prev => !prev)}
                    title="Alternar entre visual limpo (ações no item clicado) ou expandido (todas as ações abertas)"
                  >
                    {compactViewMode ? '✨ Modo Limpo' : '📋 Modo Expandido'}
                  </button>
                  <button
                    className="subtle sk-offer-a6-btn"
                    title="Altera o formato de todos os cartazes desta pasta para Pequeno (A6)"
                    onClick={() => run(handleConvertAllToA6)}
                  >
                    🏷️ Definir todos como Pequenos (A6)
                  </button>
                  <button
                    className="subtle"
                    onClick={() => {
                      setRenameText(activeCampaign.name);
                      setRenameDate(activeCampaign.campaignDate);
                      setRenaming(true);
                    }}
                  >
                    Renomear / Data
                  </button>
                  <button className="subtle" onClick={() => run(handleDuplicateCampaign)}>
                    Duplicar pasta
                  </button>
                  <button className="subtle" onClick={() => run(handleArchiveToggle)}>
                    {activeCampaign.archived ? 'Desarquivar' : 'Arquivar'}
                  </button>
                  <button
                    className="subtle danger"
                    title="Excluir esta pasta de ofertas"
                    onClick={() => run(handleDeleteCampaign)}
                  >
                    Excluir pasta
                  </button>
                </div>
              </div>

              {renaming && (
                <form
                  className="psd-fields"
                  onSubmit={e => {
                    e.preventDefault();
                    run(handleRenameCampaign);
                  }}
                >
                  <label>
                    Nome da campanha
                    <input
                      required
                      maxLength={80}
                      value={renameText}
                      onChange={e => setRenameText(e.target.value)}
                    />
                  </label>
                  <label>
                    Data programada
                    <input
                      type="date"
                      required
                      value={renameDate}
                      onChange={e => setRenameDate(e.target.value)}
                    />
                  </label>
                  <div className="toolbar" style={{ alignItems: 'end' }}>
                    <button type="submit">Salvar alterações</button>
                    <button type="button" className="subtle" onClick={() => setRenaming(false)}>
                      Cancelar
                    </button>
                  </div>
                </form>
              )}

              <div className="import-stats" aria-live="polite">
                <span>
                  <strong>{campaignStats.totalItems}</strong> produtos na pasta
                </span>
                <span>
                  <strong>{campaignStats.prepared}</strong> cartazes preparados
                </span>
                <span>
                  <strong>{campaignStats.printed}</strong> cartazes impressos
                </span>
                <span>
                  <strong>{campaignStats.pending}</strong> pendentes
                </span>
                <span>
                  <strong>{campaignStats.missing}</strong> produtos sem cartaz
                </span>
              </div>

              {awaitingPrintConfirm && (
                <div className="import-warning" role="region" aria-label="Confirmação de impressão">
                  <strong>
                    Impressão enviada ({awaitingPrintConfirm.count} cartaz(es) deste lote).
                  </strong>{' '}
                  Confirme abaixo se a impressão em A5 foi concluída corretamente para marcá-los como{' '}
                  <strong>Impresso</strong> e avançar para a próxima parte:
                  <div className="toolbar" style={{ marginTop: 10 }}>
                    <button onClick={() => run(handleConfirmPrinted)}>
                      Confirmar impressão concluída
                    </button>
                    <button className="subtle" onClick={() => setAwaitingPrintConfirm(null)}>
                      Manter como preparado (não confirmar ainda)
                    </button>
                  </div>
                </div>
              )}

              {activeCampaign.items.length > 0 && (
                <>
                  {/* BARRA VISUAL DE ETAPAS DE PRODUÇÃO POR TAMANHO */}
                  <div className="sk-offer-stage-section">
                    <div className="sk-offer-stage-header">
                      <span className="sk-offer-stage-title">
                        Etapas de Produção por Formato (Pastas da Loja)
                      </span>
                      <span className="sk-offer-stage-subtitle">
                        Selecione um tamanho para produzir e imprimir em lote
                      </span>
                    </div>

                    <div className="sk-offer-stage-grid">
                      {(
                        [
                          { id: 'todos', label: 'Todos os Tamanhos', icon: '📋', subtitle: 'Visão geral' },
                          { id: 'A6', label: '1. Pequenos (A6)', icon: '🏷️', subtitle: 'Topo do A4 em pé' },
                          { id: 'A5', label: '2. Médios (A5)', icon: '📐', subtitle: 'Mercearia / Geral' },
                          { id: 'A5-flv', label: '2.1 Médios FLV (A5)', icon: '🥦', subtitle: 'Hortifruti / FLV.' },
                          { id: 'A4', label: '3. Cartaz A4', icon: '📄', subtitle: 'Folha A4 inteira' },
                          { id: 'A3', label: '4. Açougue (A3)', icon: '🥩', subtitle: 'Folha A3 vertical' },
                          { id: 'expositor-a3-2x2', label: '5. Externos (2×2)', icon: '🏢', subtitle: 'Expositor 4 folhas A3' },
                        ] as const
                      ).map(tab => {
                        const isSelected = formatTab === tab.id;
                        const count = formatCounts[tab.id as FormatTab] ?? 0;
                        return (
                          <button
                            type="button"
                            key={tab.id}
                            className={`sk-offer-stage-card ${isSelected ? 'is-selected' : ''}`}
                            aria-pressed={isSelected}
                            onClick={() => setFormatTab(tab.id as FormatTab)}
                          >
                            <div className="sk-offer-stage-top">
                              <span className="sk-offer-stage-icon" aria-hidden="true">{tab.icon}</span>
                              <span className={`sk-offer-stage-count ${count > 0 ? 'has-items' : ''}`}>
                                {count} {count === 1 ? 'cartaz' : 'cartazes'}
                              </span>
                            </div>
                            <div className="sk-offer-stage-label">{tab.label}</div>
                            <div className="sk-offer-stage-sub">{tab.subtitle}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* PAINEL DE CONTROLE DE IMPRESSÃO DO FORMATO ATIVO */}
                  <div className={`sk-offer-batch-bar ${formatTab !== 'todos' ? 'is-filtered' : ''}`}>
                    <div className="sk-offer-batch-info">
                      <div className="sk-offer-batch-title-row">
                        <span aria-hidden="true">
                          {formatTab === 'A6' ? '🏷️' : formatTab === 'A5' ? '📐' : formatTab === 'A5-flv' ? '🥦' : formatTab === 'A4' ? '📄' : formatTab === 'A3' ? '🥩' : formatTab === 'expositor-a3-2x2' ? '🏢' : '📋'}
                        </span>
                        <strong className="sk-offer-batch-title">
                          Lote Ativo: {formatTab === 'todos' ? 'Todos os Tamanhos' : formatTab === 'A6' ? 'Pequenos (A6)' : formatTab === 'A5' ? 'Médios Geral (A5)' : formatTab === 'A5-flv' ? 'Médios FLV (A5)' : formatTab === 'A4' ? 'Cartaz A4' : formatTab === 'A3' ? 'Açougue (A3)' : 'Externos (2×2)'}
                        </strong>
                        <span className={`sk-offer-batch-count ${currentFormatQueueCount > 0 ? 'has-queue' : ''}`}>
                          · {currentFormatQueueCount} na fila para imprimir
                        </span>
                      </div>
                      <div className="sk-offer-batch-hint">
                        {formatTab === 'A6'
                          ? 'Epson L14150: Impressão vertical no topo da folha A4 (Superior: 0, centralizado)'
                          : formatTab === 'A5' || formatTab === 'A5-flv'
                            ? 'Epson L14150: Impressão vertical centralizada no A4 (Superior: 0)'
                            : formatTab === 'A4'
                              ? 'Epson L14150: Folha A4 vertical completa'
                              : formatTab === 'A3'
                                ? 'Epson L14150: Folha A3 vertical completa (bandeja traseira)'
                                : 'Impressão proporcional ao formato selecionado'}
                      </div>
                    </div>

                    <div className="sk-offer-batch-controls">
                      <label className="sk-offer-batch-size">
                        Por vez:
                        <input
                          type="number"
                          min={1}
                          max={200}
                          value={batchSize}
                          onChange={e => setBatchSize(Math.max(1, parseInt(e.target.value, 10) || 10))}
                        />
                      </label>
                      <button
                        type="button"
                        className="sk-offer-btn-print"
                        onClick={() =>
                          run(async () => {
                            handleTriggerPartialPrint(false);
                          })
                        }
                      >
                        🖨️ Imprimir Lote ({currentFormatQueueCount > 0 ? Math.min(currentFormatQueueCount, batchSize) : 0})
                      </button>
                      <button
                        type="button"
                        className="subtle"
                        style={{ padding: '7px 12px', fontSize: 12 }}
                        onClick={() =>
                          run(async () => {
                            handleTriggerPartialPrint(true);
                          })
                        }
                      >
                        🔄 Reimprimir
                      </button>
                      <button
                        type="button"
                        className="sk-offer-btn-export"
                        onClick={() => setShowExportModal(true)}
                      >
                        📦 Exportar (PSD / SK)
                      </button>
                    </div>
                  </div>

                  <div className="library-toolbar" style={{ marginBottom: 14 }}>
                    <input
                      aria-label="Pesquisar F7 ou descrição na pasta de ofertas"
                      placeholder="Pesquisar F7 ou descrição…"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                    />
                    <select
                      aria-label="Filtrar cartazes da campanha"
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
                    >
                      <option value="todos">Todos os itens</option>
                      <option value="com-cartaz">Com cartaz vinculado</option>
                      <option value="sem-cartaz">Sem cartaz na biblioteca</option>
                      <option value="preparado">Status: Preparado</option>
                      <option value="pendente">Status: Pendente</option>
                      <option value="impresso">Status: Impresso</option>
                    </select>
                    {filteredViews.length > 0 && (
                      <button
                        type="button"
                        className="subtle"
                        style={{ padding: '8px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                        title="Selecionar rapidamente itens pendentes ou com divergência"
                        onClick={handleSelectPendingOrDivergent}
                      >
                        Selecionar pendentes
                      </button>
                    )}
                    {campaignStats.missing > 0 && (
                      <button
                        type="button"
                        className="subtle"
                        style={{ padding: '8px 12px', fontSize: 12, color: '#dc2626', fontWeight: 700, whiteSpace: 'nowrap' }}
                        title="Remover da pasta de ofertas todos os produtos que estão sem cartaz vinculado"
                        onClick={() =>
                          run(async () => {
                            const ok = await askConfirm({
                              title: 'Remover produtos sem cartaz?',
                              description: `Remover ${campaignStats.missing} produto(s) sem cartaz vinculado desta pasta de ofertas?`,
                              confirmLabel: 'Remover sem cartaz',
                              cancelLabel: 'Cancelar',
                              tone: 'danger',
                            });
                            if (ok) await handleRemoveMissingItems();
                          })
                        }
                      >
                        🗑️ Apagar sem cartaz ({campaignStats.missing})
                      </button>
                    )}
                  </div>

                  <div className="offer-workspace" style={selectedItemIds.size > 0 ? { paddingBottom: 92 } : undefined}>
                    <div
                      ref={tableWrapRef}
                      className={`import-table-wrap sk-marquee-surface ${isMarqueeDragging ? 'is-marquee-dragging' : ''}`}
                      onMouseDown={handleTableMarqueeMouseDown}
                      title="Dica: clique e arraste com o mouse para selecionar vários produtos de uma vez (segure Ctrl/Shift para somar)"
                    >
                      <table className="import-table">
                        <thead>
                          <tr>
                            <th style={{ width: 38, textAlign: 'center' }}>
                              <input
                                ref={masterCheckboxRef}
                                type="checkbox"
                                className="sk-row-checkbox"
                                aria-label="Selecionar todos os produtos visíveis"
                                title="Selecionar ou desmarcar todos os produtos visíveis (ou arraste o mouse para selecionar vários)"
                                checked={allVisibleSelected}
                                onChange={e => handleSelectVisibleItems(e.target.checked)}
                              />
                            </th>
                            <th>F7</th>
                            <th>Produto (Excel)</th>
                            <th>Preço Programado</th>
                            <th>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                                <span>Cartazes da Biblioteca e Impressão</span>
                                <div style={{ display: 'inline-flex', gap: 6, fontWeight: 'normal' }}>
                                  <button
                                    type="button"
                                    className="subtle"
                                    style={{ padding: '2px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 4 }}
                                    title="Marcar todos os cartazes filtrados para impressão"
                                    onClick={() => handleSelectAllFiltered(true)}
                                  >
                                    ☑ Todos
                                  </button>
                                  <button
                                    type="button"
                                    className="subtle"
                                    style={{ padding: '2px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 4 }}
                                    title="Desmarcar todos os cartazes filtrados"
                                    onClick={() => handleSelectAllFiltered(false)}
                                  >
                                    ☐ Nenhum
                                  </button>
                                </div>
                              </div>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredViews.map(v => (
                            <tr
                              key={v.item.id}
                              data-marquee-id={v.item.id}
                              className={selectedItemIds.has(v.item.id) ? 'sk-row-selected' : undefined}
                            >
                              <td
                                className="sk-checkbox-cell"
                                onClick={e => {
                                  e.stopPropagation();
                                  handleToggleRowSelect(v.item.id, e.shiftKey);
                                }}
                              >
                                <input
                                  type="checkbox"
                                  className="sk-row-checkbox"
                                  aria-label={`Selecionar ${v.item.description}`}
                                  title="Selecionar produto (Shift+Clique seleciona intervalo · ou arraste com o mouse)"
                                  checked={selectedItemIds.has(v.item.id)}
                                  onClick={e => {
                                    e.stopPropagation();
                                    handleToggleRowSelect(v.item.id, e.shiftKey);
                                  }}
                                  onChange={() => {}}
                                />
                              </td>
                              <td className="code-cell">{v.item.f7}</td>
                              <td>
                                {editingDescriptionId === v.item.id ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                                    <input
                                      value={editingDescriptionValue}
                                      onChange={e => setEditingDescriptionValue(e.target.value)}
                                      placeholder="Ex: REFRIGERANTE SUKITA 2L SABORES"
                                      style={{ width: '100%', padding: '6px 8px', fontSize: 13, fontWeight: 700 }}
                                      autoFocus
                                    />
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                      <button
                                        type="button"
                                        className="subtle"
                                        style={{ padding: '4px 8px', fontSize: 11, background: '#0284c7', color: '#fff' }}
                                        onClick={() =>
                                          run(async () => {
                                            await persistUpdate(
                                              updateCampaignItemDescription(activeCampaign, v.item.id, editingDescriptionValue)
                                            );
                                            setEditingDescriptionId(null);
                                          })
                                        }
                                      >
                                        Salvar
                                      </button>
                                      <button
                                        type="button"
                                        className="subtle"
                                        style={{ padding: '4px 8px', fontSize: 11 }}
                                        title="Adiciona 'SABORES' no final da descrição"
                                        onClick={() => {
                                          if (!editingDescriptionValue.toUpperCase().includes('SABORES')) {
                                            setEditingDescriptionValue(prev => `${prev.trim()} SABORES`);
                                          }
                                        }}
                                      >
                                        + Sabores
                                      </button>
                                      <button
                                        type="button"
                                        className="subtle"
                                        style={{ padding: '4px 8px', fontSize: 11 }}
                                        onClick={() => setEditingDescriptionId(null)}
                                      >
                                        Cancelar
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      <strong>{v.item.description}</strong>
                                      <button
                                        type="button"
                                        className="subtle"
                                        style={{ padding: '2px 6px', fontSize: 10 }}
                                        title="Editar descrição ou marcar como SABORES"
                                        onClick={() => {
                                          setEditingDescriptionId(v.item.id);
                                          setEditingDescriptionValue(v.item.description);
                                        }}
                                      >
                                        ✏️ Editar / Sabores
                                      </button>
                                      <button
                                        type="button"
                                        className="subtle"
                                        style={{ padding: '2px 6px', fontSize: 10, color: '#ef4444' }}
                                        title="Remover esta linha/produto da pasta de ofertas"
                                        onClick={() =>
                                          run(async () => {
                                            const ok = await askConfirm({
                                              title: 'Remover produto da pasta de ofertas?',
                                              description: `Remover "${v.item.description}" (F7 ${v.item.f7}) desta pasta de ofertas?`,
                                              confirmLabel: 'Remover',
                                              cancelLabel: 'Cancelar',
                                              tone: 'danger',
                                            });
                                            if (ok) {
                                              await persistUpdate(removeCampaignItem(activeCampaign, v.item.id));
                                              setSelectedItemIds(prev => {
                                                if (!prev.has(v.item.id)) return prev;
                                                const next = new Set(prev);
                                                next.delete(v.item.id);
                                                return next;
                                              });
                                            }
                                          })
                                        }
                                      >
                                        🗑️ Remover
                                      </button>
                                    </div>
                                    <small style={{ display: 'block', marginTop: 4 }}>
                                      Linha Excel: {v.item.rowNumber}
                                    </small>
                                  </div>
                                )}
                              </td>
                              <td>
                                {editingPriceId === v.item.id ? (
                                  <div className="toolbar">
                                    <input
                                      inputMode="decimal"
                                      value={editingPriceValue}
                                      onChange={e => setEditingPriceValue(e.target.value)}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') {
                                          run(async () => {
                                            const cents = parseExcelPriceToCents(editingPriceValue);
                                            await persistUpdate(
                                              updateScheduledPrice(activeCampaign, v.item.id, cents)
                                            );
                                            setEditingPriceId(null);
                                          });
                                        } else if (e.key === 'Escape') {
                                          setEditingPriceId(null);
                                        }
                                      }}
                                      autoFocus
                                      style={{ width: 90, padding: 6 }}
                                    />
                                    <button
                                      className="subtle"
                                      onClick={() =>
                                        run(async () => {
                                          const cents = parseExcelPriceToCents(editingPriceValue);
                                          await persistUpdate(
                                            updateScheduledPrice(activeCampaign, v.item.id, cents)
                                          );
                                          setEditingPriceId(null);
                                        })
                                      }
                                    >
                                      OK
                                    </button>
                                  </div>
                                ) : (
                                  <div>
                                    <strong className="sk-offer-scheduled-price">
                                      {money(v.item.scheduledPriceCents)}
                                    </strong>
                                    <div>
                                      <button
                                        className="subtle"
                                        style={{ padding: '4px 8px', fontSize: 11, marginTop: 4 }}
                                        onClick={() => {
                                          setEditingPriceId(v.item.id);
                                          setEditingPriceValue(
                                            (v.item.scheduledPriceCents / 100)
                                              .toFixed(2)
                                              .replace('.', ',')
                                          );
                                        }}
                                      >
                                        Editar preço futuro
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </td>
                              <td>
                                {v.missingPoster ? (
                                  <div className="toolbar" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                                    <span className="comparison-status conflict">
                                      Sem cartaz (F7 {v.item.f7})
                                    </span>
                                    {scannedPsds.length > 0 && (() => {
                                      const sug = psdSuggestionsByItemId.get(v.item.id);
                                      return (
                                        <>
                                          {sug && (
                                            <span
                                              className={
                                                sug.ambiguous || sug.reason === 'no-suggestion'
                                                  ? 'comparison-status conflict'
                                                  : 'comparison-status'
                                              }
                                              style={{ fontSize: 11 }}
                                            >
                                              PSD: {sug.reasonLabel}
                                              {sug.ambiguous
                                                ? ` (${sug.candidates.length} candidatos)`
                                                : sug.recommendedPsd
                                                  ? ` (${sug.recommendedPsd.name})`
                                                  : ''}
                                            </span>
                                          )}
                                          <button
                                            className="subtle"
                                            style={{ padding: '6px 10px', fontSize: 12 }}
                                            onClick={() => {
                                              setPsdFilterText(v.item.f7 || v.item.description);
                                              setShowPsdManagerModal(true);
                                            }}
                                          >
                                            ⚡ Revisar no Pareamento PSD
                                          </button>
                                        </>
                                      );
                                    })()}
                                    <button
                                      className="subtle"
                                      style={{ padding: '6px 10px', fontSize: 12 }}
                                      onClick={() =>
                                        setPsdOfferContext({
                                          folderId: activeCampaign.id,
                                          offerItemId: v.item.id,
                                          productCode: v.item.f7,
                                          description: v.item.description,
                                          futurePriceCents: v.item.scheduledPriceCents,
                                        })
                                      }
                                    >
                                      Importar arte PSD
                                    </button>
                                  </div>
                                ) : (
                                  <div className="offer-posters-cell">
                                    {(() => {
                                      const posters = formatTab === 'todos'
                                        ? v.matchedPosters
                                        : v.matchedPosters.filter(m => {
                                            if (!m.libraryCartaz) return true;
                                            const fmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz.document, m.state.cartazPath);
                                            if (formatTab === 'A5-flv') return fmt === 'A5';
                                            return fmt === formatTab;
                                          });

                                      if (posters.length === 0) return null;

                                      const m = posters[0];
                                      const extraPosters = posters.slice(1);
                                      const key = `${v.item.id}::${m.state.cartazPath}`;
                                      const isFirstPoster = navigablePosterKeys[0] === key;
                                      const isPreviewActive = key === previewKey || (previewKey === null && isFirstPoster);
                                      const safeId = `poster-row-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

                                      const isExplicitlyCollapsed = collapsedActionsKeys.has(key);
                                      const isExplicitlyExpanded = expandedActionsKeys.has(key);
                                      const isExpanded = !compactViewMode || isExplicitlyExpanded || (
                                        actionsOpen && isPreviewActive && !isExplicitlyCollapsed
                                      );

                                      const fmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz?.document, m.state.cartazPath);
                                      const badge = getFormatBadge(fmt);
                                      const hasBox = Boolean((m.scheduledDocument?.product as any)?.hasBoxPrice);
                                      const boxPackageType = (m.scheduledDocument?.product as any)?.boxPackageType === 'fardo' ? 'Fardo' : 'Caixa';
                                      const boxQuantity = (m.scheduledDocument?.product as any)?.boxQuantity || 12;
                                      const boxUnitLabel = (m.scheduledDocument?.product as any)?.boxUnitLabel || 'UND.';

                                      return (
                                        <div
                                          key={key}
                                          id={safeId}
                                          className={`offer-poster-row ${isPreviewActive ? 'is-active' : ''}`}
                                          onClick={() => setPreviewKey(key)}
                                        >
                                          {/* LINHA PRINCIPAL RESUMIDA (1 linha limpa por produto) */}
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220 }}>
                                              <input
                                                type="checkbox"
                                                checked={m.state.selected}
                                                disabled={!m.libraryCartaz}
                                                onClick={e => e.stopPropagation()}
                                                onChange={e => handleTogglePosterSelection(v.item.id, m.state.cartazPath, e.target.checked)}
                                              />
                                              <strong className="sk-offer-poster-title">
                                                {m.libraryCartaz?.document.product.name ?? 'Arquivo ausente'}{' '}
                                                {m.libraryCartaz?.document.product.complement ?? ''}
                                              </strong>
                                              <select
                                                value={fmt}
                                                onClick={e => e.stopPropagation()}
                                                style={{
                                                  fontSize: 10.5,
                                                  fontWeight: 700,
                                                  padding: '2px 6px',
                                                  borderRadius: 6,
                                                  background: badge.bg,
                                                  color: badge.text,
                                                  border: `1px solid ${badge.text}`,
                                                  cursor: 'pointer',
                                                }}
                                                title="Alterar formato deste cartaz (A6, A5, A4, etc.)"
                                                onChange={e => {
                                                  const newFormat = e.target.value as PaperFormat;
                                                  if (m.libraryCartaz) {
                                                    run(async () => {
                                                      const updatedDoc: Cartaz = {
                                                        ...m.libraryCartaz!.document,
                                                        layout: {
                                                          ...m.libraryCartaz!.document.layout,
                                                          paper: newFormat,
                                                        },
                                                        metadata: {
                                                          ...m.libraryCartaz!.document.metadata,
                                                          updatedAt: new Date().toISOString(),
                                                        },
                                                      };
                                                      const savePath = m.libraryCartaz!.path || m.state.cartazPath;
                                                      await saveDocument(savePath, updatedDoc, true);
                                                      if (onRefreshLibrary) await onRefreshLibrary();
                                                    });
                                                  }
                                                }}
                                              >
                                                <option value="A6">🏷️ Pequeno (A6)</option>
                                                <option value="A5">📐 Médio (A5)</option>
                                                <option value="A4">📄 Cartaz A4</option>
                                                <option value="A3">🥩 Açougue (A3)</option>
                                                <option value="expositor-a3-2x2">🏢 Externos (2×2)</option>
                                              </select>
                                              {hasBox && (
                                                <span className="sk-offer-badge-box">
                                                  📦 {boxPackageType} {boxQuantity} {boxUnitLabel}
                                                </span>
                                              )}
                                              {extraPosters.length > 0 && (
                                                <span
                                                  className="sk-offer-badge-extra"
                                                  title={`Este produto também tem ${extraPosters.length} outro(s) tamanho(s). Clique em Ações para gerenciar.`}
                                                >
                                                  📏 +{extraPosters.length} outro tamanho
                                                </span>
                                              )}
                                              {v.unlinkedLibraryPosters.length > 0 && (
                                                <span
                                                  className="sk-offer-badge-lib"
                                                  title={`${v.unlinkedLibraryPosters.length} cartaz(es) na biblioteca disponíveis para vincular`}
                                                >
                                                  📚 {v.unlinkedLibraryPosters.length} na bibl.
                                                </span>
                                              )}
                                            </div>

                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                              <span className="sk-offer-poster-price-wrap">
                                                Preço:{' '}
                                                <strong className="sk-offer-poster-price">{money(v.item.scheduledPriceCents)}</strong>
                                              </span>
                                              <button
                                                type="button"
                                                className={`subtle sk-offer-row-btn ${isPreviewActive ? 'is-preview-active' : ''}`}
                                                onClick={e => {
                                                  e.stopPropagation();
                                                  setPreviewKey(key);
                                                }}
                                                title="Ver prévia deste cartaz no painel lateral"
                                              >
                                                👁️ Prévia
                                              </button>
                                              <button
                                                type="button"
                                                style={{
                                                  padding: '4px 9px',
                                                  fontSize: 11.5,
                                                  fontWeight: 700,
                                                  background: '#16a34a',
                                                  color: '#ffffff',
                                                  borderRadius: 6,
                                                  cursor: 'pointer',
                                                  border: 'none',
                                                  boxShadow: '0 1px 3px rgba(22,163,74,0.3)',
                                                }}
                                                title="Imprimir 1 teste deste cartaz agora na impressora"
                                                onClick={e => {
                                                  e.stopPropagation();
                                                  setPreviewKey(key);
                                                  if (m.scheduledDocument) {
                                                    handlePrintSinglePoster(m.scheduledDocument, m.state.cartazPath, 1);
                                                  }
                                                }}
                                              >
                                                🖨️ Imprimir
                                              </button>
                                              <button
                                                type="button"
                                                className={`subtle sk-offer-row-btn ${isExpanded ? 'is-expanded' : ''}`}
                                                onClick={e => {
                                                  e.stopPropagation();
                                                  if (isExpanded) {
                                                    setActionsOpen(false);
                                                    setCollapsedActionsKeys(prev => new Set(prev).add(key));
                                                    setExpandedActionsKeys(prev => {
                                                      const next = new Set(prev);
                                                      next.delete(key);
                                                      return next;
                                                    });
                                                  } else {
                                                    setActionsOpen(true);
                                                    setExpandedActionsKeys(prev => new Set(prev).add(key));
                                                    setCollapsedActionsKeys(prev => {
                                                      const next = new Set(prev);
                                                      next.delete(key);
                                                      return next;
                                                    });
                                                    setPreviewKey(key);
                                                  }
                                                }}
                                                title={isExpanded ? 'Recolher ferramentas e ações deste cartaz' : 'Exibir ferramentas, outros tamanhos e opções deste cartaz'}
                                              >
                                                {isExpanded ? '⚙️ Recolher ▲' : '⚙️ Ações ▼'}
                                              </button>
                                            </div>
                                          </div>

                                          {/* GAVETA FLUIDA DE DETALHES, OUTROS TAMANHOS E CARTAZES DA BIBLIOTECA */}
                                          <div
                                            style={{
                                              display: 'grid',
                                              gridTemplateRows: isExpanded ? '1fr' : '0fr',
                                              transition: 'grid-template-rows 0.24s cubic-bezier(0.4, 0, 0.2, 1)',
                                            }}
                                          >
                                            <div style={{ overflow: 'hidden' }}>
                                              <div
                                                className="sk-offer-drawer-body"
                                                style={{ opacity: isExpanded ? 1 : 0 }}
                                              >
                                                {m.currentPriceCents !== null && m.currentPriceCents !== v.item.scheduledPriceCents && (
                                                  <div className="sk-offer-drawer-meta" style={{ marginBottom: 4 }}>
                                                    (Preço base registrado na biblioteca: {money(m.currentPriceCents)})
                                                  </div>
                                                )}
                                                <small className="sk-offer-drawer-meta">
                                                  📄 Cartaz: <strong>{m.state.cartazPath.split(/[\\/]/).pop()}</strong>
                                                  {m.libraryCartaz?.document.layout.template === 'imported-psd' && m.libraryCartaz.document.layout.artwork.source.sourcePath && (
                                                    <span className="sk-offer-drawer-psd">
                                                      · 🎨 PSD: {m.libraryCartaz.document.layout.artwork.source.sourcePath.split(/[\\/]/).pop()}
                                                    </span>
                                                  )}
                                                </small>

                                                {m.priceMismatchReason && (
                                                  <div
                                                    className="import-warning"
                                                    role="alert"
                                                    style={{ marginTop: 6, marginBottom: 6, fontSize: 12 }}
                                                  >
                                                    <strong>Impressão bloqueada:</strong> {m.priceMismatchReason}
                                                    {m.hasInvertedLayers && m.libraryCartaz && (
                                                      <div style={{ marginTop: 6 }}>
                                                        <button
                                                          className="subtle"
                                                          style={{ padding: '4px 10px', fontSize: 12 }}
                                                          onClick={e => {
                                                            e.stopPropagation();
                                                            run(() =>
                                                              handleRepairInvertedPoster(
                                                                m.libraryCartaz!.path,
                                                                m.libraryCartaz!.document
                                                              )
                                                            );
                                                          }}
                                                        >
                                                          Corrigir inversão Reais/Centavos neste cartaz
                                                        </button>
                                                      </div>
                                                    )}
                                                  </div>
                                                )}

                                                <div className="toolbar" style={{ alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                                                  <label style={{ fontSize: 12 }}>
                                                    Cópias:{' '}
                                                    <input
                                                      type="number"
                                                      min={1}
                                                      max={999}
                                                      value={m.state.copies}
                                                      onClick={e => e.stopPropagation()}
                                                      onChange={e => handleCopiesChange(v.item.id, m.state.cartazPath, parseInt(e.target.value, 10) || 1)}
                                                      style={{ width: 60, padding: '4px 6px' }}
                                                    />
                                                  </label>
                                                  <select
                                                    aria-label="Status de impressão"
                                                    value={m.state.status}
                                                    onClick={e => e.stopPropagation()}
                                                    onChange={e => handleStatusChange(v.item.id, m.state.cartazPath, e.target.value as PrintStatus)}
                                                    style={{ padding: '4px 8px', fontSize: 12 }}
                                                  >
                                                    <option value="pendente">Pendente</option>
                                                    <option value="preparado">Preparado</option>
                                                    <option value="impresso">Impresso</option>
                                                  </select>
                                                  <button
                                                    type="button"
                                                    style={{
                                                      padding: '5px 10px',
                                                      fontSize: 12,
                                                      fontWeight: 600,
                                                      background: '#0284c7',
                                                      color: '#ffffff',
                                                      borderRadius: 6,
                                                      cursor: 'pointer',
                                                      display: 'inline-flex',
                                                      alignItems: 'center',
                                                      gap: 4,
                                                      border: 'none',
                                                      boxShadow: '0 1px 3px rgba(2,132,199,0.3)',
                                                    }}
                                                    title="Exportar arquivo PSD deste cartaz para uma pasta à sua escolha"
                                                    onClick={e => {
                                                      e.stopPropagation();
                                                      setPreviewKey(key);
                                                      run(async () => {
                                                        if (m.scheduledDocument) {
                                                          await handleExportSinglePosterPsd(
                                                            m.scheduledDocument,
                                                            v.item,
                                                            m.state.cartazPath
                                                          );
                                                        }
                                                      });
                                                    }}
                                                  >
                                                    📦 Exportar PSD
                                                  </button>
                                                  {(() => {
                                                    if (!m.libraryCartaz) return null;
                                                    const currentFmt = getPosterPaperFormat(m.scheduledDocument || m.libraryCartaz?.document, m.state.cartazPath);
                                                    const isThisBox = Boolean(
                                                      (m.scheduledDocument?.product as any)?.hasBoxPrice ||
                                                      (m.libraryCartaz?.document.product as any)?.hasBoxPrice
                                                    );

                                                    const hasA6 = posters.some(p => {
                                                      const pFmt = getPosterPaperFormat(p.scheduledDocument || p.libraryCartaz?.document, p.state.cartazPath);
                                                      return pFmt === 'A6';
                                                    });

                                                    const hasA5Normal = posters.some(p => {
                                                      const pFmt = getPosterPaperFormat(p.scheduledDocument || p.libraryCartaz?.document, p.state.cartazPath);
                                                      const box = Boolean((p.scheduledDocument?.product as any)?.hasBoxPrice || (p.libraryCartaz?.document.product as any)?.hasBoxPrice);
                                                      return pFmt === 'A5' && !box;
                                                    });

                                                    const hasA5Box = posters.some(p => {
                                                      const pFmt = getPosterPaperFormat(p.scheduledDocument || p.libraryCartaz?.document, p.state.cartazPath);
                                                      const box = Boolean((p.scheduledDocument?.product as any)?.hasBoxPrice || (p.libraryCartaz?.document.product as any)?.hasBoxPrice);
                                                      return pFmt === 'A5' && box;
                                                    });

                                                    const hasA4Normal = posters.some(p => {
                                                      const pFmt = getPosterPaperFormat(p.scheduledDocument || p.libraryCartaz?.document, p.state.cartazPath);
                                                      const box = Boolean((p.scheduledDocument?.product as any)?.hasBoxPrice || (p.libraryCartaz?.document.product as any)?.hasBoxPrice);
                                                      return pFmt === 'A4' && !box;
                                                    });

                                                    const hasA4Box = posters.some(p => {
                                                      const pFmt = getPosterPaperFormat(p.scheduledDocument || p.libraryCartaz?.document, p.state.cartazPath);
                                                      const box = Boolean((p.scheduledDocument?.product as any)?.hasBoxPrice || (p.libraryCartaz?.document.product as any)?.hasBoxPrice);
                                                      return pFmt === 'A4' && box;
                                                    });

                                                    return (
                                                      <>
                                                        {/* 1. Opções para A5 */}
                                                        {!hasA5Normal && (currentFmt !== 'A5' || isThisBox) && (
                                                          <button
                                                            type="button"
                                                            className="subtle sk-offer-ver-btn is-green"
                                                            title="Criar versão Médio (A5) normal / unitário sem caixa e adicionar na pasta"
                                                            onClick={e => {
                                                              e.stopPropagation();
                                                              run(async () => {
                                                                await handleAddPosterVersion(v.item.id, m.libraryCartaz!, 'A5', false);
                                                              });
                                                            }}
                                                          >
                                                            📐 + Versão Médio (A5)
                                                          </button>
                                                        )}
                                                        {!hasA5Box && (currentFmt !== 'A5' || !isThisBox) && (
                                                          <>
                                                            <button
                                                              type="button"
                                                              className="subtle sk-offer-ver-btn is-green"
                                                              title="Criar versão Médio (A5) com preço por caixa e adicionar na pasta"
                                                              onClick={e => {
                                                                e.stopPropagation();
                                                                run(async () => {
                                                                  await handleAddPosterVersion(v.item.id, m.libraryCartaz!, 'A5', true, 'caixa');
                                                                });
                                                              }}
                                                            >
                                                              📦 + A5 por Caixa
                                                            </button>
                                                            <button
                                                              type="button"
                                                              className="subtle sk-offer-ver-btn is-green"
                                                              title="Criar versão Médio (A5) com preço por fardo e adicionar na pasta"
                                                              onClick={e => {
                                                                e.stopPropagation();
                                                                run(async () => {
                                                                  await handleAddPosterVersion(v.item.id, m.libraryCartaz!, 'A5', true, 'fardo');
                                                                });
                                                              }}
                                                            >
                                                              📦 + A5 por Fardo
                                                            </button>
                                                          </>
                                                        )}

                                                        {/* 2. Opções para A4 */}
                                                        {!hasA4Normal && (currentFmt !== 'A4' || isThisBox) && (
                                                          <button
                                                            type="button"
                                                            className="subtle sk-offer-ver-btn is-indigo"
                                                            title="Criar versão Cartaz A4 (Folha inteira) normal / unitário e adicionar na pasta"
                                                            onClick={e => {
                                                              e.stopPropagation();
                                                              run(async () => {
                                                                await handleAddPosterVersion(v.item.id, m.libraryCartaz!, 'A4', false);
                                                              });
                                                            }}
                                                          >
                                                            📄 + Versão Cartaz A4
                                                          </button>
                                                        )}
                                                        {!hasA4Box && (currentFmt !== 'A4' || !isThisBox) && (
                                                          <>
                                                            <button
                                                              type="button"
                                                              className="subtle sk-offer-ver-btn is-indigo"
                                                              title="Criar versão Cartaz A4 com preço por caixa e adicionar na pasta"
                                                              onClick={e => {
                                                                e.stopPropagation();
                                                                run(async () => {
                                                                  await handleAddPosterVersion(v.item.id, m.libraryCartaz!, 'A4', true, 'caixa');
                                                                });
                                                              }}
                                                            >
                                                              📦 + A4 por Caixa
                                                            </button>
                                                            <button
                                                              type="button"
                                                              className="subtle sk-offer-ver-btn is-indigo"
                                                              title="Criar versão Cartaz A4 com preço por fardo e adicionar na pasta"
                                                              onClick={e => {
                                                                e.stopPropagation();
                                                                run(async () => {
                                                                  await handleAddPosterVersion(v.item.id, m.libraryCartaz!, 'A4', true, 'fardo');
                                                                });
                                                              }}
                                                            >
                                                              📦 + A4 por Fardo
                                                            </button>
                                                          </>
                                                        )}

                                                        {/* 3. Opção para A6 */}
                                                        {!hasA6 && currentFmt !== 'A6' && (
                                                          <button
                                                            type="button"
                                                            className="subtle sk-offer-ver-btn is-blue"
                                                            title="Criar versão Pequeno (A6) deste cartaz para gôndola e adicionar na pasta"
                                                            onClick={e => {
                                                              e.stopPropagation();
                                                              run(async () => {
                                                                await handleAddPosterVersion(v.item.id, m.libraryCartaz!, 'A6', false);
                                                              });
                                                            }}
                                                          >
                                                            🏷️ + Versão Pequeno (A6)
                                                          </button>
                                                        )}
                                                      </>
                                                    );
                                                  })()}
                                                  <button
                                                    type="button"
                                                    className="subtle sk-offer-ver-btn is-green"
                                                    title="Adicionar mais 1 arte PSD (em A6, A5, A4, A3 ou 2×2 A3) para este mesmo produto sem substituir a atual"
                                                    onClick={e => {
                                                      e.stopPropagation();
                                                      const existingFormats = new Set(
                                                        v.matchedPosters.map(p =>
                                                          getPosterPaperFormat(p.scheduledDocument || p.libraryCartaz?.document, p.state.cartazPath)
                                                        )
                                                      );
                                                      const formatOrder: PaperFormat[] = ['A6', 'A5', 'A4', 'A3', 'expositor-a3-2x2'];
                                                      const nextSuggested = formatOrder.find(f => !existingFormats.has(f)) ?? 'A5';
                                                      setPsdOfferContext({
                                                        folderId: activeCampaign.id,
                                                        offerItemId: v.item.id,
                                                        productCode: v.item.f7,
                                                        description: v.item.description,
                                                        futurePriceCents: v.item.scheduledPriceCents,
                                                        mode: 'add',
                                                        initialPaper: nextSuggested,
                                                      });
                                                    }}
                                                  >
                                                    ➕ Adicionar outro PSD
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className="subtle"
                                                    style={{ padding: '5px 10px', fontSize: 12, color: '#2563eb', fontWeight: 600 }}
                                                    title="Trocar a imagem / arte de referência deste produto por outro PSD"
                                                    onClick={e => {
                                                      e.stopPropagation();
                                                      setPsdOfferContext({
                                                        folderId: activeCampaign.id,
                                                        offerItemId: v.item.id,
                                                        productCode: v.item.f7,
                                                        description: v.item.description,
                                                        futurePriceCents: v.item.scheduledPriceCents,
                                                        mode: 'replace',
                                                      });
                                                    }}
                                                  >
                                                    🔄 Trocar referência PSD
                                                  </button>
                                                  {onEditPoster && m.libraryCartaz && (
                                                    <button
                                                      className="subtle"
                                                      style={{ padding: '5px 10px', fontSize: 12 }}
                                                      title="Abrir este cartaz no editor com o preço desta oferta"
                                                      onClick={e => {
                                                        e.stopPropagation();
                                                        run(() => onEditPoster(m.libraryCartaz!.path, v.item.scheduledPriceCents));
                                                      }}
                                                    >
                                                      Editar cartaz
                                                    </button>
                                                  )}
                                                  {m.libraryCartaz && m.currentPriceCents !== null && m.currentPriceCents !== v.item.scheduledPriceCents && (
                                                    <button
                                                      type="button"
                                                      className="subtle"
                                                      style={{ padding: '5px 10px', fontSize: 12 }}
                                                      title="Atualizar o arquivo original da biblioteca para este novo preço"
                                                      onClick={e => {
                                                        e.stopPropagation();
                                                        if (window.confirm(`Deseja atualizar o preço original na biblioteca de "${m.libraryCartaz!.document.product.name}" de ${money(m.currentPriceCents)} para ${money(v.item.scheduledPriceCents)}?`)) {
                                                          run(async () => {
                                                            await handleApplyPriceToLibrary(m.libraryCartaz!.path, m.libraryCartaz!.document, v.item.scheduledPriceCents);
                                                          });
                                                        }
                                                      }}
                                                    >
                                                      Aplicar na biblioteca
                                                    </button>
                                                  )}
                                                  <button
                                                    type="button"
                                                    className="subtle"
                                                    style={{ padding: '5px 10px', fontSize: 12, color: '#ef4444' }}
                                                    title="Desvincular este cartaz deste produto na pasta de ofertas"
                                                    onClick={e => {
                                                      e.stopPropagation();
                                                      if (window.confirm(`Desvincular o cartaz de "${v.item.description}"?`)) {
                                                        run(async () => {
                                                          await persistUpdate(
                                                            unlinkPosterFromCampaignItem(
                                                              activeCampaign,
                                                              v.item.id,
                                                              m.state.cartazPath
                                                            )
                                                          );
                                                        });
                                                      }
                                                    }}
                                                  >
                                                    ❌ Desvincular
                                                  </button>
                                                </div>

                                                {/* OUTROS TAMANHOS DESTE PRODUTO */}
                                                {extraPosters.length > 0 && (
                                                  <div className="sk-offer-extra-box">
                                                    <div className="sk-offer-extra-box-title">
                                                      <span>📏</span> Outros tamanhos deste produto na campanha ({extraPosters.length}):
                                                    </div>
                                                    {extraPosters.map(otherPoster => {
                                                      const otherKey = `${v.item.id}::${otherPoster.state.cartazPath}`;
                                                      const otherFmt = getPosterPaperFormat(otherPoster.scheduledDocument || otherPoster.libraryCartaz?.document, otherPoster.state.cartazPath);
                                                      const otherBadge = getFormatBadge(otherFmt);
                                                      const otherBox = Boolean((otherPoster.scheduledDocument?.product as any)?.hasBoxPrice);
                                                      const otherBoxType = (otherPoster.scheduledDocument?.product as any)?.boxPackageType === 'fardo' ? 'Fardo' : 'Caixa';
                                                      const otherBoxQty = (otherPoster.scheduledDocument?.product as any)?.boxQuantity || 12;
                                                      const otherBoxLabel = (otherPoster.scheduledDocument?.product as any)?.boxUnitLabel || 'UND.';

                                                      return (
                                                        <div key={otherKey} className="sk-offer-extra-row">
                                                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                            <input
                                                              type="checkbox"
                                                              checked={otherPoster.state.selected}
                                                              disabled={!otherPoster.libraryCartaz}
                                                              onClick={e => e.stopPropagation()}
                                                              onChange={e => handleTogglePosterSelection(v.item.id, otherPoster.state.cartazPath, e.target.checked)}
                                                            />
                                                            <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 6, background: otherBadge.bg, color: otherBadge.text, border: `1px solid ${otherBadge.text}` }}>
                                                              {otherBadge.icon} {otherBadge.label}
                                                            </span>
                                                            {otherBox && (
                                                              <span className="sk-offer-badge-box">
                                                                📦 {otherBoxType} {otherBoxQty} {otherBoxLabel}
                                                              </span>
                                                            )}
                                                            <span className="sk-offer-extra-file">
                                                              📄 {otherPoster.state.cartazPath.split(/[\\/]/).pop()}
                                                            </span>
                                                          </div>
                                                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                            <label style={{ fontSize: 11.5 }}>
                                                              Cópias:{' '}
                                                              <input
                                                                type="number"
                                                                min={1}
                                                                max={999}
                                                                value={otherPoster.state.copies}
                                                                onClick={e => e.stopPropagation()}
                                                                onChange={e => handleCopiesChange(v.item.id, otherPoster.state.cartazPath, parseInt(e.target.value, 10) || 1)}
                                                                style={{ width: 48, padding: '2px 4px', fontSize: 11 }}
                                                              />
                                                            </label>
                                                            <button
                                                              type="button"
                                                              className="subtle sk-offer-row-btn"
                                                              onClick={e => {
                                                                e.stopPropagation();
                                                                setPreviewKey(otherKey);
                                                              }}
                                                            >
                                                              👁️ Prévia
                                                            </button>
                                                            <button
                                                              type="button"
                                                              style={{
                                                                padding: '3px 8px',
                                                                fontSize: 11,
                                                                fontWeight: 700,
                                                                background: '#16a34a',
                                                                color: '#ffffff',
                                                                borderRadius: 5,
                                                                border: 'none',
                                                                cursor: 'pointer',
                                                              }}
                                                              onClick={e => {
                                                                e.stopPropagation();
                                                                setPreviewKey(otherKey);
                                                                if (otherPoster.scheduledDocument) {
                                                                  handlePrintSinglePoster(otherPoster.scheduledDocument, otherPoster.state.cartazPath, 1);
                                                                }
                                                              }}
                                                            >
                                                              🖨️ Imprimir
                                                            </button>
                                                            <button
                                                              type="button"
                                                              className="subtle sk-offer-ver-btn is-danger"
                                                              style={{ padding: '3px 6px', fontSize: 11 }}
                                                              title="Remover esta versão da pasta"
                                                              onClick={e => {
                                                                e.stopPropagation();
                                                                if (window.confirm(`Remover esta versão (${otherFmt}) da pasta?`)) {
                                                                  run(async () => {
                                                                    await persistUpdate(
                                                                      unlinkPosterFromCampaignItem(activeCampaign, v.item.id, otherPoster.state.cartazPath)
                                                                    );
                                                                  });
                                                                }
                                                              }}
                                                            >
                                                              ❌
                                                            </button>
                                                          </div>
                                                        </div>
                                                      );
                                                    })}
                                                  </div>
                                                )}

                                                {/* CARTAZES ENCONTRADOS NA BIBLIOTECA PARA ESTE PRODUTO */}
                                                {v.unlinkedLibraryPosters.length > 0 && (
                                                  <div className="sk-offer-unlinked-box">
                                                    <div className="sk-offer-extra-box-title">
                                                      <span>📚</span> Cartazes encontrados na biblioteca para este produto ({v.unlinkedLibraryPosters.length}):
                                                    </div>
                                                    {v.unlinkedLibraryPosters.map(poster => (
                                                      <div key={poster.path} className="sk-offer-unlinked-row">
                                                        <span className="sk-offer-extra-file">
                                                          Encontrado na biblioteca: <strong>{poster.document.product.name} {poster.document.product.complement}</strong>{' '}
                                                          <span className="sk-offer-drawer-psd">
                                                            ({getPosterPaperFormat(poster.document, poster.path)})
                                                          </span>
                                                        </span>
                                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                          <button
                                                            type="button"
                                                            className="subtle"
                                                            style={{ padding: '3px 8px', fontSize: 11.5, color: '#16a34a', fontWeight: 600 }}
                                                            onClick={e => {
                                                              e.stopPropagation();
                                                              run(() => handleLinkLibraryPoster(v.item.id, poster, false));
                                                            }}
                                                          >
                                                            Vincular cartaz
                                                          </button>
                                                          <button
                                                            type="button"
                                                            className="subtle"
                                                            style={{ padding: '3px 8px', fontSize: 11.5, color: '#dc2626', fontWeight: 600 }}
                                                            title="Apagar definitivamente este cartaz desvinculado da biblioteca"
                                                            onClick={e => {
                                                              e.stopPropagation();
                                                              const fileLabel = poster.path.split(/[\\/]/).pop() || poster.path;
                                                              if (window.confirm(`Apagar definitivamente o cartaz "${fileLabel}" da biblioteca?`)) {
                                                                run(() => handleDeleteLibraryPoster(poster.path));
                                                              }
                                                            }}
                                                          >
                                                            🗑️ Apagar
                                                          </button>
                                                        </div>
                                                      </div>
                                                    ))}
                                                  </div>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })()}

                                    {/* SE O PRODUTO NÃO TIVER CARTAZES VINCULADOS, MAS TIVER CARTAZES NA BIBLIOTECA */}
                                    {v.matchedPosters.length === 0 && v.unlinkedLibraryPosters.map(poster => (
                                      <div key={poster.path} className="offer-poster-row">
                                        <strong>
                                          Encontrado na biblioteca: {poster.document.product.name}{' '}
                                          {poster.document.product.complement}
                                        </strong>
                                        <small>
                                          F7 {v.item.f7} · {poster.path}
                                        </small>
                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                                          <button
                                            className="subtle"
                                            style={{ padding: '5px 10px', fontSize: 12, color: '#16a34a', fontWeight: 600 }}
                                            onClick={() => run(() => handleLinkLibraryPoster(v.item.id, poster, false))}
                                          >
                                            Vincular cartaz
                                          </button>
                                          <button
                                            type="button"
                                            className="subtle"
                                            style={{ padding: '5px 10px', fontSize: 12, color: '#dc2626', fontWeight: 600 }}
                                            title="Apagar definitivamente este cartaz desvinculado da biblioteca"
                                            onClick={() => {
                                              const fileLabel = poster.path.split(/[\\/]/).pop() || poster.path;
                                              if (window.confirm(`Apagar definitivamente o cartaz "${fileLabel}" da biblioteca?`)) {
                                                run(() => handleDeleteLibraryPoster(poster.path));
                                              }
                                            }}
                                          >
                                            🗑️ Apagar cartaz
                                          </button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="offer-preview-box">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <h3 style={{ margin: 0, fontSize: 14 }}>Prévia do Cartaz</h3>
                        {selectedPosterPreview && (() => {
                          const fmt = getPosterPaperFormat(selectedPosterPreview.doc, selectedPosterPreview.posterState.cartazPath);
                          const badge = getFormatBadge(fmt);
                          return (
                            <span
                              style={{
                                fontSize: 10.5,
                                fontWeight: 700,
                                padding: '2px 8px',
                                borderRadius: 12,
                                background: badge.bg,
                                color: badge.text,
                              }}
                            >
                              {badge.icon} {badge.label}
                            </span>
                          );
                        })()}
                      </div>
                      {selectedPosterPreview ? (
                        <>
                          <div className="sk-offer-preview-meta">
                            <div className="sk-offer-preview-title">
                              {selectedPosterPreview.item.description}
                            </div>
                            <div className="sk-offer-preview-sub">
                              <span>F7: <strong>{selectedPosterPreview.item.f7}</strong></span>
                              <span aria-hidden="true">·</span>
                              <span>
                                Preço Oferta:{' '}
                                <strong className="sk-offer-poster-price" style={{ fontSize: 13 }}>
                                  {money(selectedPosterPreview.item.scheduledPriceCents)}
                                </strong>
                              </span>
                            </div>
                            <div className="sk-offer-preview-file" title={selectedPosterPreview.posterState.cartazPath}>
                              📄 {selectedPosterPreview.posterState.cartazPath.split(/[\\/]/).pop()}
                            </div>
                          </div>
                          <button
                            type="button"
                            style={{
                              width: '100%',
                              marginBottom: 8,
                              padding: '9px 12px',
                              fontSize: 13,
                              fontWeight: 700,
                              background: '#16a34a',
                              color: '#ffffff',
                              borderRadius: 8,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 6,
                              border: 'none',
                              boxShadow: '0 2px 4px rgba(22,163,74,0.3)',
                            }}
                            title="Imprimir 1 teste deste cartaz na impressora agora"
                            onClick={() => {
                              handlePrintSinglePoster(
                                selectedPosterPreview.doc,
                                selectedPosterPreview.posterState.cartazPath,
                                1,
                                selectedPosterPreview.poster
                              );
                            }}
                          >
                            🖨️ Imprimir este Cartaz (Teste na Impressora)
                          </button>
                          <button
                            type="button"
                            style={{
                              width: '100%',
                              marginBottom: 10,
                              padding: '9px 12px',
                              fontSize: 13,
                              fontWeight: 700,
                              background: '#0284c7',
                              color: '#ffffff',
                              borderRadius: 8,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 6,
                              border: 'none',
                              boxShadow: '0 2px 4px rgba(2,132,199,0.3)',
                            }}
                            title="Exportar arquivo PSD editável deste cartaz selecionando uma pasta de destino"
                            onClick={() => {
                              run(async () => {
                                await handleExportSinglePosterPsd(
                                  selectedPosterPreview.doc,
                                  selectedPosterPreview.item,
                                  selectedPosterPreview.posterState.cartazPath
                                );
                              });
                            }}
                          >
                            📦 Exportar PSD deste Cartaz
                          </button>
                          <div className="paper-wrap">
                            <PosterView poster={selectedPosterPreview.poster} />
                          </div>
                        </>
                      ) : (
                        <p className="empty">
                          Selecione um cartaz da lista para visualizar a prévia com o preço da oferta.
                        </p>
                      )}
                    </div>
                  </div>

                  {selectedItemIds.size > 0 && (
                    <div
                      className="sk-floating-action-bar sk-batch-dock"
                      role="region"
                      aria-label="Dock de ações em lote para produtos selecionados"
                    >
                      <div className="sk-floating-bar-meta">
                        <strong className="sk-tabular">{selectedItemIds.size}</strong>
                        <span>
                          {selectedItemIds.size === 1 ? 'produto selecionado' : 'produtos selecionados'}
                        </span>
                        <span className="sk-floating-bar-sub sk-tabular">
                          · {selectedLinkedPosterCount}{' '}
                          {selectedLinkedPosterCount === 1 ? 'cartaz vinculado' : 'cartazes vinculados'}
                        </span>
                      </div>
                      <div className="sk-floating-bar-actions">
                        {(onAddBatchToConductor || onAddToConductor) && (
                          <button
                            type="button"
                            className="editor-btn primary"
                            disabled={selectedLinkedPosterCount === 0}
                            onClick={handleSendSelectedToConductor}
                            title="Adicionar os cartazes selecionados à Fila de Impressão (Condutor)"
                          >
                            Adicionar à Fila de Impressão ({selectedLinkedPosterCount})
                          </button>
                        )}
                        <button
                          type="button"
                          className="editor-btn secondary"
                          disabled={selectedLinkedPosterCount === 0}
                          onClick={handleOpenExportSelected}
                          title="Exportar somente os cartazes dos produtos selecionados (.PSD / .skcartaz)"
                        >
                          Exportar Selecionados ({selectedLinkedPosterCount})
                        </button>
                        <button
                          type="button"
                          className="editor-btn outline-blue"
                          disabled={selectedLinkedPosterCount === 0}
                          onClick={() => run(async () => handlePrintSelectedItems())}
                          title="Imprimir imediatamente os cartazes selecionados (Alt+P)"
                        >
                          Imprimir (Alt+P)
                        </button>
                        {onStartBatchEdit && selectedBatchEditQueue.length > 0 && (
                          <button
                            type="button"
                            className="editor-btn subtle"
                            onClick={() => run(() => onStartBatchEdit(selectedBatchEditQueue))}
                            title="Abrir os produtos selecionados em sequência no Editor (Alt+→ para avançar)"
                          >
                            Editar em sequência ({selectedBatchEditQueue.length})
                          </button>
                        )}
                        <button
                          type="button"
                          className="editor-btn subtle danger"
                          onClick={() => run(() => handleDeleteSelectedItems())}
                          title="Remover os produtos selecionados desta pasta de ofertas (Delete)"
                        >
                          Remover (Del)
                        </button>
                        <button
                          type="button"
                          className="editor-btn subtle"
                          onClick={() => handleSelectVisibleItems(false)}
                          title="Limpar seleção"
                        >
                          Limpar
                        </button>
                      </div>
                    </div>
                  )}

                  {marqueeRect && (
                    <div
                      className="sk-marquee-box"
                      aria-hidden="true"
                      style={{
                        left: marqueeRect.left,
                        top: marqueeRect.top,
                        width: marqueeRect.width,
                        height: marqueeRect.height,
                      }}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>



      {workbook && activeSheet && extractionPreview && (
        <div className="modal-backdrop psd-backdrop">
          <section className="panel psd-import" role="dialog" aria-modal="true" aria-label="Importar planilha Excel">
            <div className="psd-title">
              <div>
                <h2>Importar Planilha de Ofertas (.xlsx, .xls)</h2>
                <p>
                  Arquivo: <strong>{workbook.fileName}</strong> · O arquivo Excel original é apenas lido e nunca modificado.
                </p>
              </div>
              <button className="subtle" onClick={() => setWorkbook(null)}>
                Cancelar
              </button>
            </div>

            <div className="psd-fields">
              <label>
                Aba da planilha
                <select value={sheetIdx} onChange={e => handleSheetChange(Number(e.target.value))}>
                  {workbook.sheets.map((s, idx) => (
                    <option key={s.name} value={idx}>
                      {s.name} ({s.rows.length} linhas)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Linha do cabeçalho
                <select value={headerRow} onChange={e => handleHeaderRowChange(Number(e.target.value))}>
                  {activeSheet.rows.slice(0, 15).map((r, idx) => (
                    <option key={idx} value={idx}>
                      Linha {idx + 1}: {r.filter(Boolean).slice(0, 4).join(' | ') || '(vazia)'}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Coluna do Código F7
                <select
                  value={mapping.f7Col}
                  onChange={e => setMapping(m => ({ ...m, f7Col: Number(e.target.value) }))}
                >
                  {(activeSheet.rows[headerRow] ?? []).map((col, idx) => (
                    <option key={idx} value={idx}>
                      Coluna {columnLetter(idx)} — {col || `(Sem título)`}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Coluna da Descrição
                <select
                  value={mapping.descriptionCol}
                  onChange={e => setMapping(m => ({ ...m, descriptionCol: Number(e.target.value) }))}
                >
                  {(activeSheet.rows[headerRow] ?? []).map((col, idx) => (
                    <option key={idx} value={idx}>
                      Coluna {columnLetter(idx)} — {col || `(Sem título)`}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Coluna do Preço Programado
                <select
                  value={mapping.priceCol}
                  onChange={e => setMapping(m => ({ ...m, priceCol: Number(e.target.value) }))}
                >
                  {(activeSheet.rows[headerRow] ?? []).map((col, idx) => (
                    <option key={idx} value={idx}>
                      Coluna {columnLetter(idx)} — {col || `(Sem título)`}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="import-stats">
              <span>
                <strong>{extractionPreview.validCount}</strong> itens válidos
              </span>
              <span>
                <strong>{extractionPreview.invalidCount}</strong> itens com problemas/conflitos
              </span>
              <span>
                <strong>{extractionPreview.duplicateF7s.length}</strong> F7 duplicados
              </span>
              <span>
                <strong>{extractionPreview.conflictingF7s.length}</strong> F7 com preços conflitantes
              </span>
            </div>

            <div className="import-table-wrap" style={{ maxHeight: '40vh' }}>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Linha</th>
                    <th>F7 (String)</th>
                    <th>Descrição</th>
                    <th>Preço Planilha</th>
                    <th>Centavos</th>
                    <th>Validação</th>
                  </tr>
                </thead>
                <tbody>
                  {extractionPreview.items.slice(0, 100).map(item => (
                    <tr key={item.rowNumber}>
                      <td>{item.rowNumber}</td>
                      <td className="code-cell">{item.f7 ?? (item.f7Raw || '—')}</td>
                      <td>{item.description || '—'}</td>
                      <td>{item.priceRaw || '—'}</td>
                      <td>{item.priceCents !== null ? money(item.priceCents) : '—'}</td>
                      <td>
                        {item.issues.length === 0 ? (
                          <span className="comparison-status">Válido</span>
                        ) : (
                          item.issues.map(iss => (
                            <small className="error-text" key={iss}>
                              {iss}
                            </small>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="toolbar" style={{ marginTop: 16 }}>
              <button
                disabled={extractionPreview.validCount === 0}
                onClick={() => run(handleConfirmExcelImport)}
              >
                Confirmar importação ({extractionPreview.validCount} produto(s))
              </button>
              <button className="subtle" onClick={() => setWorkbook(null)}>
                Cancelar
              </button>
            </div>
          </section>
        </div>
      )}

      {psdOfferContext && (
        <Suspense
          fallback={
            <div className="modal-backdrop">
              <section className="panel modal" role="status">
                Carregando importador PSD…
              </section>
            </div>
          }
        >
          <PsdImport
            offerContext={psdOfferContext}
            close={() => setPsdOfferContext(null)}
            saved={handlePsdSavedForOffer}
          />
        </Suspense>
      )}

      {showPsdManagerModal && (
        <div className="modal-backdrop" onClick={() => !batchLinking && setShowPsdManagerModal(false)}>
          <section
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-label="Pareamento de Artes PSD com Produtos da Campanha"
            style={{ maxWidth: 1080, width: '94vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="library-heading" style={{ marginBottom: 8 }}>
              <div>
                <h3>⚡ Pareamento de Artes PSD com Produtos da Campanha</h3>
                <p style={{ margin: '2px 0 0', fontSize: 13, color: '#475569' }}>
                  Selecionar uma pasta serve apenas para procurar arquivos PSD de referência; importar e vincular uma arte é uma ação posterior mediante sua revisão e confirmação.
                </p>
                <small className="document-path" style={{ display: 'block', marginTop: 4 }}>
                  {psdFolder
                    ? `Pasta de referência: ${psdFolder} (${scannedPsds.length} arquivo(s) PSD)`
                    : 'Nenhuma pasta de PSDs selecionada ainda. Clique em "Procurar Pasta de PSDs" para localizar candidatos.'}
                </small>
              </div>
              <div className="toolbar" style={{ marginTop: 0 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 'bold' }}>
                  Formato do Cartaz:
                  <select
                    value={psdPaperSize}
                    onChange={e => setPsdPaperSize(e.target.value as PaperFormat | 'auto')}
                    style={{ padding: '4px 8px', fontWeight: 'bold', color: '#0f172a' }}
                  >
                    <option value="auto">✨ Automático (Pastas: Médios A5, Balcão A3, Pequenos A6, etc.)</option>
                    <option value="A6">A6 — Pequeno (105 × 148 mm)</option>
                    <option value="A5">A5 — Médio (148 × 210 mm)</option>
                    <option value="A4">A4 — Grande (210 × 297 mm)</option>
                    <option value="A3">A3 — Extra Grande (297 × 420 mm)</option>
                  </select>
                </label>
                <button className="subtle" disabled={batchLinking} onClick={() => run(handleChoosePsdFolder)}>
                  📁 {psdFolder ? 'Trocar Pasta de PSDs' : 'Procurar Pasta de PSDs'}
                </button>
              </div>
            </div>

            {psdScanError && (
              <div
                className="import-warning"
                role="alert"
                style={{ margin: '6px 0 10px', padding: 10, background: '#fef2f2', borderColor: '#fca5a5', color: '#991b1b' }}
              >
                <strong>Erro na leitura da pasta de PSDs:</strong> {psdScanError}
              </div>
            )}

            {batchLinkResult && (
              <div
                className="import-warning"
                role={batchLinkResult.success ? 'status' : 'alert'}
                style={
                  batchLinkResult.success
                    ? { margin: '6px 0 10px', padding: 10, background: '#f0fdf4', borderColor: '#86efac', color: '#166534' }
                    : { margin: '6px 0 10px', padding: 10, background: '#fef2f2', borderColor: '#fca5a5', color: '#991b1b' }
                }
              >
                <strong>{batchLinkResult.message}</strong>
                {batchLinkResult.errors.length > 0 && (
                  <ul style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 12 }}>
                    {batchLinkResult.errors.map(err => (
                      <li key={`${err.itemId}::${err.psdPath}`}>
                        <strong>F7 {err.f7} ({err.description})</strong> ← <code>{err.psdName}</code>: {err.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {isScanningPsds ? (
              <div
                style={{
                  background: '#1e293b',
                  border: '1px solid #3b82f6',
                  color: '#93c5fd',
                  padding: '10px 14px',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  margin: '4px 0 10px',
                }}
              >
                <span style={{ fontSize: 20 }}>🔄</span>
                <div>
                  <strong style={{ display: 'block', fontSize: 13, color: '#f8fafc' }}>
                    Escaneando pasta de PSDs e calculando sugestões…
                  </strong>
                  <small style={{ color: '#94a3b8' }}>
                    Lendo arquivos da pasta e cruzando códigos F7 e descrições com os {activeCampaign?.items.length ?? 0} produtos da campanha.
                  </small>
                </div>
              </div>
            ) : (
              <div className="import-stats" style={{ margin: '4px 0 10px' }}>
                <span><strong>{activeCampaign?.items.length ?? 0}</strong> produtos na campanha</span>
                <span><strong>{scannedPsds.length}</strong> PSDs na pasta</span>
                <span><strong>{pairingStats.exactF7}</strong> F7 exato</span>
                <span><strong>{pairingStats.descriptionSimilar}</strong> descrição parecida</span>
                <span><strong>{pairingStats.ambiguous}</strong> ambíguos / múltiplos candidatos</span>
                <span><strong>{pairingStats.noSuggestion}</strong> sem sugestão</span>
                <span><strong>{batchConfirmationSummary.toLink.length}</strong> prontos para o lote</span>
              </div>
            )}

            {showBatchConfirmStep && batchConfirmationSummary.toLink.length > 0 && (
              <div
                className="import-warning"
                role="region"
                aria-label="Confirmação de vínculos em lote"
                style={{ margin: '0 0 12px', padding: 12, background: '#f8fafc', borderColor: '#0284c7' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <strong style={{ fontSize: 14, color: '#0f172a' }}>
                      Confirmar aplicação de vínculos em lote ({batchConfirmationSummary.toLink.length} produto(s) · Formato {psdPaperSize === 'auto' ? 'Automático' : psdPaperSize})
                    </strong>
                    <div style={{ fontSize: 12, color: '#334155', marginTop: 4 }}>
                      Resumo do lote:{' '}
                      <strong>{batchConfirmationSummary.exactF7Count}</strong> por F7 exato confiável ·{' '}
                      <strong>{batchConfirmationSummary.reviewedManualOrDescriptionCount}</strong> revisado(s) manualmente / por descrição ·{' '}
                      <strong>{batchConfirmationSummary.skippedAmbiguousOrUnreviewedCount}</strong> ambíguo(s) ou por descrição não revisados (não incluídos) ·{' '}
                      <strong>{batchConfirmationSummary.skippedNoSuggestionCount}</strong> sem sugestão.
                    </div>
                  </div>
                  <div className="toolbar" style={{ marginTop: 0 }}>
                    <button
                      disabled={batchLinking}
                      style={{ background: '#0284c7', color: '#fff' }}
                      onClick={() =>
                        run(() =>
                          handleExecuteConfirmedBatchLink(
                            batchConfirmationSummary.toLink.map(entry => ({
                              item: entry.item,
                              psd: entry.psd,
                            }))
                          )
                        )
                      }
                    >
                      {batchLinking
                        ? 'Aplicando vínculos…'
                        : `✓ Confirmar e Aplicar Vínculos (${batchConfirmationSummary.toLink.length})`}
                    </button>
                    <button
                      className="subtle"
                      disabled={batchLinking}
                      onClick={() => setShowBatchConfirmStep(false)}
                    >
                      Voltar e Revisar
                    </button>
                  </div>
                </div>
                <ul style={{ margin: '8px 0 0 18px', padding: 0, fontSize: 12, maxHeight: 120, overflowY: 'auto' }}>
                  {batchConfirmationSummary.toLink.map(entry => (
                    <li key={entry.item.id}>
                      <strong>F7 {entry.item.f7}</strong> — {entry.item.description} ({money(entry.item.scheduledPriceCents)}) ←{' '}
                      <strong>{entry.psd.name}</strong> <em>[{entry.reasonLabel}]</em>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="toolbar" style={{ marginBottom: 10, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 280 }}>
                <input
                  aria-label="Pesquisar produto ou arquivo PSD no pareamento"
                  placeholder="Pesquisar por F7, descrição do produto ou arquivo PSD…"
                  value={psdFilterText}
                  onChange={e => {
                    setPsdFilterText(e.target.value);
                    setPsdPage(0);
                  }}
                  style={{ maxWidth: 340, flex: 1 }}
                />
                <select
                  aria-label="Filtrar recomendações de pareamento PSD"
                  value={psdReasonFilter}
                  onChange={e => {
                    setPsdReasonFilter(e.target.value as PsdPairingFilter);
                    setPsdPage(0);
                  }}
                >
                  <option value="todos">Todos os produtos ({psdSuggestions.length})</option>
                  <option value="f7-exact">F7 exato ({pairingStats.exactF7})</option>
                  <option value="description-similar">Descrição parecida ({pairingStats.descriptionSimilar})</option>
                  <option value="ambiguous">Ambíguos / Múltiplos candidatos ({pairingStats.ambiguous})</option>
                  <option value="no-suggestion">Sem sugestão ({pairingStats.noSuggestion})</option>
                  <option value="selected-batch">Selecionados para o lote ({batchConfirmationSummary.toLink.length})</option>
                  <option value="already-linked">Já vinculados ({pairingStats.alreadyLinked})</option>
                </select>
              </div>
              <div className="toolbar" style={{ marginTop: 0 }}>
                <button
                  className="subtle"
                  disabled={batchLinking || scannedPsds.length === 0}
                  onClick={() => {
                    setPsdPairingSelections({});
                    setShowBatchConfirmStep(false);
                  }}
                >
                  Apenas F7 exatos confiáveis
                </button>
                <button
                  disabled={batchLinking || batchConfirmationSummary.toLink.length === 0}
                  onClick={() => setShowBatchConfirmStep(true)}
                  style={{ background: '#0284c7', color: '#fff' }}
                >
                  {batchLinking
                    ? 'Vinculando…'
                    : `⚡ Revisar e Vincular em Lote (${batchConfirmationSummary.toLink.length})`}
                </button>
              </div>
            </div>

            <div className="import-table-wrap" style={{ flex: 1, overflowY: 'auto', maxHeight: '48vh' }}>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Produto da Campanha (Excel)</th>
                    <th>Motivo da Sugestão</th>
                    <th>Arquivo PSD Candidato / Escolha Manual</th>
                    <th>Revisão e Vínculo</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedPsdSuggestions.map(s => {
                    const effectiveSel = psdPairingSelections[s.item.id] ?? getDefaultSelectionForSuggestion(s);
                    const candidatePaths = new Set(s.candidates.map(c => c.psd.path));
                    const otherPsds = scannedPsds.filter(p => !candidatePaths.has(p.path));
                    const selectedPsd = scannedPsds.find(p => p.path === effectiveSel.psdPath) ?? null;
                    const topCandidate = s.candidates[0] ?? null;

                    return (
                      <tr key={s.item.id}>
                        <td>
                          <div>
                            <span className="code-cell" style={{ fontWeight: 'bold' }}>
                              F7 {s.item.f7}
                            </span>{' '}
                            — <strong>{s.item.description}</strong>
                          </div>
                          <small style={{ color: '#475569' }}>
                            Preço programado: <strong>{money(s.item.scheduledPriceCents)}</strong> · Linha Excel: {s.item.rowNumber}
                            {s.alreadyLinked ? ' · ✓ Já possui cartaz vinculado' : ''}
                          </small>
                        </td>
                        <td>
                          <span
                            className={
                              s.reason === 'f7-exact' && !s.ambiguous
                                ? 'comparison-status'
                                : s.reason === 'no-suggestion' || s.ambiguous
                                  ? 'comparison-status conflict'
                                  : 'comparison-status'
                            }
                            style={
                              s.reason === 'description-similar' && !s.ambiguous
                                ? { background: '#fef3c7', color: '#92400e' }
                                : undefined
                            }
                          >
                            {s.reasonLabel}
                          </span>
                          {topCandidate && topCandidate.reason === 'description-similar' && topCandidate.matchedTerms.length > 0 && (
                            <small style={{ display: 'block', marginTop: 4, color: '#64748b' }}>
                              Termos: {topCandidate.matchedTerms.join(', ')}
                            </small>
                          )}
                          {s.ambiguous && s.ambiguityReason && (
                            <small className="error-text" style={{ display: 'block', marginTop: 4 }}>
                              ⚠️ {s.ambiguityReason}
                            </small>
                          )}
                          {s.candidates.length > 1 && (
                            <small style={{ display: 'block', marginTop: 2, color: '#475569' }}>
                              Candidatos: {s.candidates.map(c => c.psd.name).join(' | ')}
                            </small>
                          )}
                        </td>
                        <td>
                          <select
                            aria-label={`Arquivo PSD para F7 ${s.item.f7} ${s.item.description}`}
                            style={{ width: '100%', maxWidth: 420, fontSize: 12, padding: '4px 6px' }}
                            value={effectiveSel.psdPath}
                            onChange={e => {
                              const nextPath = e.target.value;
                              setPsdPairingSelections(prev => ({
                                ...prev,
                                [s.item.id]: {
                                  psdPath: nextPath,
                                  includedInBatch: Boolean(nextPath),
                                  reviewedByUser: true,
                                },
                              }));
                              setShowBatchConfirmStep(false);
                            }}
                          >
                            <option value="">
                              {s.ambiguous
                                ? `(Correspondência ambígua: escolha entre ${s.candidates.length} candidatos...)`
                                : s.reason === 'no-suggestion'
                                  ? '(Sem sugestão — escolher PSD manualmente...)'
                                  : '(Não vincular neste lote)'}
                            </option>
                            {s.candidates.map(c => (
                              <option key={c.psd.path} value={c.psd.path}>
                                {c.reason === 'f7-exact' ? '⭐ [Candidato · F7 exato] ' : '💡 [Candidato · Descrição parecida] '}
                                {c.psd.name}
                              </option>
                            ))}
                            {otherPsds.map(p => (
                              <option key={p.path} value={p.path}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={effectiveSel.includedInBatch && Boolean(selectedPsd)}
                                disabled={!selectedPsd || batchLinking}
                                onChange={e => {
                                  const checked = e.target.checked;
                                  setPsdPairingSelections(prev => ({
                                    ...prev,
                                    [s.item.id]: {
                                      psdPath: effectiveSel.psdPath,
                                      includedInBatch: checked && Boolean(effectiveSel.psdPath),
                                      reviewedByUser: true,
                                    },
                                  }));
                                  setShowBatchConfirmStep(false);
                                }}
                              />
                              <span>
                                {s.reason === 'description-similar' && !effectiveSel.reviewedByUser
                                  ? 'Confirmar sugestão p/ lote'
                                  : 'Incluir no lote'}
                              </span>
                            </label>
                            {selectedPsd && (
                              <button
                                disabled={batchLinking}
                                className="subtle"
                                style={{ fontSize: 11, padding: '3px 8px' }}
                                onClick={() =>
                                  run(() => handleAssignPsdToOfferItem(s.item.id, selectedPsd.path, psdPaperSize))
                                }
                              >
                                ⚡ Vincular agora ({psdPaperSize === 'auto' ? 'Auto' : psdPaperSize})
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredPsdSuggestions.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: 24, color: '#64748b' }}>
                        {activeCampaign && activeCampaign.items.length === 0
                          ? 'Importe uma planilha Excel na campanha antes de parear artes PSD.'
                          : 'Nenhum produto da campanha encontrado para este filtro/pesquisa.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {totalPsdPages > 1 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  background: '#0f172a',
                  border: '1px solid #1e293b',
                  borderRadius: 6,
                  marginTop: 6,
                  fontSize: 12,
                  color: '#94a3b8',
                }}
              >
                <span>
                  Exibindo {filteredPsdSuggestions.length > 0 ? psdPage * PSD_PAGE_SIZE + 1 : 0}–
                  {Math.min((psdPage + 1) * PSD_PAGE_SIZE, filteredPsdSuggestions.length)} de{' '}
                  <strong style={{ color: '#f1f5f9' }}>{filteredPsdSuggestions.length}</strong> produtos
                </span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className="subtle"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    disabled={psdPage === 0}
                    onClick={() => setPsdPage(p => Math.max(0, p - 1))}
                  >
                    ◀ Anterior
                  </button>
                  <span style={{ fontWeight: 'bold', color: '#f1f5f9' }}>
                    Página {psdPage + 1} de {totalPsdPages}
                  </span>
                  <button
                    className="subtle"
                    style={{ padding: '3px 10px', fontSize: 12 }}
                    disabled={psdPage >= totalPsdPages - 1}
                    onClick={() => setPsdPage(p => Math.min(totalPsdPages - 1, p + 1))}
                  >
                    Próxima ▶
                  </button>
                </div>
              </div>
            )}

            <div className="toolbar" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="subtle" disabled={batchLinking} onClick={() => setShowPsdManagerModal(false)}>
                Fechar
              </button>
            </div>
          </section>
        </div>
      )}

      {showExportModal && (
        <div className="modal-backdrop" onClick={() => !exporting && setShowExportModal(false)}>
          <section
            className="panel modal"
            style={{ maxWidth: 660, width: '92vw' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="library-heading" style={{ marginBottom: 12 }}>
              <div>
                <h3>📦 Exportar Cartazes da Pasta de Ofertas</h3>
                <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>
                  Campanha: {activeCampaign?.name} ({activeCampaign?.campaignDate})
                </p>
              </div>
            </div>

            <fieldset style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: '12px 16px', margin: '12px 0' }}>
              <legend style={{ fontWeight: 'bold', fontSize: 13, padding: '0 6px' }}>Formatos Desejados</legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={exportFormatPsd}
                    onChange={e => setExportFormatPsd(e.target.checked)}
                  />
                  <div>
                    <strong>Arquivos Photoshop (.PSD)</strong>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      Artes editáveis preservando camadas, com preço e validade da oferta atualizados.
                    </div>
                  </div>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={exportFormatSk}
                    onChange={e => setExportFormatSk(e.target.checked)}
                  />
                  <div>
                    <strong>Projeto Skalee (.skcartaz)</strong>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      Arquivo pronto para abrir, editar e imprimir diretamente no Skalee Cartaz.
                    </div>
                  </div>
                </label>
              </div>
            </fieldset>

            <fieldset style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: '12px 16px', margin: '12px 0' }}>
              <legend style={{ fontWeight: 'bold', fontSize: 13, padding: '0 6px' }}>Escopo da Exportação</legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="exportScope"
                    checked={exportScope === 'checked-rows'}
                    disabled={selectedItemIds.size === 0}
                    onChange={() => setExportScope('checked-rows')}
                  />
                  <span>
                    Apenas os produtos selecionados na lista (<strong className="sk-tabular">{selectedItemIds.size}</strong>{' '}
                    {selectedItemIds.size === 1 ? 'item' : 'itens'} · <strong className="sk-tabular">{selectedLinkedPosterCount}</strong>{' '}
                    {selectedLinkedPosterCount === 1 ? 'cartaz' : 'cartazes'})
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="exportScope"
                    checked={exportScope === 'all'}
                    onChange={() => setExportScope('all')}
                  />
                  <span>Todos os cartazes com arte vinculada da campanha</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="exportScope"
                    checked={exportScope === 'print-marked'}
                    onChange={() => setExportScope('print-marked')}
                  />
                  <span>Apenas os cartazes marcados para impressão na coluna de cartazes</span>
                </label>
              </div>
            </fieldset>

            {isTauri() ? (
              <div style={{ margin: '12px 0' }}>
                <label style={{ fontWeight: 'bold', fontSize: 13, display: 'block', marginBottom: 6 }}>
                  Pasta de Destino:
                </label>
                <div className="toolbar" style={{ marginTop: 0 }}>
                  <input
                    readOnly
                    placeholder="Selecione a pasta no computador..."
                    value={exportFolder || ''}
                    style={{ flex: 1 }}
                  />
                  <button onClick={() => run(handleChooseExportFolder)}>
                    Escolher Pasta
                  </button>
                </div>
                {exportFolder && activeCampaign && (
                  <small style={{ color: '#64748b', display: 'block', marginTop: 4 }}>
                    Será organizada na subpasta: <code>{activeCampaign.name}_{activeCampaign.campaignDate}</code>
                  </small>
                )}
              </div>
            ) : (
              <p style={{ margin: '10px 0', fontSize: 12.5, color: '#64748b' }}>
                No modo prévia web, os arquivos <code>.skcartaz</code> selecionados serão baixados diretamente pelo navegador.
              </p>
            )}

            <div style={{ margin: '12px 0', padding: '10px 14px', background: 'rgba(22, 163, 74, 0.08)', borderRadius: 8, border: '1px solid rgba(22, 163, 74, 0.25)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 700, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={exportOrganizeByFormat}
                  onChange={e => setExportOrganizeByFormat(e.target.checked)}
                />
                <span>Separar em pastas por tamanho (PEQUENOS, MÉDIOS, CARTAZ A4, etc.)</span>
              </label>
              <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4, marginLeft: 24, lineHeight: 1.4 }}>
                Separa automaticamente os arquivos A6 na pasta <code>PEQUENOS</code>, A5 em <code>MÉDIOS</code>, A4 em <code>CARTAZ A4</code>, A3 em <code>CARTAZ AÇOUGUE A3</code> e externas em <code>CARTAZ EXTERNOS</code>.
              </div>
            </div>

            {exportProgress && (
              <div style={{ margin: '14px 0', padding: 12, background: 'rgba(148, 163, 184, 0.14)', borderRadius: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                  <span>{exportProgress.message}</span>
                  <span className="sk-tabular"><strong>{exportProgress.current} / {exportProgress.total}</strong></span>
                </div>
                <div style={{ height: 8, background: 'rgba(148, 163, 184, 0.28)', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      background: '#2563eb',
                      width: `${exportProgress.total > 0 ? (exportProgress.current / exportProgress.total) * 100 : 0}%`,
                      transition: 'width 0.2s',
                    }}
                  />
                </div>
              </div>
            )}

            {exportResult && (
              <div className="import-warning" style={{ margin: '14px 0', padding: 12 }}>
                <strong>{exportResult.errors.length ? 'Exportação parcial' : 'Exportação concluída'}</strong>
                <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 13 }}>
                  {exportFormatPsd && isTauri() && <li><strong>{exportResult.psdCount} de {exportResult.candidateCount}</strong> arquivos .PSD gerados.</li>}
                  {exportFormatSk && <li><strong>{exportResult.skCount} de {exportResult.candidateCount}</strong> arquivos .skcartaz gerados.</li>}
                </ul>
                {exportResult.errors.length > 0 && (
                  <div style={{ marginTop: 8, color: '#ef4444' }}>
                    <small>Avisos / Detalhes:</small>
                    <ul style={{ margin: '4px 0 0 16px', fontSize: 11 }}>
                      {exportResult.errors.map(err => <li key={err}>{err}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="toolbar" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
              <button
                className="editor-btn primary"
                disabled={exporting || (isTauri() && !exportFolder) || (!exportFormatPsd && !exportFormatSk)}
                onClick={() => run(handleRunBatchExport)}
              >
                {exporting
                  ? 'Exportando…'
                  : exportScope === 'checked-rows'
                  ? `Exportar Selecionados (${selectedLinkedPosterCount})`
                  : 'Iniciar Exportação em Lote'}
              </button>
              <button
                className="subtle"
                disabled={exporting}
                onClick={() => setShowExportModal(false)}
              >
                Fechar
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
