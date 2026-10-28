import type { Poster } from '../../components/editor/PosterView';
import { clearArtworkImageCache } from '../../components/editor/importedRenderer';
import { loadConductorItem } from './service';
import type { ConductorQueueItem } from './types';

export interface ConductorBatchItemRef {
  queueItemId: string;
  sourcePath: string;
  name: string;
  detail: string;
  price: string;
  unit: string;
  copyIndex: number; // 1-based (ex: cópia 1 de 3)
  totalItemCopies: number;
}

export interface ConductorBatchPlan {
  batchIndex: number; // 0-based
  batchNumber: number; // 1-based (ex: 1 de 20)
  totalBatches: number;
  startIndex: number; // Índice global da página inicial (ex: 0)
  endIndex: number; // Índice global da página final (ex: 19)
  pageCount: number; // Quantidade de páginas neste lote (ex: 20)
  items: ConductorBatchItemRef[];
}

export type ConductorBatchStatus =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'dialog_open'
  | 'waiting_confirmation'
  | 'confirmed'
  | 'cancelled'
  | 'error';

export interface BatchExecutionState {
  currentBatchIndex: number;
  totalBatches: number;
  batchSize: number;
  totalPageCount: number;
  status: ConductorBatchStatus;
  activeBatchPosters: Poster[];
  errors: string[];
}

/**
 * Divide uma fila de cartazes em lotes de páginas A5 respeitando
 * rigorosamente a sequência ordenada e as cópias configuradas.
 *
 * Exemplo: 400 páginas divididas com batchSize = 20 resultam em 20 lotes de 20 páginas.
 */
export function partitionQueueIntoBatches(
  queue: ConductorQueueItem[],
  batchSize = 20
): ConductorBatchPlan[] {
  const safeBatchSize = Math.max(1, Math.min(100, Math.floor(batchSize) || 20));

  // Expande todas as referências de páginas da fila na ordem exata
  const allPages: ConductorBatchItemRef[] = [];
  for (const item of queue) {
    if (item.status === 'error') continue;
    const copies = Math.max(1, item.copies || 1);
    for (let c = 1; c <= copies; c++) {
      allPages.push({
        queueItemId: item.id,
        sourcePath: item.sourcePath,
        name: item.name,
        detail: item.detail,
        price: item.price,
        unit: item.unit,
        copyIndex: c,
        totalItemCopies: copies,
      });
    }
  }

  if (allPages.length === 0) return [];

  const totalPages = allPages.length;
  const totalBatches = Math.ceil(totalPages / safeBatchSize);
  const plans: ConductorBatchPlan[] = [];

  for (let b = 0; b < totalBatches; b++) {
    const start = b * safeBatchSize;
    const end = Math.min(start + safeBatchSize, totalPages);
    const slice = allPages.slice(start, end);

    plans.push({
      batchIndex: b,
      batchNumber: b + 1,
      totalBatches,
      startIndex: start,
      endIndex: end - 1,
      pageCount: slice.length,
      items: slice,
    });
  }

  return plans;
}

/**
 * Prepara sob demanda apenas os cartazes de alta resolução do lote ativo.
 * Após a impressão de cada lote, a memória das imagens em cache é liberada.
 */
export async function prepareBatchPosters(
  batchPlan: ConductorBatchPlan,
  queue: ConductorQueueItem[],
  customIo?: {
    readCartaz?: (path: string) => Promise<string>;
    readPsd?: (path: string) => Promise<ArrayBuffer>;
  },
  onItemFailed?: (failedItem: ConductorQueueItem, errorMessage: string) => void
): Promise<{ posters: Poster[]; errors: string[] }> {
  const posters: Poster[] = [];
  const errors: string[] = [];

  // Mapeia os itens únicos necessários para este lote para evitar releituras redundantes
  const neededItemIds = Array.from(new Set(batchPlan.items.map(it => it.queueItemId)));
  const itemMap = new Map<string, ConductorQueueItem>();

  for (const id of neededItemIds) {
    const original = queue.find(it => it.id === id);
    if (!original) continue;

    if (original.status === 'ready' && original.poster) {
      itemMap.set(id, original);
    } else {
      // Carrega sob demanda apenas para este lote
      const loaded = await loadConductorItem(original, customIo, { keepFullPoster: true });
      if (loaded.status === 'ready' && loaded.poster) {
        itemMap.set(id, loaded);
      } else {
        const errMsg = loaded.errorMessage || 'Falha de leitura do arquivo original';
        errors.push(`${original.name} (${original.sourcePath}): ${errMsg}`);
        if (onItemFailed) {
          onItemFailed(original, errMsg);
        }
      }
    }
  }

  // Monta a sequência exata de páginas A5 para este lote
  for (const ref of batchPlan.items) {
    const item = itemMap.get(ref.queueItemId);
    if (item && item.poster) {
      posters.push(item.poster);
    }
  }

  return { posters, errors };
}

/**
 * Libera explicitamente as referências de imagem decodificadas e buffers de memória
 * entre a execução dos lotes.
 */
export function releaseBatchMemory(): void {
  clearArtworkImageCache();
}

