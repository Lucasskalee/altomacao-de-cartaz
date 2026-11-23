import { invoke, isTauri } from '@tauri-apps/api/core';
import { findCartazesByF7, getF7, type IndexedCartaz } from '../cartazes/f7';
import type { Cartaz, PaperFormat } from '../cartazes/types';
import { formatCentsBr, posterFromDocument } from '../cartazes/presentation';
import { priceToCents } from '../cartazes/validation';
import { sanitizePrice, type Poster } from '../../components/editor/PosterView';
import { hasInvertedPsdPriceParts, importedPriceWarning } from '../../components/editor/importedRenderer';
import type { ScannedPsdEntry } from '../scantech/types';
import type { ColumnMapping, ExcelExtractionResult } from './excel';
import type {
  CampaignItem,
  CampaignItemPsdSuggestion,
  CampaignMatchView,
  CampaignPosterState,
  OfferCampaign,
  PrintStatus,
  PsdBatchConfirmationItem,
  PsdBatchConfirmationSummary,
  PsdBatchLinkError,
  PsdBatchLinkResult,
  PsdCandidateMatch,
  PsdPairingSelection,
} from './types';

const normalizedPath = (path: string) => path.replace(/\//g, '\\').toLocaleLowerCase('en-US');

function cartazContentKey(document: Cartaz): string {
  const content = structuredClone(document);
  content.id = '';
  content.metadata.createdAt = '';
  content.metadata.updatedAt = '';
  if (content.layout.template === 'imported-psd') {
    const artwork = content.layout.artwork;
    const roles = new Set(artwork.templateParts?.map(part => part.role) ?? []);
    if (!roles.has('title')) content.product.name = '';
    if (!roles.has('complement')) content.product.complement = '';
    if (!roles.has('packaging')) content.product.unit = '';
    if (!roles.has('category')) delete content.product.category;
    if (artwork.priceParts.some(part => part.role === 'validity')) {
      content.product.validityText = posterFromDocument(document).validityText;
    } else {
      delete content.product.validityText;
    }
    content.layout.artwork.source = {
      ...artwork.source,
      fileName: '',
      sourcePath: null,
    };
  }
  return JSON.stringify(content, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  );
}

function uniquePosterStates(posters: CampaignPosterState[]): CampaignPosterState[] {
  const seen = new Set<string>();
  return posters.filter(poster => {
    const key = poster.cartazPath.trim()
      ? normalizedPath(poster.cartazPath)
      : `id:${poster.cartazId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createCampaign(name: string, campaignDate: string): OfferCampaign {
  const cleanName = name.trim();
  const cleanDate = campaignDate.trim();
  if (!cleanName) throw new Error('Informe o nome da pasta de ofertas.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('Informe uma data válida para a campanha (AAAA-MM-DD).');
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: cleanName.slice(0, 80),
    campaignDate: cleanDate,
    archived: false,
    sourceExcel: null,
    items: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function renameCampaign(campaign: OfferCampaign, newName: string, newDate?: string): OfferCampaign {
  const cleanName = newName.trim();
  if (!cleanName) throw new Error('Informe o novo nome da pasta de ofertas.');
  const cleanDate = (newDate ?? campaign.campaignDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('Informe uma data válida para a campanha (AAAA-MM-DD).');
  return {
    ...campaign,
    name: cleanName.slice(0, 80),
    campaignDate: cleanDate,
    updatedAt: new Date().toISOString(),
  };
}

export function archiveCampaign(campaign: OfferCampaign, archived = true): OfferCampaign {
  return {
    ...campaign,
    archived,
    updatedAt: new Date().toISOString(),
  };
}

export function duplicateCampaign(campaign: OfferCampaign, customName?: string): OfferCampaign {
  const now = new Date().toISOString();
  const copy: OfferCampaign = structuredClone(campaign);
  copy.id = crypto.randomUUID();
  copy.name = (customName?.trim() || `${campaign.name} (Cópia)`).slice(0, 80);
  copy.archived = false;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.items = copy.items.map(item => ({
    ...item,
    id: crypto.randomUUID(),
    posters: item.posters.map(poster => ({
      ...poster,
      status: poster.selected ? 'preparado' : 'pendente',
      printedAt: null,
    })),
  }));
  return copy;
}

export function applyExcelToCampaign(
  campaign: OfferCampaign,
  extraction: ExcelExtractionResult,
  library: IndexedCartaz[],
  sourceMeta: { fileName: string; sheetName: string; headerRowIndex: number; mapping: ColumnMapping }
): OfferCampaign {
  const validRows = extraction.items.filter(item => item.f7 && item.priceCents !== null && item.issues.length === 0);
  if (validRows.length === 0) {
    throw new Error('Nenhum item válido sem conflitos encontrado para importar na pasta de ofertas.');
  }
  const seenByF7 = new Map<string, CampaignItem>();
  for (const row of validRows) {
    const f7 = row.f7!;
    if (seenByF7.has(f7)) continue;
    const matches = findCartazesByF7(f7, library);
    const existingItem = campaign.items.find(existing => existing.f7 === f7);
    const posters: CampaignPosterState[] = matches.map(match => {
      const prev = existingItem?.posters.find(p => normalizedPath(p.cartazPath) === normalizedPath(match.path));
      return {
        cartazId: match.document.id,
        cartazPath: match.path,
        selected: prev ? prev.selected : true,
        copies: prev ? prev.copies : 1,
        status: prev ? prev.status : 'preparado',
        printedAt: prev?.printedAt ?? null,
      };
    });
    seenByF7.set(f7, {
      id: existingItem?.id ?? crypto.randomUUID(),
      rowNumber: row.rowNumber,
      f7,
      description: row.description.slice(0, 120),
      scheduledPriceCents: row.priceCents!,
      conflicting: false,
      issues: [],
      posters,
    });
  }
  const now = new Date().toISOString();
  return {
    ...campaign,
    sourceExcel: {
      ...sourceMeta,
      importedAt: now,
    },
    items: [...seenByF7.values()],
    updatedAt: now,
  };
}

export function syncCampaignWithLibrary(campaign: OfferCampaign, library: IndexedCartaz[]): OfferCampaign {
  let changed = false;
  const items = campaign.items.map(item => {
    const matches = findCartazesByF7(item.f7, library);
    const nextPosters = uniquePosterStates(item.posters);
    let itemChanged = nextPosters.length !== item.posters.length;
    if (itemChanged) changed = true;
    for (const match of matches) {
      const exists = nextPosters.some(p => normalizedPath(p.cartazPath) === normalizedPath(match.path));
      if (!exists) {
        changed = true;
        itemChanged = true;
        nextPosters.push({
          cartazId: match.document.id,
          cartazPath: match.path,
          selected: true,
          copies: 1,
          status: 'preparado',
          printedAt: null,
        });
      }
    }
    return itemChanged ? { ...item, posters: nextPosters } : item;
  });
  return changed ? { ...campaign, items, updatedAt: new Date().toISOString() } : campaign;
}

export function suggestFromExcelDescription(description: string): {
  name: string;
  complement: string;
  unit: string;
} {
  const cleaned = description
    .trim()
    .toUpperCase()
    .replace(/^[A-Z]{2,5}\.\s*/, '');

  const volumeMatch = cleaned.match(/\b(\d+(?:[.,]\d+)?\s*(?:ML|L|KG|G|GR|PCT|CX|LT|DZ))\b/i);
  const detectedVolume = volumeMatch ? volumeMatch[1].replace(/\s+/g, '').toUpperCase() : '';

  // Se já contém hífen no texto, usa o hífen como separador de especificação
  if (cleaned.includes('-')) {
    const parts = cleaned.split('-').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const name = parts[0].slice(0, 32);
      const complement = parts.slice(1).join(' - ').slice(0, 60);
      const unit = detectedVolume || 'UN';
      return { name, complement, unit };
    }
  }

  const unitRegex = /\b(KG|UN|PCT|CX|LT|BDJ|MACO|MAÇO|DZ|GR|G|ML)\b/i;
  const unitMatch = cleaned.match(unitRegex);
  const unit = detectedVolume || (unitMatch ? unitMatch[1].toUpperCase() : 'UN');
  const withoutUnit = cleaned
    .replace(unitRegex, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = withoutUnit.split(' ').filter(Boolean);
  const name = (tokens[0] ?? cleaned).slice(0, 32);
  let complement = tokens.slice(1).join(' ').slice(0, 50);

  // Formata especificação com hífen se houver volume/gramagem explícito
  if (detectedVolume && complement && !complement.includes(detectedVolume)) {
    complement = `${complement} - ${detectedVolume}`;
  }

  return { name, complement, unit };
}

export function linkSavedPosterToCampaignItem(
  campaign: OfferCampaign,
  offerItemId: string,
  cartazPath: string,
  cartazDocument: Cartaz,
  replaceExisting = false
): OfferCampaign {
  if (!cartazPath.trim()) throw new Error('Caminho do cartaz salvo inválido.');
  const targetNorm = normalizedPath(cartazPath);
  const now = new Date().toISOString();
  let foundItem = false;

  const items = campaign.items.map(item => {
    const isTargetItem = item.id === offerItemId;
    const isSameF7 =
      Boolean(cartazDocument.product.productCode) &&
      cartazDocument.product.productCode === item.f7;
    if (!isTargetItem && !isSameF7) return item;
    if (isTargetItem) foundItem = true;

    const posters = uniquePosterStates(item.posters);
    const existingIdx = posters.findIndex(
      p => normalizedPath(p.cartazPath) === targetNorm || p.cartazId === cartazDocument.id
    );
    const nextEntry: CampaignPosterState = {
      cartazId: cartazDocument.id,
      cartazPath,
      selected: true,
      copies: existingIdx >= 0 ? posters[existingIdx].copies : 1,
      status: 'preparado',
      printedAt: null,
    };
    const nextPosters = replaceExisting
      ? [nextEntry]
      : existingIdx >= 0
        ? posters.map((p, idx) => (idx === existingIdx ? nextEntry : p))
        : [...posters, nextEntry];

    return {
      ...item,
      posters: nextPosters,
    };
  });

  if (!foundItem) {
    throw new Error('Item da pasta de ofertas não encontrado para vincular o cartaz PSD.');
  }

  return {
    ...campaign,
    items,
    updatedAt: now,
  };
}

export function unlinkPosterFromCampaignItem(
  campaign: OfferCampaign,
  offerItemId: string,
  cartazPath?: string
): OfferCampaign {
  const now = new Date().toISOString();
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.map(item => {
      if (item.id !== offerItemId) return item;
      const targetNorm = cartazPath ? normalizedPath(cartazPath) : null;
      const nextPosters = targetNorm
        ? item.posters.filter(p => normalizedPath(p.cartazPath) !== targetNorm)
        : [];
      return {
        ...item,
        posters: nextPosters,
      };
    }),
  };
}

export function removeCampaignItem(
  campaign: OfferCampaign,
  itemId: string
): OfferCampaign {
  const now = new Date().toISOString();
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.filter(item => item.id !== itemId),
  };
}

export function updateCampaignItemDescription(
  campaign: OfferCampaign,
  itemId: string,
  newDescription: string
): OfferCampaign {
  const trimmed = newDescription.trim();
  if (!trimmed) throw new Error('A descrição do produto não pode ficar vazia.');
  const now = new Date().toISOString();
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.map(item =>
      item.id !== itemId
        ? item
        : {
            ...item,
            description: trimmed,
          }
    ),
  };
}

export function updateScheduledPrice(campaign: OfferCampaign, itemId: string, newPriceCents: number): OfferCampaign {
  if (!Number.isSafeInteger(newPriceCents) || newPriceCents <= 0 || newPriceCents > 99_999_999) {
    throw new Error('Preço programado inválido.');
  }
  const now = new Date().toISOString();
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.map(item =>
      item.id !== itemId
        ? item
        : {
            ...item,
            scheduledPriceCents: newPriceCents,
            posters: item.posters.map(p => ({
              ...p,
              status: p.selected ? 'preparado' : 'pendente',
              printedAt: null,
            })),
          }
    ),
  };
}

export function updatePosterSelection(
  campaign: OfferCampaign,
  itemId: string,
  cartazPath: string,
  updates: { selected?: boolean; copies?: number; status?: PrintStatus }
): OfferCampaign {
  const now = new Date().toISOString();
  const targetNorm = normalizedPath(cartazPath);
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.map(item => {
      if (item.id !== itemId) return item;
      return {
        ...item,
        posters: item.posters.map(p => {
          if (normalizedPath(p.cartazPath) !== targetNorm) return p;
          const selected = updates.selected ?? p.selected;
          const copies = updates.copies !== undefined ? Math.max(1, Math.min(999, Math.trunc(updates.copies) || 1)) : p.copies;
          let status: PrintStatus = updates.status ?? p.status;
          if (updates.selected !== undefined && updates.status === undefined) {
            if (!selected && status !== 'impresso') status = 'pendente';
            else if (selected && status === 'pendente') status = 'preparado';
          }
          return {
            ...p,
            selected,
            copies,
            status,
            printedAt: status === 'impresso' ? (p.printedAt ?? now) : null,
          };
        }),
      };
    }),
  };
}

export function updateAllPostersSelection(
  campaign: OfferCampaign,
  selected: boolean,
  targetItemIds?: Set<string>
): OfferCampaign {
  const now = new Date().toISOString();
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.map(item => {
      if (targetItemIds && !targetItemIds.has(item.id)) return item;
      return {
        ...item,
        posters: item.posters.map(p => {
          let status: PrintStatus = p.status;
          if (p.selected !== selected) {
            if (!selected && status !== 'impresso') status = 'pendente';
            else if (selected && status === 'pendente') status = 'preparado';
          }
          return {
            ...p,
            selected,
            status,
          };
        }),
      };
    }),
  };
}

export function confirmBatchPrinted(campaign: OfferCampaign, printedKeys: Set<string>): OfferCampaign {
  const now = new Date().toISOString();
  return {
    ...campaign,
    updatedAt: now,
    items: campaign.items.map(item => ({
      ...item,
      posters: item.posters.map(p => {
        const key = `${item.id}::${normalizedPath(p.cartazPath)}`;
        if (!printedKeys.has(key)) return p;
        return {
          ...p,
          status: 'impresso',
          printedAt: now,
        };
      }),
    })),
  };
}

export function formatCampaignDateToValidity(campaignDate: string, posterModel?: string): string {
  if (!campaignDate) return '';
  const parts = campaignDate.split('-');
  if (parts.length === 3) {
    const day = parts[2];
    const month = parts[1];
    const year = parts[0];
    if (posterModel === 'vencimento') {
      return `${day}/${month}`;
    }
    return `OFERTA VÁLIDA ATÉ ${day}/${month}/${year}`;
  }
  return campaignDate;
}

/** Projects the library Cartaz with the scheduled price WITHOUT mutating the library document. */
export function buildScheduledDocument(
  libraryDocument: Cartaz,
  scheduledPriceCents: number,
  scheduledValidityText?: string
): Cartaz {
  const clone = structuredClone(libraryDocument);
  clone.product = {
    ...clone.product,
    priceCents: scheduledPriceCents,
    ...(scheduledValidityText ? { validityText: scheduledValidityText } : {}),
  };
  return clone;
}

export function buildScheduledPoster(
  libraryDocument: Cartaz,
  scheduledPriceCents: number,
  scheduledValidityText?: string
): Poster {
  return posterFromDocument(buildScheduledDocument(libraryDocument, scheduledPriceCents, scheduledValidityText));
}

export function inspectScheduledPriceApplication(
  libraryDocument: Cartaz,
  scheduledPriceCents: number,
  scheduledValidityText?: string
): {
  scheduledDocument: Cartaz;
  appliedPriceCents: number | null;
  hasInvertedLayers: boolean;
  priceMismatchReason: string | null;
} {
  const scheduledDocument = buildScheduledDocument(libraryDocument, scheduledPriceCents, scheduledValidityText);
  if (!Number.isSafeInteger(scheduledPriceCents) || scheduledPriceCents <= 0 || scheduledPriceCents > 99_999_999) {
    return {
      scheduledDocument,
      appliedPriceCents: null,
      hasInvertedLayers: false,
      priceMismatchReason: 'Preço programado inválido fora do intervalo permitido.',
    };
  }

  const poster = posterFromDocument(scheduledDocument);
  const { whole, fraction } = sanitizePrice(poster.price);
  let appliedPriceCents: number | null = null;
  try {
    appliedPriceCents = priceToCents(`${whole},${fraction}`);
  } catch {
    appliedPriceCents = null;
  }

  let hasInvertedLayers = false;
  if (scheduledDocument.layout.template === 'imported-psd') {
    const artwork = scheduledDocument.layout.artwork;
    hasInvertedLayers = hasInvertedPsdPriceParts(artwork);
    if (hasInvertedLayers) {
      const invertedCents = Number(fraction) * 100 + Number(whole.padEnd(2, '0').slice(0, 2));
      return {
        scheduledDocument,
        appliedPriceCents: Number.isSafeInteger(invertedCents) ? invertedCents : appliedPriceCents,
        hasInvertedLayers: true,
        priceMismatchReason: `Divergência de camadas no cartaz PSD: Reais e Centavos estão invertidos (programado R$ ${formatCentsBr(scheduledPriceCents)} → seria exibido R$ ${fraction},${whole}). Corrija o mapeamento antes de imprimir.`,
      };
    }
    const warning = importedPriceWarning(artwork, poster.price);
    if (warning) {
      return {
        scheduledDocument,
        appliedPriceCents,
        hasInvertedLayers: false,
        priceMismatchReason: warning,
      };
    }
  }

  if (appliedPriceCents !== scheduledPriceCents) {
    return {
      scheduledDocument,
      appliedPriceCents,
      hasInvertedLayers,
      priceMismatchReason: `Preço aplicado no cartaz (${appliedPriceCents !== null ? 'R$ ' + formatCentsBr(appliedPriceCents) : 'inválido'}) diverge do preço programado (R$ ${formatCentsBr(scheduledPriceCents)}).`,
    };
  }

  return {
    scheduledDocument,
    appliedPriceCents,
    hasInvertedLayers: false,
    priceMismatchReason: null,
  };
}

export function buildCampaignMatchViews(campaign: OfferCampaign, library: IndexedCartaz[]): CampaignMatchView[] {
  const byPath = new Map<string, IndexedCartaz>();
  for (const item of library) {
    byPath.set(normalizedPath(item.path), item);
  }
  return campaign.items.map(item => {
    const matchingCartazes = findCartazesByF7(item.f7, library);
    const seenLibraryContent = new Set<string>();
    const allF7Matches = matchingCartazes.filter(match => {
      const key = cartazContentKey(match.document);
      if (seenLibraryContent.has(key)) return false;
      seenLibraryContent.add(key);
      return true;
    });
    const posters = uniquePosterStates(item.posters);
    const linkedPaths = new Set(posters.map(p => normalizedPath(p.cartazPath)));
    const linkedContent = new Set<string>();
    const matchedPosters = posters.flatMap(state => {
      let lib = byPath.get(normalizedPath(state.cartazPath)) ?? matchingCartazes.find(m => m.document.id === state.cartazId) ?? null;
      if (!lib && matchingCartazes.length > 0) {
        // Auto-cura de vínculos: se o arquivo .psd ou caminho original não foi encontrado como .skcartaz no byPath,
        // mas a biblioteca possui um cartaz com o mesmo F7 do item ou mesmo nome:
        const cleanBase = state.cartazPath.split(/[\\/]/).pop()?.replace(/\.(?:psd|skcartaz)$/i, '').toLowerCase();
        lib = matchingCartazes.find(m => {
          const mBase = m.path.split(/[\\/]/).pop()?.replace(/\.(?:psd|skcartaz)$/i, '').toLowerCase();
          return mBase === cleanBase || (cleanBase && mBase?.includes(cleanBase)) || (mBase && cleanBase?.includes(mBase));
        }) ?? (matchingCartazes.length === 1 ? matchingCartazes[0] : null);
      }
      if (lib) {
        const key = cartazContentKey(lib.document);
        if (linkedContent.has(key)) return [];
        linkedContent.add(key);
      }
      const posterModel = lib?.document.layout.template === 'imported-psd' ? lib.document.layout.artwork.posterModel : undefined;
      const campaignValidity = formatCampaignDateToValidity(campaign.campaignDate, posterModel);
      const inspection = lib ? inspectScheduledPriceApplication(lib.document, item.scheduledPriceCents, campaignValidity) : null;
      return [{
        state,
        libraryCartaz: lib,
        currentPriceCents: lib ? lib.document.product.priceCents : null,
        scheduledDocument: inspection ? inspection.scheduledDocument : null,
        appliedPriceCents: inspection ? inspection.appliedPriceCents : null,
        hasInvertedLayers: inspection ? inspection.hasInvertedLayers : false,
        priceMismatchReason: inspection ? inspection.priceMismatchReason : null,
      }];
    });
    const unlinkedLibraryPosters = allF7Matches.filter(
      m => !linkedPaths.has(normalizedPath(m.path)) && !linkedContent.has(cartazContentKey(m.document))
    );
    return {
      item,
      matchedPosters,
      unlinkedLibraryPosters,
      hasConflict: item.conflicting,
      missingPoster: matchedPosters.every(m => !m.libraryCartaz) && unlinkedLibraryPosters.length === 0,
    };
  });
}

export async function selectExcel(): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para selecionar uma planilha Excel local.');
  const file = await invoke<{ name: string; path: string } | null>('choose_excel');
  if (!file) return null;
  const buffer = await invoke<ArrayBuffer>('read_excel', { path: file.path });
  return { name: file.name, buffer };
}

export async function listCampaigns(): Promise<{ campaigns: OfferCampaign[]; errors: string[] }> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para acessar as pastas de ofertas.');
  return invoke<{ campaigns: OfferCampaign[]; errors: string[] }>('offer_campaigns', { request: { action: 'list' } });
}

export async function saveCampaign(campaign: OfferCampaign): Promise<OfferCampaign> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para salvar a pasta de ofertas.');
  return invoke<OfferCampaign>('offer_campaigns', {
    request: { action: 'save', content: JSON.stringify(campaign, null, 2) },
  });
}

export async function deleteCampaign(id: string): Promise<boolean> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para excluir a pasta de ofertas.');
  return invoke<boolean>('offer_campaigns', { request: { action: 'delete', id } });
}

const PSD_COMMON_STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'com',
  'sem',
  'para',
  'por',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'ao',
  'aos',
  'um',
  'uma',
  'uns',
  'umas',
  'e',
  'ou',
  'un',
  'und',
  'unid',
  'unidade',
  'kg',
  'quilo',
  'g',
  'gr',
  'gramas',
  'mg',
  'lt',
  'l',
  'litro',
  'litros',
  'ml',
  'pct',
  'pacote',
  'cx',
  'caixa',
  'sc',
  'saco',
  'fd',
  'fardo',
  'bdj',
  'bandeja',
  'dz',
  'duzia',
  'maco',
  'flv',
  'mer',
  'beb',
  'limp',
  'pad',
  'horti',
  'oferta',
  'ofertas',
  'promocao',
  'cartaz',
  'arte',
  'psd',
  'a3',
  'a4',
  'a5',
  'a6',
  'tipo',
]);

export function normalizePsdComparisonText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.psd$/i, '')
    .replace(/^[a-z]{2,5}\.\s*/, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function extractMeaningfulDescriptionTokens(text: string): string[] {
  const norm = normalizePsdComparisonText(text);
  if (!norm) return [];
  const rawTokens = norm.split(/\s+/).filter(Boolean);
  const result: string[] = [];
  for (const token of rawTokens) {
    if (token.length < 2) continue;
    if (PSD_COMMON_STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/^\d+(?:[.,]\d+)?(?:kg|g|gr|mg|ml|l|lt|un|und|pct|cx)$/i.test(token)) continue;
    if (!result.includes(token)) {
      result.push(token);
    }
  }
  return result;
}

function extractMeasureTokens(text: string): string[] {
  const norm = normalizePsdComparisonText(text);
  if (!norm) return [];
  return norm
    .split(/\s+/)
    .filter(token => /^\d+(?:kg|g|gr|mg|ml|l|lt)$/i.test(token));
}

export function matchesExactF7InFilename(f7: string, psdFileName: string): boolean {
  const cleanF7 = f7.trim();
  if (!cleanF7 || !/^\d+$/.test(cleanF7)) return false;
  const withoutExt = psdFileName
    .replace(/\.psd$/i, '')
    .replace(/\bf7[-_\s]*(?=\d)/gi, ' ')
    .replace(/\ba[3456]\b/gi, ' ');
  const tokens: string[] = [];
  const regex = /(?:^|[^a-z0-9])(\d+)(?!\s*(?:kg|g|gr|mg|ml|l|lt)\b)(?=$|[^a-z0-9])/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(withoutExt)) !== null) {
    tokens.push(match[1]);
  }
  return tokens.includes(cleanF7);
}

export function buildCampaignPsdSuggestions(
  campaign: OfferCampaign,
  scannedPsds: ScannedPsdEntry[]
): CampaignItemPsdSuggestion[] {
  const allCampaignF7s = new Set(campaign.items.map(i => i.f7.trim()).filter(Boolean));

  const preliminary = campaign.items.map(item => {
    const alreadyLinked = item.posters.length > 0;
    const cleanF7 = item.f7.trim();

    // 1. Prioriza correspondência exata de F7 encontrado no nome do arquivo
    const exactF7Psds = cleanF7
      ? scannedPsds.filter(psd => matchesExactF7InFilename(cleanF7, psd.name))
      : [];

    if (exactF7Psds.length > 0) {
      const candidates: PsdCandidateMatch[] = exactF7Psds.map(psd => ({
        psd,
        reason: 'f7-exact',
        score: 1.0,
        matchedTerms: [cleanF7],
      }));
      return {
        item,
        reason: 'f7-exact' as const,
        candidates,
        alreadyLinked,
      };
    }

    // 2. Se não houver F7, sugere por similaridade entre descrição do Excel e nome do arquivo
    const descTokens = extractMeaningfulDescriptionTokens(item.description);
    const descMeasures = extractMeasureTokens(item.description);
    const descCandidates: PsdCandidateMatch[] = [];

    if (descTokens.length > 0) {
      for (const psd of scannedPsds) {
        // Se o PSD contém explicitamente o F7 exato de outro produto da campanha, não o sugere por descrição
        const hasOtherCampaignF7 = [...allCampaignF7s].some(
          otherF7 => otherF7 !== cleanF7 && matchesExactF7InFilename(otherF7, psd.name)
        );
        if (hasOtherCampaignF7) continue;

        const psdTokens = extractMeaningfulDescriptionTokens(psd.name);
        if (psdTokens.length === 0) continue;
        const psdMeasures = extractMeasureTokens(psd.name);

        // Se o produto especifica medida (ex: 5kg) e o PSD especifica medida diferente da mesma grandeza (ex: 1kg), penaliza/evita
        const matchedCore = descTokens.filter(dt =>
          psdTokens.some(
            pt => pt === dt || (dt.length >= 4 && pt.startsWith(dt)) || (pt.length >= 4 && dt.startsWith(pt))
          )
        );
        if (matchedCore.length === 0) continue;

        const matchedMeasures = descMeasures.filter(dm => psdMeasures.includes(dm));
        const descCoverage = matchedCore.length / descTokens.length;
        const psdPrecision = matchedCore.length / psdTokens.length;

        const qualifies =
          descTokens.length === 1
            ? matchedCore.length === 1
            : (matchedCore.length >= 2 && descCoverage >= 0.4) ||
              (matchedCore.length >= 1 && descCoverage >= 0.5 && psdPrecision >= 0.5);

        if (qualifies) {
          const score =
            descCoverage * 0.8 +
            psdPrecision * 0.15 +
            (matchedMeasures.length > 0 ? 0.05 : 0);
          descCandidates.push({
            psd,
            reason: 'description-similar',
            score: Math.min(0.99, Number(score.toFixed(4))),
            matchedTerms: [...matchedCore, ...matchedMeasures],
          });
        }
      }
    }

    descCandidates.sort((a, b) => b.score - a.score || a.psd.name.localeCompare(b.psd.name, 'pt-BR'));

    if (descCandidates.length > 0) {
      return {
        item,
        reason: 'description-similar' as const,
        candidates: descCandidates,
        alreadyLinked,
      };
    }

    return {
      item,
      reason: 'no-suggestion' as const,
      candidates: [] as PsdCandidateMatch[],
      alreadyLinked,
    };
  });

  // Detecta se um mesmo PSD é o candidato único/principal de múltiplos produtos diferentes na campanha
  const topPsdCount = new Map<string, number>();
  for (const entry of preliminary) {
    if (entry.candidates.length > 0) {
      const topPath = normalizedPath(entry.candidates[0].psd.path);
      topPsdCount.set(topPath, (topPsdCount.get(topPath) ?? 0) + 1);
    }
  }

  return preliminary.map(entry => {
    const { item, reason, candidates, alreadyLinked } = entry;
    let ambiguous = false;
    let ambiguityReason: string | null = null;

    if (candidates.length > 1) {
      ambiguous = true;
      ambiguityReason =
        reason === 'f7-exact'
          ? `Mais de um arquivo PSD (${candidates.length}) encontrado para o F7 ${item.f7}. Escolha manualmente.`
          : `Múltiplos arquivos PSD candidatos (${candidates.length}) por descrição parecida. Escolha manualmente.`;
    } else if (candidates.length === 1) {
      const topPath = normalizedPath(candidates[0].psd.path);
      if ((topPsdCount.get(topPath) ?? 0) > 1) {
        ambiguous = true;
        ambiguityReason = `O arquivo "${candidates[0].psd.name}" é sugerido para mais de um produto da campanha. Revise manualmente.`;
      }
    }

    const reasonLabel =
      reason === 'f7-exact'
        ? 'F7 exato'
        : reason === 'description-similar'
          ? 'Descrição parecida'
          : 'Sem sugestão';

    const recommendedPsd = !ambiguous && candidates.length === 1 ? candidates[0].psd : null;
    const autoSelectForBatch =
      reason === 'f7-exact' && !ambiguous && candidates.length === 1 && !alreadyLinked;

    return {
      item,
      reason,
      reasonLabel,
      candidates,
      recommendedPsd,
      ambiguous,
      ambiguityReason,
      autoSelectForBatch,
      alreadyLinked,
    };
  });
}

export function getDefaultSelectionForSuggestion(
  suggestion: CampaignItemPsdSuggestion
): PsdPairingSelection {
  if (suggestion.alreadyLinked) {
    return {
      psdPath: '',
      includedInBatch: false,
      reviewedByUser: false,
    };
  }
  if (suggestion.reason === 'f7-exact' && !suggestion.ambiguous && suggestion.recommendedPsd) {
    return {
      psdPath: suggestion.recommendedPsd.path,
      includedInBatch: true,
      reviewedByUser: false,
    };
  }
  if (suggestion.reason === 'description-similar' && !suggestion.ambiguous && suggestion.recommendedPsd) {
    return {
      psdPath: suggestion.recommendedPsd.path,
      includedInBatch: false,
      reviewedByUser: false,
    };
  }
  return {
    psdPath: '',
    includedInBatch: false,
    reviewedByUser: false,
  };
}

export function buildInitialPsdPairingSelections(
  suggestions: CampaignItemPsdSuggestion[]
): Record<string, PsdPairingSelection> {
  const result: Record<string, PsdPairingSelection> = {};
  for (const s of suggestions) {
    result[s.item.id] = getDefaultSelectionForSuggestion(s);
  }
  return result;
}

export function buildPsdBatchConfirmationSummary(
  suggestions: CampaignItemPsdSuggestion[],
  selections: Record<string, PsdPairingSelection>,
  scannedPsds: ScannedPsdEntry[]
): PsdBatchConfirmationSummary {
  const psdByPath = new Map<string, ScannedPsdEntry>();
  for (const p of scannedPsds) {
    psdByPath.set(p.path, p);
    psdByPath.set(normalizedPath(p.path), p);
  }

  const toLink: PsdBatchConfirmationItem[] = [];
  let exactF7Count = 0;
  let reviewedManualOrDescriptionCount = 0;
  let skippedAmbiguousOrUnreviewedCount = 0;
  let skippedNoSuggestionCount = 0;
  let alreadyLinkedCount = 0;

  for (const s of suggestions) {
    if (s.alreadyLinked) {
      alreadyLinkedCount++;
    }
    const sel = selections[s.item.id] ?? getDefaultSelectionForSuggestion(s);
    const chosenPsd = sel.psdPath
      ? (psdByPath.get(sel.psdPath) ?? psdByPath.get(normalizedPath(sel.psdPath)) ?? null)
      : null;

    const isReliableExactF7 =
      s.reason === 'f7-exact' && !s.ambiguous && s.candidates.length === 1 && !s.alreadyLinked;

    // Nunca vincula silenciosamente sugestões baseadas apenas em descrição ou ambíguas sem revisão explícita
    const allowedInBatch =
      sel.includedInBatch &&
      chosenPsd !== null &&
      (isReliableExactF7 || sel.reviewedByUser);

    if (allowedInBatch && chosenPsd) {
      const matchedCandidate = s.candidates.find(
        c => normalizedPath(c.psd.path) === normalizedPath(chosenPsd.path)
      );
      const effectiveReason = matchedCandidate ? matchedCandidate.reason : s.reason;
      const effectiveLabel =
        effectiveReason === 'f7-exact'
          ? s.ambiguous
            ? 'F7 exato (escolhido manualmente)'
            : 'F7 exato'
          : matchedCandidate?.reason === 'description-similar'
            ? 'Descrição parecida (revisado)'
            : 'Escolha manual';

      toLink.push({
        item: s.item,
        psd: chosenPsd,
        reason: effectiveReason,
        reasonLabel: effectiveLabel,
        reviewedByUser: sel.reviewedByUser,
      });

      if (effectiveReason === 'f7-exact' && !s.ambiguous && !sel.reviewedByUser) {
        exactF7Count++;
      } else {
        reviewedManualOrDescriptionCount++;
      }
    } else if (!s.alreadyLinked) {
      if (s.ambiguous || s.reason === 'description-similar') {
        skippedAmbiguousOrUnreviewedCount++;
      } else if (s.reason === 'no-suggestion') {
        skippedNoSuggestionCount++;
      }
    }
  }

  return {
    toLink,
    exactF7Count,
    reviewedManualOrDescriptionCount,
    skippedAmbiguousOrUnreviewedCount,
    skippedNoSuggestionCount,
    alreadyLinkedCount,
  };
}

/**
 * Converte o nome de um arquivo PSD para o nome do arquivo .skcartaz correspondente.
 * Regras estritas:
 * 1. Usa o nome completo do PSD de origem, trocando somente a extensão final (.psd -> .skcartaz).
 *    Exemplo: "biscoito-gude-recheado-112g-chocolate.psd" -> "biscoito-gude-recheado-112g-chocolate.skcartaz"
 * 2. Preserva letras maiúsculas/minúsculas, acentos, números, espaços, hífens, sublinhados, parênteses e colchetes.
 * 3. Não gera o nome a partir da descrição do Excel.
 * 4. Não adiciona automaticamente o F7 antes do nome.
 * 5. Não remove o início alfabético.
 * 6. Se o nome já possuir indicação do formato (ex.: [A6], [A5], A6), evita duplicar essa informação.
 */
export function psdFileNameToCartazFileName(psdFileNameOrPath: string, paperSize?: string): string {
  const rawBase = psdFileNameOrPath.split(/[\\/]/).pop() || psdFileNameOrPath;
  const withoutExt = rawBase.replace(/\.psd$/i, '').trim();
  // Sanitiza apenas caracteres estritamente proibidos em caminhos do Windows / sistemas de arquivos
  const sanitized = withoutExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
  const safeName = sanitized || 'cartaz';

  if (paperSize && paperSize.trim()) {
    const cleanPaper = paperSize.trim();
    const formatRegex = new RegExp(`(?:\\[|\\(|\\b)${cleanPaper}(?:\\]|\\)|\\b)`, 'i');
    if (!formatRegex.test(safeName)) {
      // O nome original não contém o formato: preserva exatamente o nome do PSD puro sem inventar tags
    }
  }

  return `${safeName}.skcartaz`;
}

/**
 * Constrói o caminho completo de destino para o arquivo .skcartaz a partir do PSD de origem.
 */
export function buildCartazPathFromPsd(
  libraryRoot: string,
  psdFileNameOrPath: string,
  paperSize?: string
): string {
  const rootDir = libraryRoot.trim().replace(/[\\/]+$/, '');
  const fileName = psdFileNameToCartazFileName(psdFileNameOrPath, paperSize);
  return rootDir ? `${rootDir}\\${fileName}` : fileName;
}

export function buildOfferPsdCartazTargetPath(
  libraryRoot: string,
  f7: string,
  description: string,
  paperSize: PaperFormat,
  psdFileNameOrPath?: string
): string {
  if (psdFileNameOrPath && psdFileNameOrPath.trim()) {
    return buildCartazPathFromPsd(libraryRoot, psdFileNameOrPath, paperSize);
  }
  const rootDir = libraryRoot.trim().replace(/[\\/]+$/, '');
  const baseSlug = (description || 'cartaz')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const cleanF7 = f7.trim() ? `${f7.trim()} - ` : '';
  const sizeTag = ` [${paperSize}]`;
  return `${rootDir ? rootDir + '\\' : ''}${cleanF7}${baseSlug || 'cartaz'}${sizeTag}.skcartaz`;
}

export type PsdLinkingIo = {
  readPsd: (psdPath: string) => Promise<{ name: string; path: string; buffer: ArrayBuffer }>;
  buildCartazFromPsd: (
    psdData: { name: string; path: string; buffer: ArrayBuffer },
    item: CampaignItem,
    paperSize: PaperFormat
  ) => Promise<Cartaz>;
  saveCartazDocument: (targetPath: string, doc: Cartaz) => Promise<unknown>;
  persistCampaign: (campaign: OfferCampaign) => Promise<OfferCampaign>;
  refreshLibrary?: () => Promise<void>;
};

export async function executePsdBatchLinking(
  campaign: OfferCampaign,
  itemsToLink: { item: CampaignItem; psd: ScannedPsdEntry }[],
  paperSize: PaperFormat,
  libraryRoot: string,
  io: PsdLinkingIo
): Promise<PsdBatchLinkResult> {
  if (itemsToLink.length === 0) {
    return {
      campaign,
      linkedCount: 0,
      errors: [],
      success: false,
      message: 'Nenhum produto selecionado para vincular.',
    };
  }

  let currentCampaign = campaign;
  let linkedCount = 0;
  const errors: PsdBatchLinkError[] = [];

  for (const { item, psd } of itemsToLink) {
    try {
      const psdData = await io.readPsd(psd.path);
      const cartazDoc = await io.buildCartazFromPsd(psdData, item, paperSize);
      const targetPath = buildCartazPathFromPsd(
        libraryRoot,
        psd.path || psd.name,
        paperSize
      );
      await io.saveCartazDocument(targetPath, cartazDoc);
      currentCampaign = linkSavedPosterToCampaignItem(
        currentCampaign,
        item.id,
        targetPath,
        cartazDoc,
        true
      );
      linkedCount++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push({
        itemId: item.id,
        f7: item.f7,
        description: item.description,
        psdName: psd.name,
        psdPath: psd.path,
        error: errorMsg,
      });
    }
  }

  if (linkedCount > 0) {
    currentCampaign = await io.persistCampaign(currentCampaign);
    if (io.refreshLibrary) {
      await io.refreshLibrary();
    }
  }

  const success = errors.length === 0 && linkedCount > 0;
  let message: string;
  if (success) {
    message = `Vinculação concluída com sucesso: ${linkedCount} cartaz(es) ${paperSize} criados e vinculados à campanha.`;
  } else if (linkedCount > 0 && errors.length > 0) {
    message = `Atenção: operação concluída com falhas. ${linkedCount} cartaz(es) vinculado(s), mas ${errors.length} falha(s) ocorreram.`;
  } else {
    message = `Falha na vinculação: nenhum cartaz pôde ser vinculado (${errors.length} erro(s)).`;
  }

  return {
    campaign: currentCampaign,
    linkedCount,
    errors,
    success,
    message,
  };
}

