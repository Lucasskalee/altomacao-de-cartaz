import type { Cartaz, Entry } from './types';
import { deserialize } from './serialization';

/** Codes are strings: 001245 and 1245 identify different products. */
export const digitsOnly = (value: string): string => value.replace(/[^0-9]/g, '');
export const getF7 = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && !/[^0-9]/.test(value) ? value : null;

export type IndexedCartaz = { path: string; fileName: string; document: Cartaz; source?: string };

/** Includes every valid document in the recursive local library snapshot. */
export function indexCartazes(entries: Entry[]): IndexedCartaz[] {
  const result: IndexedCartaz[] = [];
  for (const entry of entries) {
    if (entry.folder || !entry.content || entry.error) continue;
    try {
      result.push({ path: entry.path, fileName: entry.name, document: deserialize(entry.content), source: entry.content });
    } catch { /* Invalid files stay visible as errors in the library, never as matches. */ }
  }
  return result;
}

/** Exact product lookup; never deduplicate by UUID, F7 or folder, and never write. */
export function findCartazesByF7(f7: string, cartazes: IndexedCartaz[]): IndexedCartaz[] {
  if (!getF7(f7)) return [];
  return cartazes.filter(item => getF7(item.document.product.productCode) === f7);
}

export function matchesCartazSearch(item: IndexedCartaz, query: string): boolean {
  const product = item.document.product;
  const text = [item.fileName, product.name, product.complement, getF7(product.productCode) ?? ''].join(' ');
  return text.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'));
}

export const withoutF7 = (cartazes: IndexedCartaz[]): IndexedCartaz[] =>
  cartazes.filter(item => !getF7(item.document.product.productCode));
