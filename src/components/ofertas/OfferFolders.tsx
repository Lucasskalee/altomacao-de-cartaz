import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { PosterView, type Poster } from '../editor/PosterView';
import { hasInvertedPsdPriceParts, repairInvertedPsdArtwork } from '../editor/importedRenderer';
import { posterFromDocument } from '../../features/cartazes/presentation';
import { indexCartazes } from '../../features/cartazes/f7';
import { saveDocument } from '../../features/cartazes/storage';
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
  confirmBatchPrinted,
  createCampaign,
  duplicateCampaign,
  linkSavedPosterToCampaignItem,
  listCampaigns,
  renameCampaign,
  saveCampaign,
  selectExcel,
  syncCampaignWithLibrary,
  updatePosterSelection,
  updateScheduledPrice,
} from '../../features/ofertas/service';
import type { OfferCampaign, PrintStatus, PsdImportOfferContext } from '../../features/ofertas/types';
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
import type { PaperFormat } from '../../features/cartazes/types';
import type { CampaignItem } from '../../features/ofertas/types';

const PsdImport = lazy(() =>
  import('../library/PsdImport').then(module => ({ default: module.PsdImport }))
);

type Props = {
  libraryData: LibraryData | null;
  run: (action: () => Promise<void>) => void;
  onPrintBatch: (posters: Poster[]) => void;
  onRefreshLibrary?: () => Promise<void>;
};

const money = (cents: number | null) =>
  cents === null ? '—' : `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

const tomorrowIso = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function OfferFolders({ libraryData, run, onPrintBatch, onRefreshLibrary }: Props) {
  const [campaigns, setCampaigns] = useState<OfferCampaign[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
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

  // Batch print tracking
  const [batchSize, setBatchSize] = useState(10);
  const [awaitingPrintConfirm, setAwaitingPrintConfirm] = useState<{ keys: Set<string>; count: number } | null>(null);

  // Pasta de PSDs para pareamento em lote e formato de papel (A6 por padrão)
  const [scannedPsds, setScannedPsds] = useState<ScannedPsdEntry[]>([]);
  const [psdFolder, setPsdFolder] = useState<string | null>(null);
  const [psdPaperSize, setPsdPaperSize] = useState<PaperFormat>('A6');
  const [showPsdManagerModal, setShowPsdManagerModal] = useState(false);
  const [psdFilterText, setPsdFilterText] = useState('');
  const [psdSelectedTargets, setPsdSelectedTargets] = useState<Record<string, string>>({});
  const [batchLinking, setBatchLinking] = useState(false);
  const [batchLinkFeedback, setBatchLinkFeedback] = useState<string | null>(null);

  // Exportação em lote da pasta de ofertas
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormatPsd, setExportFormatPsd] = useState(true);
  const [exportFormatSk, setExportFormatSk] = useState(true);
  const [exportOnlySelected, setExportOnlySelected] = useState(false);
  const [exportFolder, setExportFolder] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [exportResult, setExportResult] = useState<{ psdCount: number; skCount: number; errors: string[] } | null>(null);

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

  const handleChoosePsdFolder = async () => {
    const folder = await chooseScantechPsdFolder();
    if (!folder) return;
    setPsdFolder(folder);
    const entries = await scanScantechPsdFolder(folder);
    setScannedPsds(entries);

    // Tenta pareamento automático por similaridade para itens que estão sem cartaz
    if (activeCampaign && entries.length > 0) {
      const matchViews = buildCampaignMatchViews(activeCampaign, libraryIndex);
      const missing = matchViews.filter(v => v.missingPoster);
      let updatedCampaign = activeCampaign;
      let matchedCount = 0;

      for (const view of missing) {
        const f7 = view.item.f7;
        const descTokens = view.item.description
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
          .split(' ')
          .filter(t => t.length >= 2 && !['de', 'da', 'do', 'com', 'para', 'em', 'un', 'kg', 'lt'].includes(t));

        const matchedEntry = entries.find(e => {
          const normPsd = e.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          if (f7 && new RegExp(`(?:^|\\D)0*${f7.replace(/^0+/, '') || '0'}(?:\\D|$)`).test(normPsd)) {
            return true;
          }
          const matchedWords = descTokens.filter(t => normPsd.includes(t)).length;
          return matchedWords >= 2 && matchedWords / Math.max(1, descTokens.length) >= 0.5;
        });

        if (matchedEntry) {
          try {
            const psdData = await readPsdByPath(matchedEntry.path);
            const analysis = await analyzePsd(psdData.buffer, psdData.name, psdData.path);
            const roles = analysis.suggested;
            if (roles.whole && roles.fraction) {
              let artwork = buildArtwork(analysis, roles);
              if (hasInvertedPsdPriceParts(artwork)) {
                artwork = repairInvertedPsdArtwork(artwork).artwork;
              }
              const now = new Date().toISOString();
              const cartazDoc: Cartaz = {
                schemaVersion: 1,
                id: crypto.randomUUID(),
                product: {
                  name: (view.item.description || 'PRODUTO').trim().toUpperCase(),
                  complement: '',
                  unit: 'UN',
                  priceCents: view.item.scheduledPriceCents || 100,
                  productCode: f7 || null,
                  validityText: analysis.metadata.validityText || '',
                },
                layout: {
                  template: 'imported-psd',
                  paper: psdPaperSize,
                  orientation: 'portrait',
                  artwork,
                },
                metadata: {
                  createdAt: now,
                  updatedAt: now,
                },
              };

              const rootDir = libraryData?.root || '';
              const baseSlug = (view.item.description || 'cartaz')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 50);
              const cleanF7 = f7 ? `${f7} - ` : '';
              const sizeTag = ` [${psdPaperSize}]`;
              const targetPath = `${rootDir ? rootDir + '\\' : ''}${cleanF7}${baseSlug}${sizeTag}.skcartaz`;

              await saveDocument(targetPath, cartazDoc, true);
              updatedCampaign = linkSavedPosterToCampaignItem(
                updatedCampaign,
                view.item.id,
                targetPath,
                cartazDoc
              );
              matchedCount++;
            }
          } catch {
            // Ignora se o arquivo não tiver camadas válidas
          }
        }
      }

      if (matchedCount > 0) {
        await persistUpdate(updatedCampaign);
        if (onRefreshLibrary) await onRefreshLibrary();
      }
    }
  };

  const handleAssignPsdToOfferItem = async (
    itemId: string,
    f7: string,
    description: string,
    priceCents: number,
    psdPath: string,
    paperSize: PaperFormat = psdPaperSize
  ) => {
    if (!activeCampaign) return;
    const psdData = await readPsdByPath(psdPath);
    const analysis = await analyzePsd(psdData.buffer, psdData.name, psdData.path);
    const roles = analysis.suggested;
    if (!roles.whole || !roles.fraction) {
      throw new Error(`Não foi possível detectar as camadas de preço no PSD "${psdData.name}".`);
    }
    let artwork = buildArtwork(analysis, roles);
    if (hasInvertedPsdPriceParts(artwork)) {
      artwork = repairInvertedPsdArtwork(artwork).artwork;
    }

    const now = new Date().toISOString();
    const cartazDoc: Cartaz = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      product: {
        name: (description || 'PRODUTO').trim().toUpperCase(),
        complement: '',
        unit: 'UN',
        priceCents: priceCents || 100,
        productCode: f7 || null,
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

    const rootDir = libraryData?.root || '';
    const baseSlug = (description || 'cartaz')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const cleanF7 = f7 ? `${f7} - ` : '';
    const sizeTag = ` [${paperSize}]`;
    const targetPath = `${rootDir ? rootDir + '\\' : ''}${cleanF7}${baseSlug}${sizeTag}.skcartaz`;

    await saveDocument(targetPath, cartazDoc, true);
    const updated = linkSavedPosterToCampaignItem(
      activeCampaign,
      itemId,
      targetPath,
      cartazDoc
    );
    await persistUpdate(updated);
    if (onRefreshLibrary) await onRefreshLibrary();
    setPreviewKey(`${itemId}::${targetPath}`);
  };

  const findBestItemForPsd = (psdName: string): { item: CampaignItem; score: number } | null => {
    if (!activeCampaign) return null;
    const normPsd = psdName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\.psd$/i, '');

    // 1. Tenta correspondência direta de F7
    for (const it of activeCampaign.items) {
      if (it.f7 && new RegExp(`(?:^|\\D)0*${it.f7.replace(/^0+/, '') || '0'}(?:\\D|$)`).test(normPsd)) {
        return { item: it, score: 1.0 };
      }
    }

    // 2. Tenta correspondência por palavras da descrição
    let best: { item: CampaignItem; score: number } | null = null;
    let maxScore = 0;
    for (const it of activeCampaign.items) {
      const tokens = it.description
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(t => t.length >= 2 && !['de', 'da', 'do', 'com', 'para', 'em', 'un', 'kg', 'lt', 'cx', 'sc'].includes(t));
      if (tokens.length === 0) continue;
      const matches = tokens.filter(t => normPsd.includes(t)).length;
      const score = matches / tokens.length;
      if (matches >= 2 && score > maxScore) {
        maxScore = score;
        best = { item: it, score };
      } else if (matches === 1 && tokens.length === 1 && score > maxScore) {
        maxScore = score;
        best = { item: it, score };
      }
    }
    return best;
  };

  const handleBatchLinkSuggested = async () => {
    if (!activeCampaign || scannedPsds.length === 0) return;
    setBatchLinking(true);
    setBatchLinkFeedback(null);
    let linkedCount = 0;
    let errorsCount = 0;

    try {
      for (const entry of scannedPsds) {
        const targetItemId = psdSelectedTargets[entry.path];
        let targetItem: CampaignItem | null = null;
        if (targetItemId) {
          targetItem = activeCampaign.items.find(i => i.id === targetItemId) ?? null;
        } else {
          const match = findBestItemForPsd(entry.name);
          if (match && match.score >= 0.5) {
            targetItem = match.item;
          }
        }

        if (!targetItem) continue;

        // Se já tiver cartaz vinculado com este psd, pula
        const normEntryName = entry.name.toLowerCase();
        const alreadyLinked = targetItem.posters.some(p => p.cartazPath.toLowerCase().includes(normEntryName));
        if (alreadyLinked) continue;

        try {
          await handleAssignPsdToOfferItem(
            targetItem.id,
            targetItem.f7,
            targetItem.description,
            targetItem.scheduledPriceCents,
            entry.path,
            psdPaperSize
          );
          linkedCount++;
        } catch {
          errorsCount++;
        }
      }
      setBatchLinkFeedback(
        `Vinculação concluída: ${linkedCount} cartaz(es) ${psdPaperSize} criados e vinculados à campanha.${errorsCount > 0 ? ` (${errorsCount} falhas)` : ''}`
      );
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

      for (const v of matchViews) {
        for (const m of v.matchedPosters) {
          if (!m.scheduledDocument) continue;
          if (exportOnlySelected && !m.state.selected) continue;
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
            await saveDocument(skPath, doc, true);
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

      setExportResult({ psdCount, skCount, errors });
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
      if (statusFilter === 'com-cartaz') return !v.missingPoster;
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

  const filteredScannedPsds = useMemo(() => {
    const q = psdFilterText.trim().toLowerCase();
    if (!q) return scannedPsds;
    return scannedPsds.filter(p => p.name.toLowerCase().includes(q));
  }, [scannedPsds, psdFilterText]);

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
                    className={scannedPsds.length > 0 ? '' : 'subtle'}
                    onClick={() => {
                      if (scannedPsds.length > 0) {
                        setShowPsdManagerModal(true);
                      } else {
                        run(handleChoosePsdFolder);
                      }
                    }}
                  >
                    📁 Pasta PSDs {scannedPsds.length > 0 ? `(${scannedPsds.length} ${psdPaperSize})` : ''}
                  </button>
                  {scannedPsds.length > 0 && (
                    <button className="subtle" onClick={() => setShowPsdManagerModal(true)}>
                      ⚡ Pareamento ({psdPaperSize})
                    </button>
                  )}
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
                                <strong>{v.item.description}</strong>
                                <small>Linha Excel: {v.item.rowNumber}</small>
                              </td>
                              <td>
                                {editingPriceId === v.item.id ? (
                                  <div className="toolbar">
                                    <input
                                      inputMode="decimal"
                                      value={editingPriceValue}
                                      onChange={e => setEditingPriceValue(e.target.value)}
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
                                    {scannedPsds.length > 0 && (
                                      <select
                                        className="subtle"
                                        style={{ maxWidth: 200, fontSize: 11, padding: '4px 6px', background: '#f8fafc', borderColor: '#cbd5e1' }}
                                        value=""
                                        aria-label={`Ligar PSD da pasta para ${v.item.description}`}
                                        onChange={e => {
                                          if (e.target.value) {
                                            run(() =>
                                              handleAssignPsdToOfferItem(
                                                v.item.id,
                                                v.item.f7,
                                                v.item.description,
                                                v.item.scheduledPriceCents,
                                                e.target.value
                                              )
                                            );
                                          }
                                        }}
                                      >
                                        <option value="">⚡ Ligar PSD da pasta...</option>
                                        {scannedPsds.map(p => (
                                          <option key={p.path} value={p.path}>
                                            {p.name}
                                          </option>
                                        ))}
                                      </select>
                                    )}
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
                                              <small>
                                                Preço atual na biblioteca:{' '}
                                                <strong>{money(m.currentPriceCents)}</strong> (intacto) ·{' '}
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
                                          </div>
                                        </div>
                                      );
                                    })}
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
        <div className="modal-backdrop" onClick={() => setShowPsdManagerModal(false)}>
          <section
            className="panel modal"
            style={{ maxWidth: 960, width: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="library-heading" style={{ marginBottom: 10 }}>
              <div>
                <h3>⚡ Vincular Pasta de PSDs à Campanha</h3>
                <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>
                  {psdFolder ? `Pasta: ${psdFolder}` : 'Nenhuma pasta selecionada'}
                </p>
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
                <button className="subtle" onClick={() => run(handleChoosePsdFolder)}>
                  📁 {psdFolder ? 'Trocar Pasta' : 'Selecionar Pasta'}
                </button>
              </div>
            </div>

            {batchLinkFeedback && (
              <div className="import-warning" style={{ margin: '6px 0 10px', padding: 10 }}>
                <strong>{batchLinkFeedback}</strong>
              </div>
            )}

            <div className="import-stats" style={{ margin: '4px 0 12px' }}>
              <span><strong>{scannedPsds.length}</strong> PSDs na pasta</span>
              <span><strong>{psdPaperSize}</strong> formato selecionado</span>
              <span><strong>{activeCampaign?.items.length ?? 0}</strong> produtos na campanha</span>
            </div>

            <div className="toolbar" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
              <input
                placeholder="Filtrar arquivos PSD por nome…"
                value={psdFilterText}
                onChange={e => setPsdFilterText(e.target.value)}
                style={{ maxWidth: 350 }}
              />
              <button
                disabled={batchLinking || scannedPsds.length === 0}
                onClick={() => run(handleBatchLinkSuggested)}
                style={{ background: '#0284c7', color: '#fff' }}
              >
                {batchLinking ? 'Vinculando…' : `⚡ Vincular Todos Sugeridos (${psdPaperSize})`}
              </button>
            </div>

            <div className="import-table-wrap" style={{ flex: 1, overflowY: 'auto', maxHeight: '48vh' }}>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Arquivo PSD</th>
                    <th>Tamanho</th>
                    <th>Produto Sugerido / Selecionado</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredScannedPsds.map(entry => {
                    const normEntryName = entry.name.toLowerCase();
                    const linkedItem = activeCampaign?.items.find(i =>
                      i.posters.some(p => p.cartazPath.toLowerCase().includes(normEntryName))
                    );
                    const suggested = !linkedItem ? findBestItemForPsd(entry.name) : null;
                    const selectedItemId = psdSelectedTargets[entry.path] ?? (suggested?.item.id || '');
                    const currentTargetItem = activeCampaign?.items.find(i => i.id === selectedItemId);

                    return (
                      <tr key={entry.path}>
                        <td>
                          <strong>{entry.name}</strong>
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#64748b' }}>
                          {(entry.size / (1024 * 1024)).toFixed(1)} MB
                        </td>
                        <td>
                          {linkedItem ? (
                            <span className="comparison-status">
                              F7 {linkedItem.f7} — {linkedItem.description} ({money(linkedItem.scheduledPriceCents)})
                            </span>
                          ) : (
                            <select
                              style={{ width: '100%', maxWidth: 440, fontSize: 12, padding: '4px 6px' }}
                              value={selectedItemId}
                              onChange={e =>
                                setPsdSelectedTargets(prev => ({
                                  ...prev,
                                  [entry.path]: e.target.value,
                                }))
                              }
                            >
                              <option value="">(Selecione um produto da campanha)</option>
                              {activeCampaign?.items.map(it => (
                                <option key={it.id} value={it.id}>
                                  {suggested?.item.id === it.id ? '⭐ [Sugerido] ' : ''}
                                  F7 {it.f7} — {it.description} ({money(it.scheduledPriceCents)})
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {linkedItem ? (
                            <span className="comparison-status" style={{ background: '#dcfce7', color: '#15803d' }}>
                              ✓ Vinculado
                            </span>
                          ) : (
                            <button
                              disabled={!currentTargetItem}
                              className="subtle"
                              style={{ fontSize: 11, padding: '4px 8px' }}
                              onClick={() => {
                                if (currentTargetItem) {
                                  run(() =>
                                    handleAssignPsdToOfferItem(
                                      currentTargetItem.id,
                                      currentTargetItem.f7,
                                      currentTargetItem.description,
                                      currentTargetItem.scheduledPriceCents,
                                      entry.path,
                                      psdPaperSize
                                    )
                                  );
                                }
                              }}
                            >
                              ⚡ Vincular ({psdPaperSize})
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredScannedPsds.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: 24, color: '#64748b' }}>
                        Nenhum arquivo PSD encontrado{psdFilterText ? ' com este filtro' : ''}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="toolbar" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="subtle" onClick={() => setShowPsdManagerModal(false)}>
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
                <strong>Exportação Concluída!</strong>
                <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 13 }}>
                  {exportResult.psdCount > 0 && <li><strong>{exportResult.psdCount}</strong> arquivos .PSD gerados.</li>}
                  {exportResult.skCount > 0 && <li><strong>{exportResult.skCount}</strong> arquivos .skcartaz gerados.</li>}
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
