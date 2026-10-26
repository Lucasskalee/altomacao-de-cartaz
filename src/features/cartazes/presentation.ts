import type { Cartaz } from './types';
import type { Poster } from '../../components/editor/PosterView';

/** Explicit printed fields shared by preview, print, thumbnails and PNG. */
export function posterFromDocument(document: Cartaz): Poster {
  const product = document.product;
  return { name: product.name, detail: product.complement, price: (product.priceCents / 100).toFixed(2), unit: product.unit };
}
