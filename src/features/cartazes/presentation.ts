import type { Cartaz, ImportedArtwork, ImportedLayout } from './types';
import type { Poster } from '../../components/editor/PosterView';

export function formatCentsBr(priceCents: number): string {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return '0,00';
  const whole = Math.floor(priceCents / 100);
  const fraction = String(priceCents % 100).padStart(2, '0');
  return `${whole},${fraction}`;
}

export function splitCentsToParts(priceCents: number): { whole: string; fraction: string } {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return { whole: '0', fraction: '00' };
  const whole = String(Math.floor(priceCents / 100));
  const fraction = String(priceCents % 100).padStart(2, '0');
  return { whole, fraction };
}

/** Explicit printed fields shared by preview, print, thumbnails and PNG. */
export function posterFromDocument(document: Cartaz): Poster {
  const product = document.product;
  const artwork: ImportedArtwork | undefined =
    document.layout.template === 'imported-psd' ? (document.layout as ImportedLayout).artwork : undefined;
  return {
    name: product.name,
    detail: product.complement,
    price: formatCentsBr(product.priceCents),
    unit: product.unit,
    category:
      ((product as any).category as string) ||
      artwork?.templateParts?.find(p => p.role === 'category')?.originalText ||
      '',
    validityText:
      ((product as any).validityText as string) ||
      artwork?.priceParts?.find(p => p.role === 'validity')?.originalText ||
      '',
    artwork,
  };
}
