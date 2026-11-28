import type { Cartaz, ImportedArtwork, ImportedLayout } from './types';
import type { Poster } from '../../components/editor/PosterView';
import { priceToCents } from './validation';

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

function safePriceCents(priceOverride: string | undefined, fallbackCents: number): number {
  if (priceOverride === undefined) return fallbackCents;
  try {
    return priceToCents(priceOverride);
  } catch {
    return fallbackCents;
  }
}

/** Explicit printed fields shared by preview, print, thumbnails and PNG. */
export function posterFromDocument(document: Cartaz, priceOverride?: string): Poster {
  const product = document.product;
  const artwork: ImportedArtwork | undefined =
    document.layout.template === 'imported-psd' ? (document.layout as ImportedLayout).artwork : undefined;
  const effectiveCents = safePriceCents(priceOverride, product.priceCents);
  const hasBoxPrice = Boolean(product.hasBoxPrice);
  const boxQuantity = product.boxQuantity ? Number(product.boxQuantity) : 12;
  const boxPrice =
    product.boxPriceCents
      ? formatCentsBr(product.boxPriceCents)
      : hasBoxPrice
        ? formatCentsBr(effectiveCents * boxQuantity)
        : undefined;

  return {
    name: product.name,
    detail: product.complement,
    price: priceOverride !== undefined ? priceOverride : formatCentsBr(product.priceCents),
    unit: product.unit,
    category:
      product.category ||
      artwork?.templateParts?.find(p => p.role === 'category')?.originalText ||
      '',
    validityText:
      product.validityText ||
      artwork?.priceParts?.find(p => p.role === 'validity')?.originalText ||
      '',
    hasBoxPrice,
    boxQuantity,
    boxUnitLabel: product.boxUnitLabel || 'UND.',
    boxPrice,
    ...(product.boxPackageType ? { boxPackageType: product.boxPackageType } : {}),
    ...(product.boxPackageLabel ? { boxPackageLabel: product.boxPackageLabel } : {}),
    ...(product.unitBadgeMode ? { unitBadgeMode: product.unitBadgeMode } : {}),
    ...(product.productImage ? { productImage: product.productImage } : {}),
    artwork,
  };
}
