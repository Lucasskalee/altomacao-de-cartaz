import type { Cartaz } from './types';
import { MAX_DOCUMENT_CHARS, validate } from './validation';
export function serialize(document: Cartaz): string { validate(document); return JSON.stringify(document, null, 2); }
export function deserialize(source: string): Cartaz {
  if (source.length > MAX_DOCUMENT_CHARS) throw new Error('Documento excede 12 MB.');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('Arquivo JSON inválido ou corrompido.'); }
  validate(value); return value;
}
export function createDocument(): Cartaz {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: crypto.randomUUID(), product: { name: 'REPOLHO', complement: 'VERDE', priceCents: 289, unit: 'KG', productCode: null }, layout: { template: 'oferta-classica', paper: 'A5', orientation: 'portrait' }, metadata: { createdAt: now, updatedAt: now } };
}
export function duplicate(document: Cartaz): Cartaz {
  const now = new Date().toISOString();
  return { ...structuredClone(document), id: crypto.randomUUID(), metadata: { ...document.metadata, createdAt: now, updatedAt: now } };
}
