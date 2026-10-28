import { useEffect, useRef } from 'react';
import type { ImportedArtwork } from '../../features/cartazes/types';
import { drawImported } from './importedRenderer';
export type Poster = { name: string; detail: string; price: string; unit: string; category?: string; artwork?: ImportedArtwork; validityText?: string };
export const initial: Poster = { name: 'REPOLHO', detail: 'VERDE', price: '2,89', unit: 'KG' };
export const sanitizePrice = (value: string) => {
  const normalized = value.replace(/[^\d,.]/g, '').replace('.', ',');
  const [whole = '0', fraction = ''] = normalized.split(',');
  return { whole: whole || '0', fraction: (fraction + '00').slice(0, 2) };
};
export function PosterView({
  poster,
  isPrint = false,
  onRendered,
}: {
  poster: Poster;
  isPrint?: boolean;
  onRendered?: () => void;
}) {
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  useEffect(() => {
    if (!poster.artwork) {
      if (typeof document !== 'undefined' && 'fonts' in document) {
        document.fonts.ready
          .then(() => onRenderedRef.current?.())
          .catch(() => onRenderedRef.current?.());
      } else {
        onRenderedRef.current?.();
      }
    }
  }, [poster.name, poster.detail, poster.price, poster.unit, poster.artwork]);

  if (poster.artwork) {
    return <ImportedPosterView poster={poster} isPrint={isPrint} onRendered={onRendered} />;
  }
  const {whole, fraction} = sanitizePrice(poster.price);
  return <div className="poster" aria-label="Prévia do cartaz A5">
    <div className="poster-content">
      <div className="poster-name">{poster.name || 'PRODUTO'}</div>
      <div className="poster-rule" />
      <div className="poster-detail">{poster.detail || '\u00a0'}</div>
      <div className="poster-price">
        <span className="price-whole">{whole}</span>
        <div className="price-right"><span className="price-fraction">{fraction}</span><span className="fraction-rule"/><span className="price-unit">{poster.unit || 'UN'}</span></div>
      </div>
    </div>
  </div>;
}

function ImportedPosterView({
  poster,
  isPrint = false,
  onRendered,
}: {
  poster: Poster & {artwork?: ImportedArtwork};
  isPrint?: boolean;
  onRendered?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  useEffect(() => {
    const canvas = ref.current;
    let cancelled = false;

    if (canvas && poster.artwork) {
      // In print mode, render at 300 DPI (1748 × 2480 or native PSD dimensions) for maximum fidelity
      const targetW = isPrint ? Math.max(1748, poster.artwork.canvas.width) : 886;
      const targetH = isPrint ? Math.max(2480, poster.artwork.canvas.height) : 1260;
      void drawImported(
        canvas,
        poster.artwork,
        poster.price,
        targetW,
        targetH,
        poster.validityText,
        {
          category: poster.category,
          name: poster.name,
          complement: poster.detail,
          unit: poster.unit,
        }
      )
        .then(() => {
          if (!cancelled) {
            onRenderedRef.current?.();
          }
        })
        .catch(() => {
          if (!cancelled) {
            onRenderedRef.current?.();
          }
        });
    } else {
      onRenderedRef.current?.();
    }

    return () => {
      cancelled = true;
      // Libera imediatamente a memória de bitmap e GPU ao desmontar elementos de impressão
      if (canvas && isPrint) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [poster.artwork, poster.price, poster.validityText, poster.category, poster.name, poster.detail, poster.unit, isPrint]);
  return <div className="poster imported-poster" aria-label="Prévia da arte PSD em A5"><canvas ref={ref}/></div>;
}
