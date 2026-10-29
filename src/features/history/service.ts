import { PrintHistoryEntry, PrintHistoryFilter, PrintOperationStatus } from './types';

const STORAGE_KEY = 'skalee_cartaz_print_history_v1';
const MAX_HISTORY_ENTRIES = 500;

let memoryHistoryFallback: PrintHistoryEntry[] = [];

function formatDatePtBr(timestamp: number): string {
  try {
    const d = new Date(timestamp);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return new Date(timestamp).toLocaleString('pt-BR');
  }
}

export function getPrintHistory(): PrintHistoryEntry[] {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return [...memoryHistoryFallback];
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [...memoryHistoryFallback];
  }
}

export function savePrintHistory(entries: PrintHistoryEntry[]): void {
  const bounded = entries.slice(0, MAX_HISTORY_ENTRIES);
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    memoryHistoryFallback = bounded;
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    memoryHistoryFallback = bounded;
  }
}

export function addPrintHistoryEntries(
  items: Array<Omit<PrintHistoryEntry, 'id' | 'timestamp' | 'formattedDate'> & { timestamp?: number }>
): PrintHistoryEntry[] {
  const now = Date.now();
  const current = getPrintHistory();

  const newEntries: PrintHistoryEntry[] = items.map(it => {
    const ts = it.timestamp ?? now;
    return {
      ...it,
      id: `print_${ts}_${Math.random().toString(36).slice(2, 9)}`,
      timestamp: ts,
      formattedDate: formatDatePtBr(ts),
    };
  });

  const updated = [...newEntries, ...current];
  savePrintHistory(updated);
  return newEntries;
}

export function updatePrintHistoryStatus(
  ids: string[],
  status: PrintOperationStatus
): void {
  const current = getPrintHistory();
  const idSet = new Set(ids);
  let changed = false;

  const updated = current.map(item => {
    if (idSet.has(item.id)) {
      changed = true;
      return { ...item, status };
    }
    return item;
  });

  if (changed) {
    savePrintHistory(updated);
  }
}

export function clearPrintHistory(): void {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  memoryHistoryFallback = [];
}

/**
 * Retorna um mapa com o timestamp da última impressão por caminho de arquivo ou nome de produto.
 */
export function getLatestPrintMap(): Map<string, number> {
  const history = getPrintHistory();
  const map = new Map<string, number>();

  for (const entry of history) {
    if (entry.sourcePath && !map.has(entry.sourcePath)) {
      map.set(entry.sourcePath, entry.timestamp);
    }
    const nameKey = `name:${entry.productName.trim().toLowerCase()}`;
    if (!map.has(nameKey)) {
      map.set(nameKey, entry.timestamp);
    }
    if (entry.f7) {
      const f7Key = `f7:${entry.f7.trim()}`;
      if (!map.has(f7Key)) {
        map.set(f7Key, entry.timestamp);
      }
    }
  }

  return map;
}

/**
 * Filtra as entradas do histórico por período, formato e descrição/código F7.
 */
export function filterPrintHistory(
  entries: PrintHistoryEntry[],
  filters: PrintHistoryFilter
): PrintHistoryEntry[] {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  return entries.filter(item => {
    // 1. Filtro por período
    if (filters.period === 'today') {
      if (item.timestamp < todayMs) return false;
    } else if (filters.period === '7days') {
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      if (item.timestamp < sevenDaysAgo) return false;
    } else if (filters.period === '30days') {
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      if (item.timestamp < thirtyDaysAgo) return false;
    } else if (filters.period === 'custom') {
      if (filters.startDate) {
        const start = new Date(filters.startDate).getTime();
        if (!isNaN(start) && item.timestamp < start) return false;
      }
      if (filters.endDate) {
        const end = new Date(filters.endDate);
        end.setHours(23, 59, 59, 999);
        const endMs = end.getTime();
        if (!isNaN(endMs) && item.timestamp > endMs) return false;
      }
    }

    // 2. Filtro por formato
    if (filters.format && filters.format !== 'all') {
      if (item.paper !== filters.format) return false;
    }

    // 3. Filtro por descrição ou F7
    if (filters.query && filters.query.trim()) {
      const q = filters.query.trim().toLowerCase();
      const matchName = item.productName.toLowerCase().includes(q);
      const matchF7 = Boolean(item.f7 && item.f7.toLowerCase().includes(q));
      if (!matchName && !matchF7) return false;
    }

    return true;
  });
}
