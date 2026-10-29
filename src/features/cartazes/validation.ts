import type { Cartaz, ImportedArtwork } from './types';
export const MAX_DOCUMENT_CHARS = 12 * 1024 * 1024;
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
  // v0.2.0 accepted free-text codes. Keep them intact when reading/resaving;
  // only digit strings qualify as F7 (see f7.ts). The document size is bounded.
  if (!text(d.id, 100) || !d.id || !d.product || !text(d.product.name, 32) || !d.product.name.trim() || !text(d.product.complement,28) || !text(d.product.unit,12) || !d.product.unit.trim() || !(d.product.productCode == null || typeof d.product.productCode === 'string') || !Number.isSafeInteger(d.product.priceCents) || d.product.priceCents < 0 || d.product.priceCents > 99_999_999 || !d.layout || !['oferta-classica','imported-psd'].includes(d.layout.template) || !['A6','A5','A4','A3','expositor-a3-2x2','custom'].includes(d.layout.paper) || !['portrait','landscape'].includes(d.layout.orientation) || !date(d.metadata?.createdAt) || !date(d.metadata?.updatedAt)) throw new Error('Arquivo corrompido ou dados do cartaz inválidos.');
  if (d.layout.template === 'imported-psd') validateImported(d.layout.artwork);
}

function validateImported(artwork: ImportedArtwork) {
  const dataUrl = (value: unknown) => typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value);
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  if (!artwork || artwork.kind !== 'imported-psd' || !['ready','requires-preparation'].includes(artwork.compatibility) || !artwork.source || typeof artwork.source.fileName !== 'string' || !/^[a-f0-9]{64}$/.test(artwork.source.sha256) || !(artwork.source.sourcePath == null || typeof artwork.source.sourcePath === 'string') || !artwork.canvas || !Number.isInteger(artwork.canvas.width) || !Number.isInteger(artwork.canvas.height) || artwork.canvas.width < 1 || artwork.canvas.height < 1 || artwork.canvas.width > 10_000 || artwork.canvas.height > 10_000 || !finite(artwork.canvas.resolutionPpi) || artwork.canvas.resolutionPpi < 1 || artwork.canvas.resolutionPpi > 2400 || artwork.canvas.fit !== 'contain' || !dataUrl(artwork.staticBackground) || !dataUrl(artwork.originalPreview) || !Array.isArray(artwork.priceParts) || !Array.isArray(artwork.layers) || !Array.isArray(artwork.warnings)) throw new Error('Arte PSD importada inválida.');
  const roles = new Set<string>();
  for (const part of artwork.priceParts) {
    if (!['whole','fraction','decimal','fractionRule','validity'].includes(part?.role) || roles.has(part.role) || typeof part.layerId !== 'string' || !part.layerId || typeof part.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(part.color) || !validBounds(part.bounds, artwork.canvas.width, artwork.canvas.height) || (part.fontFamily != null && typeof part.fontFamily !== 'string')) throw new Error('Mapeamento de preço PSD inválido.');
    roles.add(part.role);
  }
  if (!roles.has('whole') || !roles.has('fraction')) throw new Error('A arte PSD precisa mapear reais e centavos.');
  for (const layer of artwork.layers) if (!layer || typeof layer.id !== 'string' || typeof layer.name !== 'string' || !['text','raster','vector','group','empty'].includes(layer.type) || typeof layer.visible !== 'boolean' || !Number.isInteger(layer.depth) || !validBounds(layer.bounds, artwork.canvas.width, artwork.canvas.height)) throw new Error('Lista de camadas PSD inválida.');
}

function validBounds(bounds: unknown, width: number, height: number): bounds is {left:number;top:number;right:number;bottom:number} {
  if (!bounds || typeof bounds !== 'object') return false;
  const b = bounds as Record<string, unknown>;
  return ['left','top','right','bottom'].every(key => typeof b[key] === 'number' && Number.isFinite(b[key])) && (b.left as number) >= -width && (b.top as number) >= -height && (b.right as number) <= width * 2 && (b.bottom as number) <= height * 2 && (b.right as number) >= (b.left as number) && (b.bottom as number) >= (b.top as number);
}
export function fileName(name: string) {
  return (name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'cartaz') + '.skcartaz';
}
