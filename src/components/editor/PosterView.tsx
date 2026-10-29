import { useEffect, useRef } from 'react';
import type { ImportedArtwork } from '../../features/cartazes/types';
import { drawImported } from './importedRenderer';
import {
  DEFAULT_FORMAT_CONFIG,
  PosterFormatConfig,
} from '../../features/formatos/types';
import {
  getFormatDimensionsMm,
  getFormatLabel,
} from '../../features/formatos/service';
import {
  ExpositorPanelInfo,
  sliceCanvasIntoA3Panels,
} from '../../features/formatos/expositor';

export type Poster = {
  name: string;
  detail: string;
  price: string;
  unit: string;
  category?: string;
  artwork?: ImportedArtwork;
  validityText?: string;
  formatConfig?: PosterFormatConfig;
  expositorPanel?: ExpositorPanelInfo;
};

export const initial: Poster = { name: 'REPOLHO', detail: 'VERDE', price: '2,89', unit: 'KG' };
export const sanitizePrice = (value: string) => {
  const normalized = value.replace(/[^\d,.]/g, '').replace('.', ',');
  const [whole = '0', fraction = ''] = normalized.split(',');
  return { whole: whole || '0', fraction: (fraction + '00').slice(0, 2) };
};

export function PosterView({
  poster,
  isPrint = false,
  formatConfig,
  onRendered,
}: {
  poster: Poster;
  isPrint?: boolean;
  formatConfig?: PosterFormatConfig;
  onRendered?: () => void;
}) {
  const activeFormat = formatConfig || poster.formatConfig || DEFAULT_FORMAT_CONFIG;
  const isExpositorPanel = Boolean(poster.expositorPanel);
  const dims = getFormatDimensionsMm(activeFormat);
  const widthMm = isExpositorPanel ? 297 : dims.width;
  const heightMm = isExpositorPanel ? 420 : dims.height;
  const isLandscape = heightMm < widthMm;

  const posterStyle: React.CSSProperties = isPrint
    ? {
        width: `${widthMm}mm`,
        height: `${heightMm}mm`,
      }
    : {
        aspectRatio: `${widthMm} / ${heightMm}`,
        width: isLandscape ? 560 : 444,
        height: isLandscape ? Math.round(560 * (heightMm / widthMm)) : Math.round(444 * (heightMm / widthMm)),
        maxWidth: '100%',
        position: 'relative',
      };

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
  }, [poster.name, poster.detail, poster.price, poster.unit, poster.artwork, activeFormat]);

  if (poster.artwork) {
    return (
      <ImportedPosterView
        poster={poster}
        isPrint={isPrint}
        formatConfig={activeFormat}
        onRendered={onRendered}
      />
    );
  }
  const { whole, fraction } = sanitizePrice(poster.price);
  return (
    <div
      className="poster"
      style={posterStyle}
      aria-label={`Prévia do cartaz ${getFormatLabel(activeFormat)}`}
    >
      <div className="poster-content">
        <div className="poster-name">{poster.name || 'PRODUTO'}</div>
        <div className="poster-rule" />
        <div className="poster-detail">{poster.detail || '\u00a0'}</div>
        <div className="poster-price">
          <span className="price-whole">{whole}</span>
          <div className="price-right">
            <span className="price-fraction">{fraction}</span>
            <span className="fraction-rule" />
            <span className="price-unit">{poster.unit || 'UN'}</span>
          </div>
        </div>
      </div>

      {/* Overlay visual da grade 2×2 para prévia do Expositor A3 no editor */}
      {activeFormat.paper === 'expositor-a3-2x2' && !isPrint && !isExpositorPanel && (
        <div
          className="expositor-preview-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            border: '2px solid rgba(37, 99, 235, 0.45)',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: '50%',
              width: 1,
              borderLeft: '1.5px dashed rgba(37, 99, 235, 0.7)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: '50%',
              height: 1,
              borderTop: '1.5px dashed rgba(37, 99, 235, 0.7)',
            }}
          />
          <span style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 1 (A3)
          </span>
          <span style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 2 (A3)
          </span>
          <span style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 3 (A3)
          </span>
          <span style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 4 (A3)
          </span>
        </div>
      )}
    </div>
  );
}

function ImportedPosterView({
  poster,
  isPrint = false,
  formatConfig = DEFAULT_FORMAT_CONFIG,
  onRendered,
}: {
  poster: Poster & { artwork?: ImportedArtwork };
  isPrint?: boolean;
  formatConfig?: PosterFormatConfig;
  onRendered?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  const isExpositorPanel = Boolean(poster.expositorPanel);
  const dims = getFormatDimensionsMm(formatConfig);
  const widthMm = isExpositorPanel ? 297 : dims.width;
  const heightMm = isExpositorPanel ? 420 : dims.height;
  const isLandscape = heightMm < widthMm;

  const posterStyle: React.CSSProperties = isPrint
    ? {
        width: `${widthMm}mm`,
        height: `${heightMm}mm`,
      }
    : {
        aspectRatio: `${widthMm} / ${heightMm}`,
        width: isLandscape ? 560 : 444,
        height: isLandscape ? Math.round(560 * (heightMm / widthMm)) : Math.round(444 * (heightMm / widthMm)),
        maxWidth: '100%',
        position: 'relative',
      };

  useEffect(() => {
    const canvas = ref.current;
    let cancelled = false;

    if (canvas && poster.artwork) {
      if (poster.expositorPanel) {
        // Modo Expositor A3: renderiza a arte completa e extrai o quadrante A3 correspondente com overlap
        const fullCanvas = document.createElement('canvas');
        const fullW = isPrint ? 3508 : 1754;
        const fullH = isPrint ? 4960 : 2480;

        void drawImported(
          fullCanvas,
          poster.artwork,
          poster.price,
          fullW,
          fullH,
          poster.validityText,
          {
            category: poster.category,
            name: poster.name,
            complement: poster.detail,
            unit: poster.unit,
          }
        )
          .then(() => {
            if (cancelled) return;
            const panels = sliceCanvasIntoA3Panels(fullCanvas, isPrint ? 300 : 150);
            const targetPanel = panels[poster.expositorPanel!.index] || panels[0];
            canvas.width = targetPanel.width;
            canvas.height = targetPanel.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(targetPanel, 0, 0);
            }
            fullCanvas.width = 0;
            fullCanvas.height = 0;
            panels.forEach(p => { p.width = 0; p.height = 0; });
            onRenderedRef.current?.();
          })
          .catch(() => {
            if (!cancelled) onRenderedRef.current?.();
          });
      } else {
        // Modo Padrão: gera a 300 DPI proporcional ao formato
        const targetW = isPrint
          ? Math.round((widthMm / 25.4) * 300)
          : Math.round(widthMm * 6);
        const targetH = isPrint
          ? Math.round((heightMm / 25.4) * 300)
          : Math.round(heightMm * 6);

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
      }
    } else {
      onRenderedRef.current?.();
    }

    return () => {
      cancelled = true;
      if (canvas && isPrint) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [
    poster.artwork,
    poster.price,
    poster.validityText,
    poster.category,
    poster.name,
    poster.detail,
    poster.unit,
    poster.expositorPanel,
    isPrint,
    widthMm,
    heightMm,
  ]);

  return (
    <div
      className="poster imported-poster"
      style={posterStyle}
      aria-label={`Prévia da arte PSD em ${getFormatLabel(formatConfig)}`}
    >
      <canvas
        ref={ref}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />

      {/* Overlay visual da grade 2×2 para prévia do Expositor A3 no editor */}
      {formatConfig.paper === 'expositor-a3-2x2' && !isPrint && !isExpositorPanel && (
        <div
          className="expositor-preview-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            border: '2px solid rgba(37, 99, 235, 0.45)',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: '50%',
              width: 1,
              borderLeft: '1.5px dashed rgba(37, 99, 235, 0.7)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: '50%',
              height: 1,
              borderTop: '1.5px dashed rgba(37, 99, 235, 0.7)',
            }}
          />
          <span style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 1 (A3)
          </span>
          <span style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 2 (A3)
          </span>
          <span style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 3 (A3)
          </span>
          <span style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(30, 64, 175, 0.85)', color: '#fff', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            Folha 4 (A3)
          </span>
        </div>
      )}
    </div>
  );
}
