import type { Cartaz } from './types';
export function priceToCents(value: string): number {
  if (!/^\d{1,6}([,.]\d{1,2})?$/.test(value.trim())) throw new Error('Informe um preço válido com até duas casas decimais.');
  const [whole, fraction = ''] = value.trim().split(/[,.]/);
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function validate(value: unknown): asserts value is Cartaz {
  if (!value || typeof value !== 'object') throw new Error('Documento inválido.');
  const d = value as Cartaz;
  const text = (s: unknown, max: number) => typeof s === 'string' && [...s].length <= max;
  const date = (s: unknown) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));
  if (d.schemaVersion !== 1) throw new Error('Versão do documento não suportada.');
  if (!text(d.id, 100) || !d.id || !d.product || !text(d.product.name, 32) || !d.product.name.trim() || !text(d.product.complement,28) || !text(d.product.unit,12) || !d.product.unit.trim() || !(d.product.productCode === null || text(d.product.productCode,100)) || !Number.isSafeInteger(d.product.priceCents) || d.product.priceCents < 0 || d.product.priceCents > 99_999_999 || d.layout?.template !== 'oferta-classica' || d.layout.paper !== 'A5' || d.layout.orientation !== 'portrait' || !date(d.metadata?.createdAt) || !date(d.metadata?.updatedAt)) throw new Error('Arquivo corrompido ou dados do cartaz inválidos.');
}
export function fileName(name: string) {
  return (name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'cartaz') + '.skcartaz';
}
