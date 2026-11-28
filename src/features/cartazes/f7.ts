import type { Cartaz, Entry } from './types';
import { deserialize } from './serialization';

/** Codes are strings: 001245 and 1245 identify different products. */
export const digitsOnly = (value: string): string => value.replace(/[^0-9]/g, '');
export const getF7 = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value) ? value : null;

export type IndexedCartaz = { path: string; fileName: string; document: Cartaz; source?: string };

const entryIndexCache = new WeakMap<Entry, IndexedCartaz | null>();
const f7LookupCache = new WeakMap<IndexedCartaz[], Map<string, IndexedCartaz[]>>();

/** Includes every valid document in the recursive local library snapshot. */
export function indexCartazes(entries: Entry[]): IndexedCartaz[] {
  const result: IndexedCartaz[] = [];
  for (const entry of entries) {
    if (entry.folder || !entry.content || entry.error) continue;
    if (entryIndexCache.has(entry)) {
      const cached = entryIndexCache.get(entry);
      if (cached) result.push(cached);
      continue;
    }
    try {
      const indexed: IndexedCartaz = {
        path: entry.path,
        fileName: entry.name,
        document: deserialize(entry.content),
        source: entry.content,
      };
      entryIndexCache.set(entry, indexed);
      result.push(indexed);
    } catch {
      /* Invalid files stay visible as errors in the library, never as matches. */
      entryIndexCache.set(entry, null);
    }
  }
  return result;
}

/** Exact product lookup; never deduplicate by UUID, F7 or folder, and never write. */
export function findCartazesByF7(f7: string, cartazes: IndexedCartaz[]): IndexedCartaz[] {
  if (!getF7(f7)) return [];
  let lookup = f7LookupCache.get(cartazes);
  if (!lookup) {
    lookup = new Map<string, IndexedCartaz[]>();
    for (const item of cartazes) {
      const code = getF7(item.document.product.productCode);
      if (!code) continue;
      const list = lookup.get(code);
      if (list) list.push(item);
      else lookup.set(code, [item]);
    }
    f7LookupCache.set(cartazes, lookup);
  }
  const matches = lookup.get(f7);
  return matches ? [...matches] : [];
}

export function matchesCartazSearch(item: IndexedCartaz, query: string): boolean {
  const product = item.document.product;
  const text = [item.fileName, product.name, product.complement, getF7(product.productCode) ?? ''].join(' ');
  return text.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'));
}

export const withoutF7 = (cartazes: IndexedCartaz[]): IndexedCartaz[] =>
  cartazes.filter(item => !getF7(item.document.product.productCode));
