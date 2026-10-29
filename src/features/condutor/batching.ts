import type { Poster } from '../../components/editor/PosterView';
import { clearArtworkImageCache } from '../../components/editor/importedRenderer';
import { loadConductorItem } from './service';
import type { ConductorQueueItem } from './types';
import type { Orientation, PaperSize, PosterFormatConfig } from '../formatos/types';
import { expandExpositorToA3Posters } from '../formatos/expositor';

export interface ConductorBatchItemRef {
  queueItemId: string;
  sourcePath: string;
  name: string;
  detail: string;
  price: string;
  unit: string;
  copyIndex: number; // 1-based (ex: cópia 1 de 3)
  totalItemCopies: number;
  paperFormat?: PaperSize;
  orientation?: Orientation;
  customWidthMm?: number;
  customHeightMm?: number;
  expositorPanelIndex?: number;
}

export interface ConductorBatchPlan {
  batchIndex: number; // 0-based
  batchNumber: number; // 1-based (ex: 1 de 20)
  totalBatches: number;
  startIndex: number; // Índice global da página inicial (ex: 0)
  endIndex: number; // Índice global da página final (ex: 19)
  pageCount: number; // Quantidade de páginas neste lote (ex: 20)
  items: ConductorBatchItemRef[];
  formatConfig?: PosterFormatConfig;
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
function expandItemPages(item: ConductorQueueItem): ConductorBatchItemRef[] {
  const pages: ConductorBatchItemRef[] = [];
  const copies = Math.max(1, item.copies || 1);
  const isExpositor = item.paperFormat === 'expositor-a3-2x2';

  for (let c = 1; c <= copies; c++) {
    if (isExpositor) {
      // Cada cópia do Expositor A3 2x2 é impressa como 4 páginas A3 verticais sequenciais
      for (let p = 0; p < 4; p++) {
        pages.push({
          queueItemId: item.id,
          sourcePath: item.sourcePath,
          name: `${item.name} (Folha ${p + 1} de 4)`,
          detail: item.detail,
          price: item.price,
          unit: item.unit,
          copyIndex: c,
          totalItemCopies: copies,
          paperFormat: 'A3', // Formato físico da folha na impressora
          orientation: 'portrait',
          expositorPanelIndex: p,
        });
      }
    } else {
      pages.push({
        queueItemId: item.id,
        sourcePath: item.sourcePath,
        name: item.name,
        detail: item.detail,
        price: item.price,
        unit: item.unit,
        copyIndex: c,
        totalItemCopies: copies,
        paperFormat: item.paperFormat || 'A5',
        orientation: item.orientation || 'portrait',
        customWidthMm: item.customWidthMm,
        customHeightMm: item.customHeightMm,
      });
    }
  }
  return pages;
}

/**
 * Divide uma fila de cartazes em lotes respeitando rigorosamente a sequência ordenada,
 * as cópias configuradas e efetuando a separação adequada por formato (A5, A4, A3, etc.).
 */
export function partitionQueueIntoBatches(
  queue: ConductorQueueItem[],
  batchSize = 20
): ConductorBatchPlan[] {
  const safeBatchSize = Math.max(1, Math.min(100, Math.floor(batchSize) || 20));
  const validItems = queue.filter(item => item.status !== 'error');
  if (validItems.length === 0) return [];

  // Verifica se há formatos distintos na fila
  const formatKeys = Array.from(
    new Set(validItems.map(it => `${it.paperFormat || 'A5'}_${it.orientation || 'portrait'}`))
  );

  // Se houver mais de um formato, separa lotes por formato
  if (formatKeys.length > 1) {
    const allPlans: ConductorBatchPlan[] = [];
    let globalIndex = 0;

    for (const fmtKey of formatKeys) {
      const itemsInFormat = validItems.filter(
        it => `${it.paperFormat || 'A5'}_${it.orientation || 'portrait'}` === fmtKey
      );
      const [paper, orientation] = fmtKey.split('_') as [PaperSize, Orientation];
      const sampleItem = itemsInFormat[0];
      const formatConfig: PosterFormatConfig = {
        paper,
        orientation,
        customWidthMm: sampleItem?.customWidthMm,
        customHeightMm: sampleItem?.customHeightMm,
      };

      const formatPages: ConductorBatchItemRef[] = [];
      for (const item of itemsInFormat) {
        formatPages.push(...expandItemPages(item));
      }

      const totalPages = formatPages.length;
      const totalFormatBatches = Math.ceil(totalPages / safeBatchSize);

      for (let b = 0; b < totalFormatBatches; b++) {
        const start = b * safeBatchSize;
        const end = Math.min(start + safeBatchSize, totalPages);
        const slice = formatPages.slice(start, end);

        allPlans.push({
          batchIndex: allPlans.length,
          batchNumber: allPlans.length + 1,
          totalBatches: 0, // Será ajustado ao final
          startIndex: globalIndex,
          endIndex: globalIndex + slice.length - 1,
          pageCount: slice.length,
          items: slice,
          formatConfig,
        });
        globalIndex += slice.length;
      }
    }

    return allPlans.map(p => ({
      ...p,
      totalBatches: allPlans.length,
    }));
  }

  // Fila uniforme (um único formato, ex: A5 Vertical padrão)
  const allPages: ConductorBatchItemRef[] = [];
  for (const item of validItems) {
    allPages.push(...expandItemPages(item));
  }

  if (allPages.length === 0) return [];

  const first = validItems[0];
  const formatConfig: PosterFormatConfig = {
    paper: first?.paperFormat || 'A5',
    orientation: first?.orientation || 'portrait',
    customWidthMm: first?.customWidthMm,
    customHeightMm: first?.customHeightMm,
  };

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
      formatConfig,
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

  // Monta a sequência exata de páginas para este lote
  for (const ref of batchPlan.items) {
    const item = itemMap.get(ref.queueItemId);
    if (item && item.poster) {
      if (typeof ref.expositorPanelIndex === 'number') {
        const panels = expandExpositorToA3Posters(item.poster);
        posters.push(panels[ref.expositorPanelIndex] || panels[0]);
      } else {
        posters.push(item.poster);
      }
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

