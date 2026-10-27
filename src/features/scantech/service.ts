import { invoke, isTauri } from '@tauri-apps/api/core';
import { findCartazesByF7, type IndexedCartaz } from '../cartazes/f7';
import type { Cartaz, ImportedArtwork, ImportedLayerInfo } from '../cartazes/types';
import { splitCentsToParts } from '../cartazes/presentation';
import { hasInvertedPsdPriceParts, importedPriceWarning } from '../../components/editor/importedRenderer';
import { applyValidityDateToLayerText, type ColumnMapping, type ExcelExtractionResult } from '../ofertas/excel';
import type {
  PhotoshopStatus,
  ScannedPsdEntry,
  ScantechCampaign,
  ScantechExportBatchResult,
  ScantechExportJob,
  ScantechItem,
  ScantechItemStatus,
  ScantechItemView,
  VisualApproval,
} from './types';

const STORAGE_KEY = 'skalee.scantech.campaigns.v1';

const normName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function createScantechCampaign(
  name: string,
  globalEndDate: string,
  globalStartDate: string | null = null,
  psdSourceFolder: string | null = null,
  exportFolder: string | null = null
): ScantechCampaign {
  const cleanName = name.trim();
  const cleanEnd = globalEndDate.trim();
  if (!cleanName) throw new Error('Informe o nome da pasta de ofertas Scantech.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanEnd)) {
    throw new Error('Informe uma data de validade global válida (AAAA-MM-DD).');
  }
  if (globalStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(globalStartDate.trim())) {
    throw new Error('Data inicial global inválida (AAAA-MM-DD).');
  }
  if (globalStartDate && globalStartDate.trim() > cleanEnd) {
    throw new Error('A data inicial global não pode ser posterior à data final.');
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: cleanName.slice(0, 80),
    globalStartDate: globalStartDate?.trim() || null,
    globalEndDate: cleanEnd,
    psdSourceFolder,
    exportFolder,
    archived: false,
    sourceExcel: null,
    items: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updateScantechCampaignSettings(
  campaign: ScantechCampaign,
  updates: {
    name?: string;
    globalStartDate?: string | null;
    globalEndDate?: string;
    psdSourceFolder?: string | null;
    exportFolder?: string | null;
    archived?: boolean;
  }
): ScantechCampaign {
  const nextName = (updates.name ?? campaign.name).trim();
  if (!nextName) throw new Error('Informe o nome da pasta Scantech.');
  const nextEnd = (updates.globalEndDate ?? campaign.globalEndDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextEnd)) {
    throw new Error('Data de validade global inválida (AAAA-MM-DD).');
  }
  const nextStart =
    updates.globalStartDate !== undefined ? updates.globalStartDate?.trim() || null : campaign.globalStartDate;
  if (nextStart && !/^\d{4}-\d{2}-\d{2}$/.test(nextStart)) {
    throw new Error('Data inicial global inválida.');
  }
  if (nextStart && nextStart > nextEnd) {
    throw new Error('A data inicial global não pode ser posterior à data final.');
  }
  return {
    ...campaign,
    name: nextName.slice(0, 80),
    globalStartDate: nextStart,
    globalEndDate: nextEnd,
    psdSourceFolder:
      updates.psdSourceFolder !== undefined ? updates.psdSourceFolder : campaign.psdSourceFolder,
    exportFolder: updates.exportFolder !== undefined ? updates.exportFolder : campaign.exportFolder,
    archived: updates.archived ?? campaign.archived,
    updatedAt: new Date().toISOString(),
  };
}

export function duplicateScantechCampaign(campaign: ScantechCampaign, customName?: string): ScantechCampaign {
  const now = new Date().toISOString();
  const copy: ScantechCampaign = structuredClone(campaign);
  copy.id = crypto.randomUUID();
  copy.name = (customName?.trim() || `${campaign.name} (Cópia)`).slice(0, 80);
  copy.archived = false;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.items = copy.items.map(item => ({
    ...item,
    id: crypto.randomUUID(),
    status: item.wholeLayerId && item.fractionLayerId && item.sourcePsdPath ? 'pronto' : 'sem-psd',
    exportedPsdPath: null,
    exportedAt: null,
    exportError: null,
  }));
  return copy;
}

export function findMatchingScannedPsd(
  f7: string,
  description: string,
  libraryPoster: IndexedCartaz | null,
  scannedPsds: ScannedPsdEntry[]
): ScannedPsdEntry | null {
  if (scannedPsds.length === 0) return null;
  // 1. Se o cartaz da biblioteca já veio de um PSD, procura pelo nome exato do arquivo PSD de origem
  if (libraryPoster?.document.layout.template === 'imported-psd') {
    const sourceName = libraryPoster.document.layout.artwork.source.fileName.toLowerCase();
    const byExactName = scannedPsds.find(entry => entry.name.toLowerCase() === sourceName);
    if (byExactName) return byExactName;
  }
  // 2. Procura pelo código F7 no nome do arquivo PSD
  if (f7) {
    const f7Regex = new RegExp(`(?:^|\\D)0*${f7.replace(/^0+/, '') || '0'}(?:\\D|$)`);
    const byF7 = scannedPsds.find(entry => f7Regex.test(entry.name));
    if (byF7) return byF7;
  }
  // 3. Procura por similaridade de palavras da descrição (ex: "CERVEJA CORONA EXTRA LATA 350ML" -> "cerveja corona extra lata 350ml.psd")
  const stopWords = new Set(['DE', 'DA', 'DO', 'COM', 'PARA', 'EM', 'UN', 'UND', 'KG', 'LT', 'L', 'PCT', 'CX', 'FLV', 'MER', 'TRADICIONAL']);
  const descTokens = normName(description)
    .split(' ')
    .filter(t => t.length >= 2 && !stopWords.has(t.toUpperCase()));
  if (descTokens.length >= 1) {
    let best: { entry: ScannedPsdEntry; score: number } | null = null;
    for (const entry of scannedPsds) {
      const fileTokens = new Set(normName(entry.name.replace(/\.psd$/i, '')).split(' ').filter(Boolean));
      const matched = descTokens.filter(t => fileTokens.has(t)).length;
      const ratio = matched / descTokens.length;
      if (matched >= 2 && ratio >= 0.5 && (!best || ratio > best.score)) {
        best = { entry, score: ratio };
      }
    }
    if (best) return best.entry;
  }
  return null;
}

function extractRolesFromArtwork(artwork: ImportedArtwork): {
  wholeLayerId: string | null;
  fractionLayerId: string | null;
  decimalLayerId: string | null;
  fractionRuleLayerId: string | null;
  validityLayerId: string | null;
  originalValidityText: string | null;
} {
  const wholePart = artwork.priceParts.find(p => p.role === 'whole');
  const fractionPart = artwork.priceParts.find(p => p.role === 'fraction');
  const decimalPart = artwork.priceParts.find(p => p.role === 'decimal');
  const rulePart = artwork.priceParts.find(p => p.role === 'fractionRule');
  const validityPart = artwork.priceParts.find(p => p.role === 'validity');
  if (validityPart) {
    return {
      wholeLayerId: wholePart?.layerId ?? null,
      fractionLayerId: fractionPart?.layerId ?? null,
      decimalLayerId: decimalPart?.layerId ?? null,
      fractionRuleLayerId: rulePart?.layerId ?? null,
      validityLayerId: validityPart.layerId,
      originalValidityText: validityPart.originalText ?? null,
    };
  }
  // Caso o cartaz tenha sido importado antes da Sprint 07, detecta automaticamente a camada de validade na lista de layers
  const detectedValidity = detectValidityLayer(artwork.layers);
  return {
    wholeLayerId: wholePart?.layerId ?? null,
    fractionLayerId: fractionPart?.layerId ?? null,
    decimalLayerId: decimalPart?.layerId ?? null,
    fractionRuleLayerId: rulePart?.layerId ?? null,
    validityLayerId: detectedValidity?.id ?? null,
    originalValidityText: detectedValidity?.text ?? null,
  };
}

export function detectValidityLayer(layers: ImportedLayerInfo[]): ImportedLayerInfo | null {
  const visible = layers.filter(l => l.visible && l.type === 'text');
  const pattern = /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b|promo[cç][aã]o\s+v[aá]lida)/i;
  const byKeyword = visible.find(l => pattern.test(l.text ?? l.name));
  if (byKeyword) return byKeyword;
  const byDateAtBottom = visible.find(
    l => /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(l.text ?? '') && l.bounds.top > 900
  );
  return byDateAtBottom ?? null;
}

export function applyExcelToScantechCampaign(
  campaign: ScantechCampaign,
  extraction: ExcelExtractionResult,
  library: IndexedCartaz[],
  scannedPsds: ScannedPsdEntry[],
  sourceMeta: { fileName: string; sheetName: string; headerRowIndex: number; mapping: ColumnMapping }
): ScantechCampaign {
  if (extraction.items.length === 0) {
    throw new Error('Nenhuma linha encontrada na planilha Excel.');
  }
  const nextItems: ScantechItem[] = [];
  for (const row of extraction.items) {
    const f7 = row.f7 ?? '';
    const existing = f7 ? campaign.items.find(i => i.f7 === f7 && i.rowNumber === row.rowNumber) ?? campaign.items.find(i => i.f7 === f7) : null;
    const libraryMatches = f7 ? findCartazesByF7(f7, library) : [];
    const importedMatch =
      libraryMatches.find(m => m.document.layout.template === 'imported-psd') ?? libraryMatches[0] ?? null;

    const artwork =
      importedMatch?.document.layout.template === 'imported-psd'
        ? importedMatch.document.layout.artwork
        : null;
    const roles = artwork ? extractRolesFromArtwork(artwork) : null;

    const scannedMatch = findMatchingScannedPsd(f7, row.description, importedMatch, scannedPsds);
    const sourcePsdPath =
      existing?.sourcePsdPath ??
      artwork?.source.sourcePath ??
      scannedMatch?.path ??
      null;
    const sourcePsdName =
      existing?.sourcePsdName ??
      artwork?.source.fileName ??
      scannedMatch?.name ??
      null;

    const wholeLayerId = existing?.wholeLayerId ?? roles?.wholeLayerId ?? null;
    const fractionLayerId = existing?.fractionLayerId ?? roles?.fractionLayerId ?? null;
    const decimalLayerId = existing?.decimalLayerId ?? roles?.decimalLayerId ?? null;
    const fractionRuleLayerId = existing?.fractionRuleLayerId ?? roles?.fractionRuleLayerId ?? null;
    const validityLayerId = existing?.validityLayerId ?? roles?.validityLayerId ?? null;
    const originalValidityText = existing?.originalValidityText ?? roles?.originalValidityText ?? null;

    const itemIssues = [...row.issues];
    let status: ScantechItemStatus = 'pronto';
    if (itemIssues.length > 0 || !f7 || row.priceCents === null) {
      status = 'inconsistente';
    } else if (!wholeLayerId || !fractionLayerId || (!artwork && !sourcePsdPath)) {
      status = 'sem-psd';
    }

    nextItems.push({
      id: existing?.id ?? crypto.randomUUID(),
      rowNumber: row.rowNumber,
      f7,
      description: row.description || '(SEM DESCRIÇÃO)',
      priceCents: row.priceCents ?? 0,
      previousPriceCents: row.previousPriceCents ?? null,
      startDateIso: row.startDateIso ?? null,
      endDateIso: row.endDateIso ?? null,
      customValidityText: existing?.customValidityText ?? null,
      sourcePsdPath,
      sourcePsdName,
      cartazId: importedMatch?.document.id ?? existing?.cartazId ?? null,
      cartazPath: importedMatch?.path ?? existing?.cartazPath ?? null,
      wholeLayerId,
      fractionLayerId,
      decimalLayerId,
      fractionRuleLayerId,
      validityLayerId,
      originalValidityText,
      selected: status === 'pronto',
      status,
      issues: itemIssues,
      exportedPsdPath: null,
      exportedAt: null,
      exportError: null,
    });
  }

  const now = new Date().toISOString();
  return {
    ...campaign,
    sourceExcel: {
      ...sourceMeta,
      importedAt: now,
    },
    items: nextItems,
    updatedAt: now,
  };
}

export function linkCartazAndPsdToScantechItem(
  campaign: ScantechCampaign,
  itemId: string,
  cartazPath: string,
  cartazDocument: Cartaz,
  sourcePsdPath?: string | null
): ScantechCampaign {
  if (cartazDocument.layout.template !== 'imported-psd') {
    throw new Error('O cartaz vinculado precisa ser uma arte PSD importada.');
  }
  const artwork = cartazDocument.layout.artwork;
  const roles = extractRolesFromArtwork(artwork);
  const resolvedSourcePath = sourcePsdPath ?? artwork.source.sourcePath ?? null;
  const now = new Date().toISOString();

  const items = campaign.items.map(item => {
    const isTarget = item.id === itemId || (Boolean(item.f7) && item.f7 === cartazDocument.product.productCode);
    if (!isTarget) return item;
    const hasPriceAndF7 = Boolean(item.f7) && item.priceCents > 0 && item.issues.length === 0;
    const ready = hasPriceAndF7 && Boolean(roles.wholeLayerId && roles.fractionLayerId);
    return {
      ...item,
      cartazId: cartazDocument.id,
      cartazPath,
      sourcePsdPath: resolvedSourcePath ?? item.sourcePsdPath,
      sourcePsdName: artwork.source.fileName || item.sourcePsdName,
      wholeLayerId: roles.wholeLayerId,
      fractionLayerId: roles.fractionLayerId,
      decimalLayerId: roles.decimalLayerId,
      fractionRuleLayerId: roles.fractionRuleLayerId,
      validityLayerId: roles.validityLayerId,
      originalValidityText: roles.originalValidityText,
      status: ready ? ('pronto' as const) : item.status,
      selected: ready ? true : item.selected,
      exportError: null,
    };
  });

  return {
    ...campaign,
    items,
    updatedAt: now,
  };
}

export function updateScantechItemFields(
  campaign: ScantechCampaign,
  itemId: string,
  updates: {
    priceCents?: number;
    startDateIso?: string | null;
    endDateIso?: string | null;
    customValidityText?: string | null;
    selected?: boolean;
    sourcePsdPath?: string | null;
    sourcePsdName?: string | null;
    wholeLayerId?: string | null;
    fractionLayerId?: string | null;
    decimalLayerId?: string | null;
    fractionRuleLayerId?: string | null;
    validityLayerId?: string | null;
    originalValidityText?: string | null;
    visualApproval?: VisualApproval | null;
  }
): ScantechCampaign {
  const now = new Date().toISOString();
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.map(item => {
      if (item.id !== itemId) return item;
      const next: ScantechItem = {
        ...item,
        ...updates,
        exportError: null,
      };
      if (updates.priceCents !== undefined && updates.priceCents > 0) {
        next.issues = next.issues.filter(msg => !/pre[cç]o/i.test(msg));
        if (next.visualApproval && updates.priceCents !== next.visualApproval.priceCents) {
          next.visualApproval = null;
        }
      }
      if (updates.endDateIso !== undefined && updates.endDateIso) {
        next.issues = next.issues.filter(msg => !/data/i.test(msg));
        if (next.visualApproval && next.visualApproval.validityText) {
          next.visualApproval = null;
        }
      }
      if (updates.customValidityText !== undefined && next.visualApproval) {
        next.visualApproval = null;
      }
      if (updates.sourcePsdPath !== undefined && next.visualApproval) {
        next.visualApproval = null;
      }
      if (next.issues.length > 0 || !next.f7 || next.priceCents <= 0) {
        next.status = 'inconsistente';
      } else if (!next.wholeLayerId || !next.fractionLayerId) {
        next.status = 'sem-psd';
      } else if (next.status !== 'exportado') {
        next.status = 'pronto';
      }
      return next;
    }),
  };
}

export function buildScantechItemViews(
  campaign: ScantechCampaign,
  library: IndexedCartaz[],
  extraArtworks: Map<string, ImportedArtwork> = new Map()
): ScantechItemView[] {
  return campaign.items.map(item => {
    const effectiveEndDate = (item.endDateIso || campaign.globalEndDate || '').trim();
    const effectiveStartDate = item.startDateIso || campaign.globalStartDate || null;
    const { whole: wholeValue, fraction: fractionValue } = splitCentsToParts(item.priceCents);

    let artwork: ImportedArtwork | null = extraArtworks.get(item.id) ?? null;
    if (!artwork && item.cartazPath) {
      const byPath = library.find(entry => entry.path.toLowerCase() === item.cartazPath?.toLowerCase());
      if (byPath?.document.layout.template === 'imported-psd') {
        artwork = byPath.document.layout.artwork;
      }
    }
    if (!artwork && item.f7) {
      const byF7 = findCartazesByF7(item.f7, library).find(
        entry => entry.document.layout.template === 'imported-psd'
      );
      if (byF7?.document.layout.template === 'imported-psd') {
        artwork = byF7.document.layout.artwork;
      }
    }

    const baseValidityText =
      item.originalValidityText ??
      artwork?.priceParts.find(p => p.role === 'validity')?.originalText ??
      (artwork ? detectValidityLayer(artwork.layers)?.text : null) ??
      'OFERTA VÁLIDA ATÉ 25/10';

    const resolvedValidityText = item.customValidityText?.trim()
      ? item.customValidityText.trim()
      : effectiveEndDate
        ? applyValidityDateToLayerText(baseValidityText, effectiveEndDate, effectiveStartDate)
        : baseValidityText;

    const realErrors: string[] = [...(item.issues ?? [])];
    if (!item.f7) realErrors.push('Produto sem código F7.');
    if (!Number.isSafeInteger(item.priceCents) || item.priceCents <= 0) {
      realErrors.push('Preço programado inválido.');
    }
    if (!effectiveEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveEndDate)) {
      realErrors.push('Data de validade da oferta ausente ou inválida.');
    }
    if (effectiveStartDate && effectiveEndDate && effectiveStartDate > effectiveEndDate) {
      realErrors.push(`Data inicial (${effectiveStartDate}) posterior à data final (${effectiveEndDate}).`);
    }

    let hasInvertedLayers = false;
    let widthWarning: string | null = item.importedPriceWarning ?? null;
    if (artwork) {
      // Verifica se o mapeamento do item ou da arte está invertido geometricamente
      const wLayer = artwork.layers.find(l => l.id === (item.wholeLayerId ?? ''));
      const fLayer = artwork.layers.find(l => l.id === (item.fractionLayerId ?? ''));
      if (wLayer && fLayer) {
        const wCenter = (wLayer.bounds.left + wLayer.bounds.right) / 2;
        const fCenter = (fLayer.bounds.left + fLayer.bounds.right) / 2;
        if (wCenter > fCenter + 8) {
          hasInvertedLayers = true;
        }
      } else if (hasInvertedPsdPriceParts(artwork)) {
        hasInvertedLayers = true;
      }
      if (hasInvertedLayers) {
        realErrors.push(
          'Camadas de Reais e Centavos estão invertidas (Reais à direita dos Centavos). Corrija a inversão antes de exportar.'
        );
      }
      const rawWarning = importedPriceWarning(artwork, `${wholeValue},${fractionValue}`);
      if (rawWarning) {
        widthWarning = rawWarning;
      }
    }

    if (!item.wholeLayerId || !item.fractionLayerId) {
      realErrors.push('Mapeamento das camadas de Reais e Centavos pendente.');
    }
    if (!item.sourcePsdPath) {
      realErrors.push('Arquivo .psd original não vinculado para exportação no Photoshop.');
    }

    // Validação estrita da aprovação visual vinculada a F7, preço, validade e versão da arte (SHA256)
    const artSha256 = artwork?.source.sha256 ?? item.sourcePsdSha256 ?? null;
    const isVisuallyApproved = Boolean(
      item.visualApproval &&
        item.visualApproval.f7 === item.f7 &&
        item.visualApproval.priceCents === item.priceCents &&
        item.visualApproval.validityText === resolvedValidityText &&
        (!item.visualApproval.sourcePsdSha256 || !artSha256 || item.visualApproval.sourcePsdSha256 === artSha256)
    );

    const blockingReasons: string[] = [...realErrors];
    if (widthWarning && !isVisuallyApproved) {
      blockingReasons.push(`Alerta de largura: ${widthWarning}`, widthWarning);
    }

    const canExport = blockingReasons.length === 0;
    return {
      item,
      effectiveEndDate,
      effectiveStartDate,
      resolvedValidityText,
      wholeValue,
      fractionValue,
      artwork,
      hasInvertedLayers,
      widthWarning,
      isVisuallyApproved,
      realErrors,
      blockingReasons,
      canExport,
    };
  });
}

export function buildOutputPsdPath(exportFolder: string, item: ScantechItem): string {
  const cleanFolder = exportFolder.replace(/[\\/]+$/, '');
  const baseSlug = (item.sourcePsdName ? item.sourcePsdName.replace(/\.psd$/i, '') : item.description)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const fileName = `${item.f7}-${baseSlug || 'cartaz'}-oferta.psd`;
  return `${cleanFolder}\\${fileName}`;
}

function readLocalScantechCampaigns(): ScantechCampaign[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScantechCampaign[]) : [];
  } catch {
    return [];
  }
}

function writeLocalScantechCampaigns(campaigns: ScantechCampaign[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(campaigns));
  } catch {
    // Ignore storage quota errors in tests
  }
}

export async function listScantechCampaigns(): Promise<{ campaigns: ScantechCampaign[]; errors: string[] }> {
  if (!isTauri()) {
    return { campaigns: readLocalScantechCampaigns(), errors: [] };
  }
  const response = await invoke<{ campaigns: ScantechCampaign[]; errors: string[] }>('scantech_campaigns', {
    request: { action: 'list' },
  });
  return response;
}

export async function saveScantechCampaign(campaign: ScantechCampaign): Promise<ScantechCampaign> {
  if (!isTauri()) {
    const all = readLocalScantechCampaigns();
    const idx = all.findIndex(c => c.id === campaign.id);
    if (idx >= 0) all[idx] = campaign;
    else all.unshift(campaign);
    writeLocalScantechCampaigns(all);
    return campaign;
  }
  return await invoke<ScantechCampaign>('scantech_campaigns', {
    request: {
      action: 'save',
      content: JSON.stringify(campaign),
    },
  });
}

export async function detectPhotoshop(): Promise<PhotoshopStatus> {
  if (!isTauri()) {
    return {
      available: false,
      exePath: null,
      version: null,
      productName: null,
      automationMode: 'navegador',
      details: 'Abra o aplicativo desktop no Windows para usar a automação com Adobe Photoshop.',
    };
  }
  return await invoke<PhotoshopStatus>('detect_photoshop');
}

export async function chooseScantechPsdFolder(): Promise<string | null> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para selecionar uma pasta.');
  return await invoke<string | null>('choose_scantech_psd_folder');
}

export async function chooseScantechExportFolder(): Promise<string | null> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para selecionar a pasta de exportação.');
  return await invoke<string | null>('choose_scantech_export_folder');
}

export async function scanScantechPsdFolder(folderPath: string): Promise<ScannedPsdEntry[]> {
  if (!isTauri()) return [];
  return await invoke<ScannedPsdEntry[]>('scan_scantech_psd_folder', { folderPath });
}

export async function exportScantechPsds(jobs: ScantechExportJob[]): Promise<ScantechExportBatchResult> {
  if (!isTauri()) {
    throw new Error('Abra o aplicativo desktop no Windows para exportar arquivos PSD pelo Photoshop.');
  }
  return await invoke<ScantechExportBatchResult>('export_scantech_psds', {
    request: { jobs },
  });
}

