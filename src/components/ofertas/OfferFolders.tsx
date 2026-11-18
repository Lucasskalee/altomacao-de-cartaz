import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { PosterView, type Poster } from '../editor/PosterView';
import { hasInvertedPsdPriceParts, repairInvertedPsdArtwork } from '../editor/importedRenderer';
import { posterFromDocument } from '../../features/cartazes/presentation';
import { indexCartazes, type IndexedCartaz } from '../../features/cartazes/f7';
import { chooseSave, saveDocument, saveExportDocument } from '../../features/cartazes/storage';
import type { Cartaz, Library as LibraryData } from '../../features/cartazes/types';
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
  buildOfferPsdCartazTargetPath,
  buildPsdBatchConfirmationSummary,
  confirmBatchPrinted,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  executePsdBatchLinking,
  getDefaultSelectionForSuggestion,
  linkSavedPosterToCampaignItem,
  listCampaigns,
  removeCampaignItem,
  renameCampaign,
  saveCampaign,
  selectExcel,
  syncCampaignWithLibrary,
  unlinkPosterFromCampaignItem,
  updateCampaignItemDescription,
  updatePosterSelection,
  updateScheduledPrice,
} from '../../features/ofertas/service';
import type {
  CampaignItem,
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
import type { ScannedPsdEntry, ScantechExportJob } from '../../features/scantech/types';
import { readPsdByPath } from '../../features/psd/service';
import { analyzePsd, buildArtwork } from '../../features/psd/importer';
import { splitCentsToParts } from '../../features/cartazes/presentation';
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

type Props = {
  libraryData: LibraryData | null;
  run: (action: () => Promise<void>) => void;
  onPrintBatch: (posters: Poster[]) => void;
  onEditPoster?: (path: string, scheduledPriceCents?: number) => Promise<void>;
  onRefreshLibrary?: () => Promise<void>;
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
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState('');
  const [editingDescriptionId, setEditingDescriptionId] = useState<string | null>(null);
  const [editingDescriptionValue, setEditingDescriptionValue] = useState('');

  // Batch print tracking
  const [batchSize, setBatchSize] = useState(10);
  const [awaitingPrintConfirm, setAwaitingPrintConfirm] = useState<{ keys: Set<string>; count: number } | null>(null);

  // Pasta de PSDs de referência e pareamento revisável por produto da campanha (A6 por padrão)
  const [scannedPsds, setScannedPsds] = useState<ScannedPsdEntry[]>(initialScannedPsds);
  const [psdFolder, setPsdFolder] = useState<string | null>(initialPsdFolder);
  const [psdPaperSize, setPsdPaperSize] = useState<PaperFormat>('A6');
  const [showPsdManagerModal, setShowPsdManagerModal] = useState(initialShowPsdModal);
  const [psdFilterText, setPsdFilterText] = useState('');
  const [psdReasonFilter, setPsdReasonFilter] = useState<PsdPairingFilter>('todos');
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
  const [exportOnlySelected, setExportOnlySelected] = useState(false);
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

  const persistUpdate = async (updated: OfferCampaign) => {
    const saved = await saveCampaign(updated);
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
    paperSize: PaperFormat
  ): Promise<Cartaz> => {
    const analysis = await analyzePsd(psdData.buffer, psdData.name, psdData.path);
    const roles = analysis.suggested;
    if (!roles.whole || !roles.fraction) {
      throw new Error(`Não foi possível detectar as camadas de preço no PSD "${psdData.name}".`);
    }
    let artwork = buildArtwork(analysis, roles);
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
        paper: paperSize,
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
    setBatchLinkResult(null);
    setShowBatchConfirmStep(false);
    setPsdPairingSelections({});
    setShowPsdManagerModal(true);

    try {
      const entries = await scanScantechPsdFolder(folder);
      setScannedPsds(entries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setScannedPsds([]);
      setPsdScanError(`Falha ao ler os arquivos PSD da pasta "${folder}": ${msg}`);
      throw err;
    }
  };

  const handleAssignPsdToOfferItem = async (
    itemId: string,
    psdPath: string,
    paperSize: PaperFormat = psdPaperSize
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
        const targetPath = buildOfferPsdCartazTargetPath(
          libraryData?.root || '',
          item.f7,
          item.description,
          paperSize
        );
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
    if (!activeCampaign || !exportFolder) return;
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
      const targetFolder = `${exportFolder.replace(/[\\/]+$/, '')}\\${subFolderName}`;

      const candidates: {
        item: CampaignItem;
        cartazPath: string;
        doc: Cartaz;
      }[] = [];
      const candidateKeys = new Set<string>();

      for (const v of matchViews) {
        for (const m of v.matchedPosters) {
          if (!m.scheduledDocument) continue;
          if (exportOnlySelected && !m.state.selected) continue;
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

      if (candidates.length === 0) {
        throw new Error('Nenhum cartaz com arte vinculada disponível para exportar.');
      }

      setExportProgress({ current: 0, total: candidates.length, message: 'Iniciando exportação...' });

      let psdCount = 0;
      let skCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < candidates.length; i++) {
        const { item, doc } = candidates[i];
        setExportProgress({
          current: i + 1,
          total: candidates.length,
          message: `Exportando ${i + 1} de ${candidates.length}: F7 ${item.f7} - ${item.description}...`,
        });

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
            const skFileName = `${f7Tag}${baseSlug}${paperTag}-oferta.skcartaz`;
            const skPath = `${targetFolder}\\${skFileName}`;
            await saveExportDocument(skPath, doc);
            skCount++;
          } catch (e) {
            errors.push(`SK ${item.f7}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 2. Exporta .psd
        if (exportFormatPsd) {
          if (doc.layout.template === 'imported-psd') {
            const artwork = doc.layout.artwork;
            const wholePart = artwork.priceParts.find(p => p.role === 'whole');
            const fractionPart = artwork.priceParts.find(p => p.role === 'fraction');
            const validityPart = artwork.priceParts.find(p => p.role === 'validity');

            if (wholePart && fractionPart && artwork.source.sourcePath) {
              const parts = splitCentsToParts(item.scheduledPriceCents);
              const psdFileName = `${f7Tag}${baseSlug}${paperTag}-oferta.psd`;
              const outputPsdPath = `${targetFolder}\\${psdFileName}`;

              const job: ScantechExportJob = {
                itemId: item.id,
                f7: item.f7,
                description: item.description,
                sourcePsdPath: artwork.source.sourcePath,
                outputPsdPath,
                wholeLayerId: wholePart.layerId,
                fractionLayerId: fractionPart.layerId,
                validityLayerId: validityPart?.layerId,
                wholeValue: parts.whole,
                fractionValue: parts.fraction,
                validityText: typeof doc.product.validityText === 'string' ? doc.product.validityText : undefined,
              };

              try {
                const res = await executeScantechDirectExportJob(job);
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
    const linked = linkSavedPosterToCampaignItem(
      activeCampaign,
      psdOfferContext.offerItemId,
      path,
      savedDocument
    );
    await persistUpdate(linked);
    if (onRefreshLibrary) await onRefreshLibrary();
    setPreviewKey(`${psdOfferContext.offerItemId}::${path}`);
  };

  const handleLinkLibraryPoster = async (offerItemId: string, poster: IndexedCartaz) => {
    if (!activeCampaign) return;
    const linked = linkSavedPosterToCampaignItem(activeCampaign, offerItemId, poster.path, poster.document);
    await persistUpdate(linked);
    setPreviewKey(`${offerItemId}::${poster.path}`);
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

  const filteredViews = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase('pt-BR');
    return matchViews.filter(v => {
      if (q && !`${v.item.f7} ${v.item.description}`.toLocaleLowerCase('pt-BR').includes(q)) {
        return false;
      }
      if (statusFilter === 'com-cartaz') return v.matchedPosters.some(m => Boolean(m.libraryCartaz));
      if (statusFilter === 'sem-cartaz') return v.missingPoster;
      if (statusFilter === 'pendente' || statusFilter === 'preparado' || statusFilter === 'impresso') {
        return v.matchedPosters.some(m => m.state.status === statusFilter);
      }
      return true;
    });
  }, [matchViews, searchQuery, statusFilter]);

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
          };
        }
      }
    }
    return null;
  }, [matchViews, previewKey]);

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

  const handleTriggerPartialPrint = (reprintPrinted = false) => {
    if (!activeCampaign) return;
    const queue: Poster[] = [];
    const keys = new Set<string>();
    const blockedProducts: string[] = [];
    const limit = Math.max(1, Math.min(200, batchSize));
    let distinctPostersCount = 0;
    for (const v of matchViews) {
      for (const m of v.matchedPosters) {
        if (!m.state.selected || !m.scheduledDocument) continue;
        if (!reprintPrinted && m.state.status === 'impresso') continue;
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
          : 'Não há cartazes selecionados com status Preparado/Pendente para imprimir.'
      );
    }
    setAwaitingPrintConfirm({ keys, count: distinctPostersCount });
    onPrintBatch(queue);
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
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      Cartazes por parte:
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={batchSize}
                        onChange={e => setBatchSize(Math.max(1, parseInt(e.target.value, 10) || 10))}
                        style={{ width: 70 }}
                      />
                    </label>
                    <button
                      onClick={() =>
                        run(async () => {
                          handleTriggerPartialPrint(false);
                        })
                      }
                    >
                      Imprimir próxima parte (até {batchSize})
                    </button>
                    <button
                      className="subtle"
                      onClick={() =>
                        run(async () => {
                          handleTriggerPartialPrint(true);
                        })
                      }
                    >
                      Reimprimir selecionados
                    </button>
                    <button
                      style={{ background: '#0284c7', color: '#fff', marginLeft: 'auto' }}
                      onClick={() => setShowExportModal(true)}
                    >
                      📦 Exportar Cartazes (PSD / SK)
                    </button>
                  </div>

                  <div className="offer-workspace">
                    <div className="import-table-wrap">
                      <table className="import-table">
                        <thead>
                          <tr>
                            <th>F7</th>
                            <th>Produto (Excel)</th>
                            <th>Preço Programado</th>
                            <th>Cartazes da Biblioteca e Impressão</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredViews.map(v => (
                            <tr key={v.item.id}>
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
                                        onClick={() => {
                                          if (window.confirm(`Remover "${v.item.description}" (F7 ${v.item.f7}) da pasta de ofertas?`)) {
                                            run(async () => {
                                              await persistUpdate(removeCampaignItem(activeCampaign, v.item.id));
                                            });
                                          }
                                        }}
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
                                    <strong style={{ color: '#137b52', fontSize: 15 }}>
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
                                    {v.matchedPosters.map(m => {
                                      const key = `${v.item.id}::${m.state.cartazPath}`;
                                      return (
                                        <div key={key} className="offer-poster-row">
                                          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <input
                                              type="checkbox"
                                              checked={m.state.selected}
                                              disabled={!m.libraryCartaz}
                                              onChange={e =>
                                                run(async () => {
                                                  await persistUpdate(
                                                    updatePosterSelection(
                                                      activeCampaign,
                                                      v.item.id,
                                                      m.state.cartazPath,
                                                      { selected: e.target.checked }
                                                    )
                                                  );
                                                })
                                              }
                                            />
                                            <span>
                                              <strong>
                                                {m.libraryCartaz?.document.product.name ?? 'Arquivo ausente'}{' '}
                                                {m.libraryCartaz?.document.product.complement ?? ''}
                                              </strong>
                                              <div style={{ fontSize: 13, marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                <span>
                                                  Preço no cartaz:{' '}
                                                  <strong style={{ color: '#10b981', fontSize: 14 }}>{money(v.item.scheduledPriceCents)}</strong>
                                                </span>
                                                {m.currentPriceCents !== null && m.currentPriceCents !== v.item.scheduledPriceCents && (
                                                  <span style={{ color: '#94a3b8', fontSize: 11 }}>
                                                    (Preço base na biblioteca: {money(m.currentPriceCents)})
                                                  </span>
                                                )}
                                              </div>
                                              <small style={{ color: '#64748b', display: 'block', marginTop: 2 }}>
                                                {m.state.cartazPath}
                                              </small>
                                            </span>
                                          </label>
                                          {m.priceMismatchReason && (
                                            <div
                                              className="import-warning"
                                              role="alert"
                                              style={{ marginTop: 6, fontSize: 12 }}
                                            >
                                              <strong>Impressão bloqueada:</strong> {m.priceMismatchReason}
                                              {m.hasInvertedLayers && m.libraryCartaz && (
                                                <div style={{ marginTop: 6 }}>
                                                  <button
                                                    className="subtle"
                                                    style={{ padding: '4px 10px', fontSize: 12 }}
                                                    onClick={() =>
                                                      run(() =>
                                                        handleRepairInvertedPoster(
                                                          m.libraryCartaz!.path,
                                                          m.libraryCartaz!.document
                                                        )
                                                      )
                                                    }
                                                  >
                                                    Corrigir inversão Reais/Centavos neste cartaz
                                                  </button>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                          <div className="toolbar" style={{ alignItems: 'center', marginTop: 6 }}>
                                            <label style={{ fontSize: 12 }}>
                                              Cópias:{' '}
                                              <input
                                                type="number"
                                                min={1}
                                                max={999}
                                                value={m.state.copies}
                                                onChange={e =>
                                                  run(async () => {
                                                    await persistUpdate(
                                                      updatePosterSelection(
                                                        activeCampaign,
                                                        v.item.id,
                                                        m.state.cartazPath,
                                                        { copies: parseInt(e.target.value, 10) || 1 }
                                                      )
                                                    );
                                                  })
                                                }
                                                style={{ width: 60, padding: '4px 6px' }}
                                              />
                                            </label>
                                            <select
                                              aria-label="Status de impressão"
                                              value={m.state.status}
                                              onChange={e =>
                                                run(async () => {
                                                  await persistUpdate(
                                                    updatePosterSelection(
                                                      activeCampaign,
                                                      v.item.id,
                                                      m.state.cartazPath,
                                                      { status: e.target.value as PrintStatus }
                                                    )
                                                  );
                                                })
                                              }
                                              style={{ padding: '4px 8px', fontSize: 12 }}
                                            >
                                              <option value="pendente">Pendente</option>
                                              <option value="preparado">Preparado</option>
                                              <option value="impresso">Impresso</option>
                                            </select>
                                            <button
                                              className="subtle"
                                              style={{ padding: '5px 10px', fontSize: 12 }}
                                              onClick={() => setPreviewKey(key)}
                                            >
                                              Ver prévia futura
                                            </button>
                                            {onEditPoster && m.libraryCartaz && (
                                              <button
                                                className="subtle"
                                                style={{ padding: '5px 10px', fontSize: 12 }}
                                                title="Abrir este cartaz no editor com o preço desta oferta"
                                                onClick={() => run(() => onEditPoster(m.libraryCartaz!.path, v.item.scheduledPriceCents))}
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
                                                onClick={() => {
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
                                              onClick={() => {
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
                                        </div>
                                      );
                                    })}
                                    {v.unlinkedLibraryPosters.map(poster => (
                                      <div key={poster.path} className="offer-poster-row">
                                        <strong>
                                          Encontrado na biblioteca: {poster.document.product.name}{' '}
                                          {poster.document.product.complement}
                                        </strong>
                                        <small>
                                          F7 {v.item.f7} · {poster.path}
                                        </small>
                                        <button
                                          className="subtle"
                                          style={{ padding: '5px 10px', fontSize: 12 }}
                                          onClick={() => run(() => handleLinkLibraryPoster(v.item.id, poster))}
                                        >
                                          Vincular cartaz
                                        </button>
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
                      <h3>Prévia com Preço Programado</h3>
                      {selectedPosterPreview ? (
                        <>
                          <p style={{ marginBottom: 8 }}>
                            <strong>{selectedPosterPreview.item.description}</strong> (F7:{' '}
                            {selectedPosterPreview.item.f7})
                            <br />
                            Biblioteca: {money(selectedPosterPreview.currentPriceCents)} →{' '}
                            <strong>Programado: {money(selectedPosterPreview.item.scheduledPriceCents)}</strong>
                          </p>
                          <div className="paper-wrap">
                            <PosterView poster={selectedPosterPreview.poster} />
                          </div>
                        </>
                      ) : (
                        <p className="empty">
                          Vincule um cartaz da biblioteca pelo F7 para visualizar a prévia com o preço futuro.
                        </p>
                      )}
                    </div>
                  </div>
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
                    onChange={e => setPsdPaperSize(e.target.value as PaperFormat)}
                    style={{ padding: '4px 8px', fontWeight: 'bold', color: '#0f172a' }}
                  >
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

            <div className="import-stats" style={{ margin: '4px 0 10px' }}>
              <span><strong>{activeCampaign?.items.length ?? 0}</strong> produtos na campanha</span>
              <span><strong>{scannedPsds.length}</strong> PSDs na pasta</span>
              <span><strong>{pairingStats.exactF7}</strong> F7 exato</span>
              <span><strong>{pairingStats.descriptionSimilar}</strong> descrição parecida</span>
              <span><strong>{pairingStats.ambiguous}</strong> ambíguos / múltiplos candidatos</span>
              <span><strong>{pairingStats.noSuggestion}</strong> sem sugestão</span>
              <span><strong>{batchConfirmationSummary.toLink.length}</strong> prontos para o lote</span>
            </div>

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
                      Confirmar aplicação de vínculos em lote ({batchConfirmationSummary.toLink.length} produto(s) · Formato {psdPaperSize})
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
                  onChange={e => setPsdFilterText(e.target.value)}
                  style={{ maxWidth: 340, flex: 1 }}
                />
                <select
                  aria-label="Filtrar recomendações de pareamento PSD"
                  value={psdReasonFilter}
                  onChange={e => setPsdReasonFilter(e.target.value as PsdPairingFilter)}
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
                  {filteredPsdSuggestions.map(s => {
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
                                ⚡ Vincular agora ({psdPaperSize})
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
                    checked={!exportOnlySelected}
                    onChange={() => setExportOnlySelected(false)}
                  />
                  <span>Todos os cartazes com arte vinculada da campanha</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="exportScope"
                    checked={exportOnlySelected}
                    onChange={() => setExportOnlySelected(true)}
                  />
                  <span>Apenas os cartazes marcados na tabela (checkbox)</span>
                </label>
              </div>
            </fieldset>

            <div style={{ margin: '12px 0' }}>
              <label style={{ fontWeight: 'bold', fontSize: 13, display: 'block', marginBottom: 6 }}>
                Pasta de Destino:
              </label>
              <div className="toolbar" style={{ marginTop: 0 }}>
                <input
                  readOnly
                  placeholder="Selecione a pasta no computador..."
                  value={exportFolder || ''}
                  style={{ flex: 1, background: '#f8fafc' }}
                />
                <button onClick={() => run(handleChooseExportFolder)}>
                  📁 Escolher Pasta
                </button>
              </div>
              {exportFolder && activeCampaign && (
                <small style={{ color: '#475569', display: 'block', marginTop: 4 }}>
                  Será organizada na subpasta: <code>{activeCampaign.name}_{activeCampaign.campaignDate}</code>
                </small>
              )}
            </div>

            {exportProgress && (
              <div style={{ margin: '14px 0', padding: 12, background: '#f1f5f9', borderRadius: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                  <span>{exportProgress.message}</span>
                  <span><strong>{exportProgress.current} / {exportProgress.total}</strong></span>
                </div>
                <div style={{ height: 8, background: '#cbd5e1', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      background: '#0284c7',
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
                  {exportFormatPsd && <li><strong>{exportResult.psdCount} de {exportResult.candidateCount}</strong> arquivos .PSD gerados.</li>}
                  {exportFormatSk && <li><strong>{exportResult.skCount} de {exportResult.candidateCount}</strong> arquivos .skcartaz gerados.</li>}
                </ul>
                {exportResult.errors.length > 0 && (
                  <div style={{ marginTop: 8, color: '#b91c1c' }}>
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
                disabled={exporting || !exportFolder || (!exportFormatPsd && !exportFormatSk)}
                onClick={() => run(handleRunBatchExport)}
              >
                {exporting ? 'Exportando…' : 'Iniciar Exportação em Lote'}
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
