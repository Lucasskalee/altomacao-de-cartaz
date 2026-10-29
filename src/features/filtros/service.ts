import { ConductorQueueItem } from '../condutor/types';
import { Entry } from '../cartazes/types';
import { DateFilterOption, INITIAL_FILTER_STATE, PosterFilterState, PrintDateFilterOption } from './types';

export function hasActiveFilters(state: PosterFilterState): boolean {
  return Boolean(
    state.f7Query.trim() ||
      state.descQuery.trim() ||
      state.format !== 'all' ||
      state.createdDateFilter !== 'all' ||
      state.printedDateFilter !== 'all' ||
      state.sort !== 'date_desc'
  );
}

function matchesDateRange(
  timestamp: number | undefined,
  option: DateFilterOption,
  startDate?: string,
  endDate?: string
): boolean {
  if (option === 'all') return true;
  if (!timestamp || isNaN(timestamp)) return false;

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  if (option === 'today') {
    return timestamp >= todayMs;
  }
  if (option === '7days') {
    return timestamp >= now - 7 * 24 * 60 * 60 * 1000;
  }
  if (option === '30days') {
    return timestamp >= now - 30 * 24 * 60 * 60 * 1000;
  }
  if (option === 'custom') {
    if (startDate) {
      const s = new Date(startDate).getTime();
      if (!isNaN(s) && timestamp < s) return false;
    }
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      const eMs = e.getTime();
      if (!isNaN(eMs) && timestamp > eMs) return false;
    }
    return true;
  }
  return true;
}

function matchesPrintDate(
  printTimestamp: number | undefined,
  option: PrintDateFilterOption,
  startDate?: string,
  endDate?: string
): boolean {
  if (option === 'all') return true;
  if (option === 'never') return !printTimestamp;
  if (option === 'printed') return Boolean(printTimestamp);
  if (!printTimestamp) return false;

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  if (option === 'today') {
    return printTimestamp >= todayMs;
  }
  if (option === '7days') {
    return printTimestamp >= now - 7 * 24 * 60 * 60 * 1000;
  }
  if (option === '30days') {
    return printTimestamp >= now - 30 * 24 * 60 * 60 * 1000;
  }
  if (option === 'custom') {
    if (startDate) {
      const s = new Date(startDate).getTime();
      if (!isNaN(s) && printTimestamp < s) return false;
    }
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      const eMs = e.getTime();
      if (!isNaN(eMs) && printTimestamp > eMs) return false;
    }
    return true;
  }
  return true;
}

/**
 * Filtra e ordena itens da fila do Condutor de Impressão sem alterar permanentemente a fila original.
 */
export function filterAndSortConductorQueue(
  queue: ConductorQueueItem[],
  state: PosterFilterState,
  printDateMap?: Map<string, number>
): ConductorQueueItem[] {
  const f7Clean = state.f7Query.trim().toLowerCase();
  const descClean = state.descQuery.trim().toLowerCase();

  return queue
    .filter(item => {
      // 1. Pesquisa por código F7
      if (f7Clean) {
        if (!item.f7 || !item.f7.toLowerCase().includes(f7Clean)) {
          return false;
        }
      }

      // 2. Pesquisa por descrição do produto
      if (descClean) {
        const nameMatch = item.name.toLowerCase().includes(descClean);
        const detailMatch = item.detail ? item.detail.toLowerCase().includes(descClean) : false;
        if (!nameMatch && !detailMatch) return false;
      }

      // 3. Filtro por formato
      if (state.format !== 'all') {
        const itemFormat = item.paperFormat || 'A5';
        if (itemFormat !== state.format) return false;
      }

      // 4. Filtro por data de cadastro/modificação
      if (state.createdDateFilter !== 'all') {
        const ts = item.createdAt;
        if (!matchesDateRange(ts, state.createdDateFilter, state.createdStartDate, state.createdEndDate)) {
          return false;
        }
      }

      // 5. Filtro por data de impressão
      if (state.printedDateFilter !== 'all') {
        let printTs = item.lastPrintedAt;
        if (!printTs && printDateMap) {
          printTs = printDateMap.get(item.sourcePath) ?? printDateMap.get(`name:${item.name.trim().toLowerCase()}`);
        }
        if (!matchesPrintDate(printTs, state.printedDateFilter, state.printedStartDate, state.printedEndDate)) {
          return false;
        }
      }

      return true;
    })
    .sort((a, b) => {
      if (state.sort === 'name_asc') {
        return a.name.localeCompare(b.name, 'pt-BR');
      }
      if (state.sort === 'name_desc') {
        return b.name.localeCompare(a.name, 'pt-BR');
      }
      if (state.sort === 'date_asc') {
        return (a.createdAt ?? 0) - (b.createdAt ?? 0);
      }
      // date_desc (padrão)
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
}

