import { invoke, isTauri } from '@tauri-apps/api/core';
import { findCartazesByF7, type IndexedCartaz } from '../cartazes/f7';
import type { Cartaz } from '../cartazes/types';
import { posterFromDocument } from '../cartazes/presentation';
import type { Poster } from '../../components/editor/PosterView';
import type { ColumnMapping, ExcelExtractionResult } from './excel';
import type { CampaignItem, CampaignMatchView, CampaignPosterState, OfferCampaign, PrintStatus } from './types';

const normalizedPath = (path: string) => path.replace(/\//g, '\\').toLocaleLowerCase('en-US');

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
    const nextPosters: CampaignPosterState[] = [...item.posters];
    for (const match of matches) {
      const exists = nextPosters.some(p => normalizedPath(p.cartazPath) === normalizedPath(match.path));
      if (!exists) {
        changed = true;
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
    return nextPosters.length === item.posters.length ? item : { ...item, posters: nextPosters };
  });
  return changed ? { ...campaign, items, updatedAt: new Date().toISOString() } : campaign;
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

/** Projects the library Cartaz with the scheduled price WITHOUT mutating the library document. */
export function buildScheduledDocument(libraryDocument: Cartaz, scheduledPriceCents: number): Cartaz {
  const clone = structuredClone(libraryDocument);
  clone.product = {
    ...clone.product,
    priceCents: scheduledPriceCents,
  };
  return clone;
}

export function buildScheduledPoster(libraryDocument: Cartaz, scheduledPriceCents: number): Poster {
  return posterFromDocument(buildScheduledDocument(libraryDocument, scheduledPriceCents));
}

export function buildCampaignMatchViews(campaign: OfferCampaign, library: IndexedCartaz[]): CampaignMatchView[] {
  const byPath = new Map<string, IndexedCartaz>();
  for (const item of library) {
    byPath.set(normalizedPath(item.path), item);
  }
  return campaign.items.map(item => {
    const allF7Matches = findCartazesByF7(item.f7, library);
    const linkedPaths = new Set(item.posters.map(p => normalizedPath(p.cartazPath)));
    const matchedPosters = item.posters.map(state => {
      const lib = byPath.get(normalizedPath(state.cartazPath)) ?? allF7Matches.find(m => m.document.id === state.cartazId) ?? null;
      return {
        state,
        libraryCartaz: lib,
        currentPriceCents: lib ? lib.document.product.priceCents : null,
        scheduledDocument: lib ? buildScheduledDocument(lib.document, item.scheduledPriceCents) : null,
      };
    });
    const unlinkedLibraryPosters = allF7Matches.filter(m => !linkedPaths.has(normalizedPath(m.path)));
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
