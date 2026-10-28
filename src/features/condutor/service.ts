import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Poster } from '../../components/editor/PosterView';
import { formatCentsBr, posterFromDocument } from '../cartazes/presentation';
import type { Cartaz, ImportedArtwork } from '../cartazes/types';
import { analyzePsd } from '../psd/importer';
import { createOptimizedThumbnail, globalThumbnailCache } from './cache';
import type {
  ConductorFileFormat,
  ConductorItemStatus,
  ConductorPrintBatchResult,
  ConductorQueueItem,
  ConductorScannedEntry,
  ConductorSourceType,
} from './types';

export function normalizeConductorPath(p: string): string {
  if (!p) return '';
  const trimmed = p.trim();
  const isUnc = trimmed.startsWith('\\\\') || trimmed.startsWith('//');
  const normalized = trimmed.replace(/[/\\]+/g, '\\');
  return isUnc ? `\\\\${normalized.replace(/^\\+/, '').toLowerCase()}` : normalized.toLowerCase();
}

export function isSameConductorPath(p1: string, p2: string): boolean {
  if (!p1 || !p2) return false;
  return normalizeConductorPath(p1) === normalizeConductorPath(p2);
}

export function findDuplicateInQueue(
  queue: ConductorQueueItem[],
  path: string
): ConductorQueueItem | undefined {
  if (!path) return undefined;
  const target = normalizeConductorPath(path);
  return queue.find(item => item.sourcePath && normalizeConductorPath(item.sourcePath) === target);
}

export function extractFileBaseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts.pop() || path;
}

export function inferFormatFromPath(path: string): ConductorFileFormat {
  return path.toLowerCase().endsWith('.psd') ? 'psd' : 'skcartaz';
}

export function createQueueItemFromFilePath(
  path: string,
  sourceType: ConductorSourceType,
  fileSize?: number
): ConductorQueueItem {
  const fileName = extractFileBaseName(path);
  const format = inferFormatFromPath(path);
  const cleanTitle = fileName.replace(/\.(skcartaz|psd)$/i, '');

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: cleanTitle.toUpperCase(),
    detail: '',
    price: '',
    unit: 'UN',
    sourcePath: path,
    sourceType,
    fileFormat: format,
    fileSize,
    copies: 1,
    status: 'idle',
  };
}

export function createQueueItemFromCartaz(
  cartaz: Cartaz,
  path: string,
  sourceType: ConductorSourceType = 'library'
): ConductorQueueItem {
  const poster = posterFromDocument(cartaz);
  const p = cartaz.product;
  const priceFormatted = formatCentsBr(p.priceCents);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: p.name || 'CARTAZ',
    detail: p.complement || '',
    price: priceFormatted,
    unit: p.unit || 'UN',
    f7: p.productCode || undefined,
    category: (p as any).category || poster.category || undefined,
    validityText: (p as any).validityText || poster.validityText || undefined,
    sourcePath: path,
    sourceType,
    fileFormat: 'skcartaz',
    copies: 1,
    status: 'ready',
    poster,
    thumbnailUrl: poster.artwork?.originalPreview,
    originalCartaz: cartaz,
  };
}

export function createQueueItemFromPoster(
  poster: Poster,
  label = 'Cartaz do Editor'
): ConductorQueueItem {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: poster.name || 'CARTAZ',
    detail: poster.detail || '',
    price: poster.price || '0,00',
    unit: poster.unit || 'UN',
    category: poster.category,
    validityText: poster.validityText,
    sourcePath: `[Editor] ${poster.name || 'Cartaz'}`,
    sourceType: 'editor',
    fileFormat: poster.artwork ? 'psd' : 'skcartaz',
    copies: 1,
    status: 'ready',
    poster,
    thumbnailUrl: poster.artwork?.originalPreview,
  };
}

export async function chooseConductorFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  return await invoke<string[]>('choose_conductor_files');
}

export async function chooseConductorFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return await invoke<string | null>('choose_conductor_folder');
}

export async function scanConductorFolder(folderPath: string): Promise<ConductorScannedEntry[]> {
  if (!isTauri()) return [];
  return await invoke<ConductorScannedEntry[]>('scan_conductor_folder', { folderPath });
}

export async function readConductorCartaz(path: string): Promise<string> {
  if (!isTauri()) throw new Error('Operação disponível apenas no aplicativo desktop.');
  return await invoke<string>('read_conductor_cartaz', { path });
}

export async function readConductorPsd(path: string): Promise<ArrayBuffer> {
  if (!isTauri()) throw new Error('Operação disponível apenas no aplicativo desktop.');
  return await invoke<ArrayBuffer>('read_conductor_psd', { path });
}

export async function loadConductorItem(
  item: ConductorQueueItem,
  customIo?: {
    readCartaz?: (path: string) => Promise<string>;
    readPsd?: (path: string) => Promise<ArrayBuffer>;
  },
  options?: {
    keepFullPoster?: boolean;
  }
): Promise<ConductorQueueItem> {
  const keepFull = options?.keepFullPoster !== false;
  if (item.status === 'ready' && (!keepFull || item.poster)) {
    return item;
  }

  const updated: ConductorQueueItem = { ...item, status: 'loading', errorMessage: undefined };

  try {
    if (item.fileFormat === 'skcartaz') {
      const readFn = customIo?.readCartaz || readConductorCartaz;
      const jsonStr = await readFn(item.sourcePath);
      const parsed = JSON.parse(jsonStr) as Cartaz;
      if (!parsed || parsed.schemaVersion !== 1 || !parsed.product) {
        throw new Error('Arquivo .skcartaz corrompido ou formato incompatível.');
      }
      const poster = posterFromDocument(parsed);
      updated.name = parsed.product.name || updated.name;
      updated.detail = parsed.product.complement || '';
      updated.price = formatCentsBr(parsed.product.priceCents);
      updated.unit = parsed.product.unit || 'UN';
      updated.f7 = parsed.product.productCode || undefined;
      updated.category = (parsed.product as any).category || poster.category || undefined;
      updated.validityText = (parsed.product as any).validityText || poster.validityText || undefined;
      updated.originalCartaz = parsed;
      updated.poster = keepFull ? poster : undefined;
      let thumb = poster.artwork ? globalThumbnailCache.get(item.sourcePath) : undefined;
      if (!thumb && poster.artwork?.originalPreview) {
        thumb = await createOptimizedThumbnail(poster.artwork.originalPreview);
        globalThumbnailCache.set(item.sourcePath, thumb);
      }
      updated.thumbnailUrl = thumb || (keepFull ? poster.artwork?.originalPreview : undefined);
      updated.status = 'ready';
      return updated;
    }

    if (item.fileFormat === 'psd') {
      const readPsdFn = customIo?.readPsd || readConductorPsd;
      const buffer = await readPsdFn(item.sourcePath);
      const fileName = extractFileBaseName(item.sourcePath);
      const analysis = await analyzePsd(buffer, fileName, item.sourcePath);

      // Requirement 5: Preserve 100% original Photoshop artwork without dynamic overrides
      const artwork: ImportedArtwork = {
        kind: 'imported-psd',
        compatibility: 'ready',
        source: {
          fileName: analysis.fileName,
          sha256: analysis.hash,
          sourcePath: analysis.sourcePath ?? null,
        },
        canvas: {
          width: analysis.width,
          height: analysis.height,
          resolutionPpi: analysis.resolutionPpi,
          fit: 'contain',
        },
        staticBackground: analysis.originalPreview,
        originalPreview: analysis.originalPreview,
        priceParts: [], // Empty parts: renders original composite without replacing text/price
        layers: analysis.layers,
        warnings: [],
      };

      const fallbackName = fileName.replace(/\.psd$/i, '').toUpperCase();
      const poster: Poster = {
        name: analysis.metadata.name || fallbackName,
        detail: analysis.metadata.complement || '',
        price: analysis.metadata.price || '0,00',
        unit: analysis.metadata.unit || 'UN',
        validityText: analysis.metadata.validityText || undefined,
        artwork,
      };

      let thumb = globalThumbnailCache.get(item.sourcePath);
      if (!thumb) {
        thumb = await createOptimizedThumbnail(analysis.originalPreview);
        globalThumbnailCache.set(item.sourcePath, thumb);
      }

      updated.name = poster.name;
      updated.detail = poster.detail;
      updated.price = poster.price;
      updated.unit = poster.unit;
      updated.validityText = poster.validityText;
      updated.poster = keepFull ? poster : undefined;
      updated.thumbnailUrl = thumb || (keepFull ? analysis.originalPreview : undefined);
      updated.status = 'ready';
      return updated;
    }

    throw new Error(`Formato desconhecido: ${item.fileFormat}`);
  } catch (err) {
    updated.status = 'error';
    updated.errorMessage = err instanceof Error ? err.message : String(err);
    return updated;
  }
}

export async function loadQueueConcurrently(
  queue: ConductorQueueItem[],
  concurrency = 2,
  onItemLoaded?: (loadedItem: ConductorQueueItem) => void,
  customIo?: {
    readCartaz?: (path: string) => Promise<string>;
    readPsd?: (path: string) => Promise<ArrayBuffer>;
  },
  options?: {
    keepFullPoster?: boolean;
  }
): Promise<ConductorQueueItem[]> {
  const result = [...queue];
  const pendingIndices: number[] = [];

  for (let i = 0; i < result.length; i++) {
    if (result[i].status !== 'ready') {
      pendingIndices.push(i);
    }
  }

  if (pendingIndices.length === 0) return result;

  let currentIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, pendingIndices.length) }, async () => {
    while (currentIndex < pendingIndices.length) {
      const idx = pendingIndices[currentIndex++];
      const loaded = await loadConductorItem(result[idx], customIo, options);
      result[idx] = loaded;
      if (onItemLoaded) {
        onItemLoaded(loaded);
      }
    }
  });

  await Promise.all(workers);
  return result;
}

export function moveQueueItem(
  queue: ConductorQueueItem[],
  fromIndex: number,
  toIndex: number
): ConductorQueueItem[] {
  if (
    fromIndex < 0 ||
    fromIndex >= queue.length ||
    toIndex < 0 ||
    toIndex >= queue.length ||
    fromIndex === toIndex
  ) {
    return queue;
  }
  const next = [...queue];
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed);
  return next;
}

export function updateQueueItemCopies(
  queue: ConductorQueueItem[],
  id: string,
  copies: number
): ConductorQueueItem[] {
  const safeCopies = Math.max(1, Math.min(999, Math.floor(copies) || 1));
  return queue.map(item => (item.id === id ? { ...item, copies: safeCopies } : item));
}

export function removeQueueItem(queue: ConductorQueueItem[], id: string): ConductorQueueItem[] {
  return queue.filter(item => item.id !== id);
}

export function relocateQueueItem(
  queue: ConductorQueueItem[],
  id: string,
  newPath: string
): ConductorQueueItem[] {
  const fileName = extractFileBaseName(newPath);
  const format = inferFormatFromPath(newPath);
  const cleanTitle = fileName.replace(/\.(skcartaz|psd)$/i, '');

  return queue.map(item => {
    if (item.id !== id) return item;
    return {
      ...item,
      name: cleanTitle.toUpperCase(),
      sourcePath: newPath,
      fileFormat: format,
      status: 'idle',
      errorMessage: undefined,
      poster: undefined,
      thumbnailUrl: undefined,
      originalCartaz: undefined,
    };
  });
}

export function buildConductorPrintBatch(queue: ConductorQueueItem[]): ConductorPrintBatchResult {
  const posters: Poster[] = [];
  const skippedErrors: string[] = [];
  let totalCopies = 0;
  let distinctItemsCount = 0;

  for (const item of queue) {
    if (item.status === 'error') {
      const reason = item.errorMessage || 'Arquivo inacessível ou com erro';
      skippedErrors.push(`${item.name} (${item.sourcePath}): ${reason}`);
      continue;
    }

    if (item.status === 'idle' || item.status === 'loading') {
      const reason = item.errorMessage || 'Arquivo ainda não carregado ou em processamento';
      skippedErrors.push(`${item.name} (${item.sourcePath}): ${reason}`);
      continue;
    }

    // O cartaz está no status 'ready': arquivo verificado e acessível
    distinctItemsCount++;
    const count = Math.max(1, item.copies || 1);
    totalCopies += count;

    let poster = item.poster;
    if (!poster && item.originalCartaz) {
      poster = posterFromDocument(item.originalCartaz);
    }

    if (poster) {
      for (let c = 0; c < count; c++) {
        posters.push(poster);
      }
    }
  }

  return {
    posters,
    skippedErrors,
    totalCopies,
    distinctItemsCount,
  };
}

