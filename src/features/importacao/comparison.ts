import { findCartazesByF7, getF7, type IndexedCartaz } from '../cartazes/f7';
import type { DbfProduct, PriceComparison } from './types';

// Ignore decimal formatting differences, but retain fractions of a cent when detecting conflicts.
const decimalKey = (value: string) => value.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export function comparePrices(products: DbfProduct[], library: IndexedCartaz[]): PriceComparison[] {
  const libraryByF7 = new Map<string, IndexedCartaz[]>();
  for (const item of library) {
    const f7 = getF7(item.document.product.productCode);
    if (f7) { const matches = libraryByF7.get(f7) ?? []; matches.push(item); libraryByF7.set(f7, matches); }
  }
  const groups = new Map<string, Map<string, { product: DbfProduct; occurrences: number }>>();
  for (const product of products) {
    const key = product.f7 ?? `invalid:${product.record}`;
    const group = groups.get(key) ?? new Map();
    const signature = JSON.stringify([product.description, decimalKey(product.referenceRaw), decimalKey(product.alternativeRaw), product.barcode, product.issues]);
    const variant = group.get(signature);
    if (variant) variant.occurrences++;
    else group.set(signature, { product, occurrences: 1 });
    groups.set(key, group);
  }
  const rows: PriceComparison[] = [];
  for (const [f7, variants] of groups) {
    const matches = findCartazesByF7(f7, libraryByF7.get(f7) ?? []);
    const conflicting = variants.size > 1;
    for (const { product, occurrences } of variants.values()) {
      for (const match of matches.length ? matches : [null]) {
        const current = match?.document.product.priceCents ?? null;
        const priceStatus = current !== null && product.priceCents !== null ? (current === product.priceCents ? 'Igual' : 'Alterado') : null;
        const status = conflicting ? 'Conflito no DBF' : product.issues.length ? 'Dados inválidos' : match ? priceStatus! : 'Sem cartaz';
        rows.push({ key: `${product.record}:${match?.path ?? ''}`, product, occurrences, conflicting, cartazPath: match?.path ?? null, cartazId: match?.document.id ?? null, cartazPriceCents: current, priceStatus, status });
      }
    }
  }
  return rows;
}
