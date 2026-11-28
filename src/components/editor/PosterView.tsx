import { useEffect, useRef, useState } from 'react';
import type { ImportedArtwork, PartAdjustment } from '../../features/cartazes/types';
import {
  clampPartAdjustment,
  computeSnapAdjustment,
  drawImported,
  getEditableParts,
  getEffectivePartBounds,
  getPartKey,
  isPriceGroupRole,
  type SnapGuides,
} from './importedRenderer';
import { extractSerializableArtwork, type PreparedPosterRenderPlan } from './posterRenderPlan';
import { preparePosterRenderOffThread } from './posterRenderWorkerClient';
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
  hasBoxPrice?: boolean;
  boxQuantity?: number;
  boxUnitLabel?: string;
  boxPrice?: string;
  boxPackageType?: 'caixa' | 'fardo';
  boxPackageLabel?: string;
  unitBadgeMode?: 'auto' | 'un' | 'text';
  productImage?: { dataUrl: string; fileName?: string; bounds?: { left: number; top: number; right: number; bottom: number } };
  showSurgicalGuides?: boolean;
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
  showGrid = false,
  selectedPartKey = null,
  lockPriceGroup = false,
  onSelectPart,
  onUpdatePartAdjustment,
  onUpdateMultiplePartAdjustments,
}: {
  poster: Poster;
  isPrint?: boolean;
  formatConfig?: PosterFormatConfig;
  onRendered?: () => void;
  showGrid?: boolean;
  selectedPartKey?: string | null;
  lockPriceGroup?: boolean;
  onSelectPart?: (partKey: string | null) => void;
  onUpdatePartAdjustment?: (partKey: string, adjustment: PartAdjustment) => void;
  onUpdateMultiplePartAdjustments?: (updates: Record<string, PartAdjustment>) => void;
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
  }, [
    poster.name,
    poster.detail,
    poster.price,
    poster.unit,
    poster.hasBoxPrice,
    poster.boxQuantity,
    poster.boxUnitLabel,
    poster.boxPrice,
    poster.artwork,
    activeFormat,
  ]);

  if (poster.artwork) {
    return (
      <ImportedPosterView
        poster={poster}
        isPrint={isPrint}
        formatConfig={activeFormat}
        onRendered={onRendered}
        showGrid={showGrid}
        selectedPartKey={selectedPartKey}
        lockPriceGroup={lockPriceGroup}
        onSelectPart={onSelectPart}
        onUpdatePartAdjustment={onUpdatePartAdjustment}
        onUpdateMultiplePartAdjustments={onUpdateMultiplePartAdjustments}
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
  showGrid = false,
  selectedPartKey = null,
  lockPriceGroup = false,
  onSelectPart,
  onUpdatePartAdjustment,
  onUpdateMultiplePartAdjustments,
}: {
  poster: Poster & { artwork?: ImportedArtwork };
  isPrint?: boolean;
  formatConfig?: PosterFormatConfig;
  onRendered?: () => void;
  showGrid?: boolean;
  selectedPartKey?: string | null;
  lockPriceGroup?: boolean;
  onSelectPart?: (partKey: string | null) => void;
  onUpdatePartAdjustment?: (partKey: string, adjustment: PartAdjustment) => void;
  onUpdateMultiplePartAdjustments?: (updates: Record<string, PartAdjustment>) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const interactive = !isPrint && Boolean(onSelectPart && onUpdatePartAdjustment && poster.artwork);
  const [dragCursor, setDragCursor] = useState<'default' | 'grab' | 'grabbing' | 'nwse-resize'>('default');
  const [activeSnapGuides, setActiveSnapGuides] = useState<SnapGuides | null>(null);
  const dragStateRef = useRef<{
    mode: 'move' | 'resize';
    partKey: string;
    startArtX: number;
    startArtY: number;
    origDx: number;
    origDy: number;
    origScale: number;
    centerX: number;
    centerY: number;
    startDist: number;
    groupInitial: Record<string, { dx: number; dy: number; scale: number }> | null;
  } | null>(null);

  const clientToArtworkPoint = (clientX: number, clientY: number) => {
    const canvas = ref.current;
    const artwork = poster.artwork;
    if (!canvas || !artwork || !canvas.width || !canvas.height) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const bitmapScale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const bitmapOffsetX = (rect.width - canvas.width * bitmapScale) / 2;
    const bitmapOffsetY = (rect.height - canvas.height * bitmapScale) / 2;
    const canvasX = (clientX - rect.left - bitmapOffsetX) / bitmapScale;
    const canvasY = (clientY - rect.top - bitmapOffsetY) / bitmapScale;
    const artScale = Math.min(canvas.width / artwork.canvas.width, canvas.height / artwork.canvas.height);
    const artOffsetX = (canvas.width - artwork.canvas.width * artScale) / 2;
    const artOffsetY = (canvas.height - artwork.canvas.height * artScale) / 2;
    return {
      x: (canvasX - artOffsetX) / artScale,
      y: (canvasY - artOffsetY) / artScale,
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive || !poster.artwork || event.button !== 0) return;
    const pt = clientToArtworkPoint(event.clientX, event.clientY);
    if (!pt) return;

    const parts = getEditableParts(poster.artwork);
    const pad = Math.max(8, poster.artwork.canvas.width * 0.01);
    const handleRadius = Math.max(22, poster.artwork.canvas.width * 0.026);

    const capturePriceGroup = (partRole: (typeof parts)[number]['role']) => {
      if (!lockPriceGroup || !onUpdateMultiplePartAdjustments || !isPriceGroupRole(partRole)) {
        return null;
      }
      const map: Record<string, { dx: number; dy: number; scale: number }> = {};
      for (const p of parts) {
        if (isPriceGroupRole(p.role)) {
          map[getPartKey(p)] = clampPartAdjustment(p.adjustments);
        }
      }
      return Object.keys(map).length > 1 ? map : null;
    };

    // 1. Check resize handle of currently selected part first
    if (selectedPartKey) {
      const activePart = parts.find(p => getPartKey(p) === selectedPartKey);
      if (activePart) {
        const eff = getEffectivePartBounds(activePart);
        const rx = eff.right + Math.max(4, poster.artwork.canvas.width * 0.006);
        const ry = eff.bottom + Math.max(4, poster.artwork.canvas.width * 0.006);
        if (Math.hypot(pt.x - rx, pt.y - ry) <= handleRadius) {
          const currentAdj = clampPartAdjustment(activePart.adjustments);
          const cx = (eff.left + eff.right) / 2;
          const cy = (eff.top + eff.bottom) / 2;
          dragStateRef.current = {
            mode: 'resize',
            partKey: selectedPartKey,
            startArtX: pt.x,
            startArtY: pt.y,
            origDx: currentAdj.dx,
            origDy: currentAdj.dy,
            origScale: currentAdj.scale,
            centerX: cx,
            centerY: cy,
            startDist: Math.max(16, Math.hypot(pt.x - cx, pt.y - cy)),
            groupInitial: capturePriceGroup(activePart.role),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragCursor('nwse-resize');
          return;
        }
      }
    }

    // 2. Hit-test all editable parts (smallest area wins when overlapping, e.g. comma/fraction vs whole)
    const hits = parts
      .map(part => {
        const eff = getEffectivePartBounds(part);
        const hit =
          pt.x >= eff.left - pad &&
          pt.x <= eff.right + pad &&
          pt.y >= eff.top - pad &&
          pt.y <= eff.bottom + pad;
        const area = Math.max(1, (eff.right - eff.left) * (eff.bottom - eff.top));
        return { part, eff, hit, area };
      })
      .filter(item => item.hit)
      .sort((a, b) => a.area - b.area);

    if (hits.length === 0) {
      onSelectPart?.(null);
      setDragCursor('default');
      return;
    }

    const chosen = hits[0].part;
    const key = getPartKey(chosen);
    onSelectPart?.(key);
    const currentAdj = clampPartAdjustment(chosen.adjustments);
    dragStateRef.current = {
      mode: 'move',
      partKey: key,
      startArtX: pt.x,
      startArtY: pt.y,
      origDx: currentAdj.dx,
      origDy: currentAdj.dy,
      origScale: currentAdj.scale,
      centerX: (hits[0].eff.left + hits[0].eff.right) / 2,
      centerY: (hits[0].eff.top + hits[0].eff.bottom) / 2,
      startDist: 1,
      groupInitial: capturePriceGroup(chosen.role),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragCursor('grabbing');
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive || !poster.artwork) return;
    const pt = clientToArtworkPoint(event.clientX, event.clientY);
    if (!pt) return;

    const drag = dragStateRef.current;
    if (drag) {
      const parts = getEditableParts(poster.artwork);
      const draggedPart = parts.find(p => getPartKey(p) === drag.partKey);
      if (drag.mode === 'move') {
        const rawDx = Math.round(drag.origDx + (pt.x - drag.startArtX));
        const rawDy = Math.round(drag.origDy + (pt.y - drag.startArtY));

        let finalDx = rawDx;
        let finalDy = rawDy;
        let guides: SnapGuides | null = null;

        // Hold Alt to bypass magnetic snapping (Photoshop convention)
        if (draggedPart && !event.altKey) {
          const excludedKeys = new Set<string>([
            drag.partKey,
            ...(drag.groupInitial ? Object.keys(drag.groupInitial) : []),
          ]);
          const siblings = parts.filter(p => !excludedKeys.has(getPartKey(p)));
          const snapped = computeSnapAdjustment(
            draggedPart,
            rawDx,
            rawDy,
            drag.origScale,
            poster.artwork,
            siblings,
            showGrid
          );
          finalDx = snapped.dx;
          finalDy = snapped.dy;
          guides =
            snapped.guides.verticalX !== null || snapped.guides.horizontalY !== null
              ? snapped.guides
              : null;
        }
        setActiveSnapGuides(guides);

        if (drag.groupInitial && onUpdateMultiplePartAdjustments) {
          const deltaX = finalDx - drag.origDx;
          const deltaY = finalDy - drag.origDy;
          const batch: Record<string, PartAdjustment> = {};
          for (const [k, init] of Object.entries(drag.groupInitial)) {
            batch[k] = clampPartAdjustment({
              dx: init.dx + deltaX,
              dy: init.dy + deltaY,
              scale: init.scale,
            });
          }
          onUpdateMultiplePartAdjustments(batch);
        } else {
          onUpdatePartAdjustment?.(drag.partKey, {
            dx: finalDx,
            dy: finalDy,
            scale: drag.origScale,
          });
        }
      } else {
        setActiveSnapGuides(null);
        const currentDist = Math.max(12, Math.hypot(pt.x - drag.centerX, pt.y - drag.centerY));
        const ratio = currentDist / drag.startDist;
        if (drag.groupInitial && onUpdateMultiplePartAdjustments) {
          const batch: Record<string, PartAdjustment> = {};
          for (const [k, init] of Object.entries(drag.groupInitial)) {
            batch[k] = clampPartAdjustment({
              dx: init.dx,
              dy: init.dy,
              scale: Number((init.scale * ratio).toFixed(2)),
            });
          }
          onUpdateMultiplePartAdjustments(batch);
        } else {
          const nextScale = Number(Math.max(0.4, Math.min(2.5, drag.origScale * ratio)).toFixed(2));
          onUpdatePartAdjustment?.(drag.partKey, {
            dx: drag.origDx,
            dy: drag.origDy,
            scale: nextScale,
          });
        }
      }
      return;
    }

    // Hover cursor affordance
    const parts = getEditableParts(poster.artwork);
    const handleRadius = Math.max(22, poster.artwork.canvas.width * 0.026);
    if (selectedPartKey) {
      const activePart = parts.find(p => getPartKey(p) === selectedPartKey);
      if (activePart) {
        const eff = getEffectivePartBounds(activePart);
        const rx = eff.right + Math.max(4, poster.artwork.canvas.width * 0.006);
        const ry = eff.bottom + Math.max(4, poster.artwork.canvas.width * 0.006);
        if (Math.hypot(pt.x - rx, pt.y - ry) <= handleRadius) {
          if (dragCursor !== 'nwse-resize') setDragCursor('nwse-resize');
          return;
        }
      }
    }
    const pad = Math.max(8, poster.artwork.canvas.width * 0.01);
    const overPart = parts.some(part => {
      const eff = getEffectivePartBounds(part);
      return (
        pt.x >= eff.left - pad &&
        pt.x <= eff.right + pad &&
        pt.y >= eff.top - pad &&
        pt.y <= eff.bottom + pad
      );
    });
    const nextCursor = overPart ? 'grab' : 'default';
    if (dragCursor !== nextCursor) setDragCursor(nextCursor);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragStateRef.current) {
      dragStateRef.current = null;
      setActiveSnapGuides(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragCursor('grab');
    }
  };

  const isExpositorPanel = Boolean(poster.expositorPanel);
  const dims = getFormatDimensionsMm(formatConfig);
  const widthMm = isExpositorPanel ? 297 : dims.width;
  const heightMm = isExpositorPanel ? 420 : dims.height;
  const isLandscape = heightMm < widthMm;

  // Preserva proporção exata nativa da arte PSD caso disponível para evitar bordas vazias
  const nativeAspect = poster.artwork?.canvas?.width && poster.artwork?.canvas?.height
    ? `${poster.artwork.canvas.width} / ${poster.artwork.canvas.height}`
    : `${widthMm} / ${heightMm}`;

  const posterStyle: React.CSSProperties = isPrint
    ? {
        width: `${widthMm}mm`,
        height: `${heightMm}mm`,
      }
    : {
        aspectRatio: nativeAspect,
        width: isLandscape ? 560 : 444,
        height: isLandscape ? Math.round(560 * (heightMm / widthMm)) : Math.round(444 * (heightMm / widthMm)),
        maxWidth: '100%',
        position: 'relative',
      };

  useEffect(() => {
    const canvas = ref.current;
    let cancelled = false;
    let rafId: number | null = null;
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    const schedulePaint = (paintFn: () => void) => {
      if (cancelled) return;
      if (!isPrint && typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          if (!cancelled) paintFn();
        });
      } else {
        paintFn();
      }
    };

    const executeDraw = async () => {
      if (cancelled) return;
      if (canvas && poster.artwork) {
        const dynamicPayload = {
          category: poster.category,
          name: poster.name,
          complement: poster.detail,
          unit: poster.unit,
          hasBoxPrice: poster.hasBoxPrice,
          boxQuantity: poster.boxQuantity,
          boxUnitLabel: poster.boxUnitLabel,
          boxPrice: poster.boxPrice,
          boxPackageType: poster.boxPackageType,
          boxPackageLabel: poster.boxPackageLabel,
          unitBadgeMode: poster.unitBadgeMode,
          productImage: poster.productImage,
          showSurgicalGuides: isPrint ? false : poster.showSurgicalGuides,
          showGrid: isPrint ? false : showGrid,
          selectedPartKey: isPrint ? null : selectedPartKey,
          activeSnapGuides: isPrint ? null : activeSnapGuides,
        };

        const serializableDynamic = {
          category: dynamicPayload.category,
          name: dynamicPayload.name,
          complement: dynamicPayload.complement,
          unit: dynamicPayload.unit,
          hasBoxPrice: dynamicPayload.hasBoxPrice,
          boxQuantity: dynamicPayload.boxQuantity,
          boxUnitLabel: dynamicPayload.boxUnitLabel,
          boxPrice: dynamicPayload.boxPrice,
          boxPackageType: dynamicPayload.boxPackageType,
          boxPackageLabel: dynamicPayload.boxPackageLabel,
          unitBadgeMode: dynamicPayload.unitBadgeMode,
          hasProductImage: Boolean(poster.productImage?.dataUrl),
          productImageBounds: poster.productImage?.bounds,
          showSurgicalGuides: dynamicPayload.showSurgicalGuides,
          showGrid: dynamicPayload.showGrid,
          selectedPartKey: dynamicPayload.selectedPartKey,
          activeSnapGuides: dynamicPayload.activeSnapGuides,
        };

        if (poster.expositorPanel) {
          // Modo Expositor A3: prepara serialização no WebWorker (no preview) e extrai quadrante A3
          const fullW = isPrint ? 3508 : 1754;
          const fullH = isPrint ? 4960 : 2480;
          let preparedPlan: PreparedPosterRenderPlan | undefined;
          if (!isPrint) {
            try {
              preparedPlan = await preparePosterRenderOffThread(
                {
                  artwork: extractSerializableArtwork(poster.artwork),
                  price: poster.price,
                  outputWidth: fullW,
                  outputHeight: fullH,
                  validityText: poster.validityText,
                  dynamicTexts: serializableDynamic,
                },
                abortController?.signal
              );
            } catch {
              if (cancelled) return;
            }
          }
          if (cancelled || !poster.artwork) return;

          schedulePaint(() => {
            if (cancelled || !poster.artwork) return;
            const fullCanvas = document.createElement('canvas');
            void drawImported(
              fullCanvas,
              poster.artwork,
              poster.price,
              fullW,
              fullH,
              poster.validityText,
              dynamicPayload,
              preparedPlan
            )
              .then(() => {
                if (cancelled) return;
                const panels = sliceCanvasIntoA3Panels(fullCanvas, isPrint ? 300 : 150);
                const targetPanel = panels[poster.expositorPanel!.index] || panels[0];
                if (canvas.width !== targetPanel.width) canvas.width = targetPanel.width;
                if (canvas.height !== targetPanel.height) canvas.height = targetPanel.height;
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
          });
        } else {
          // Modo Padrão: gera a 300 DPI proporcional ao formato
          let targetW: number;
          let targetH: number;
          if (isPrint) {
            targetW = Math.round((widthMm / 25.4) * 300);
            targetH = Math.round((heightMm / 25.4) * 300);
          } else if (poster.artwork?.canvas?.width && poster.artwork?.canvas?.height) {
            const artRatio = poster.artwork.canvas.width / poster.artwork.canvas.height;
            const baseH = Math.round(heightMm * 6);
            targetH = baseH;
            targetW = Math.round(baseH * artRatio);
          } else {
            targetW = Math.round(widthMm * 6);
            targetH = Math.round(heightMm * 6);
          }

          let preparedPlan: PreparedPosterRenderPlan | undefined;
          if (!isPrint) {
            try {
              preparedPlan = await preparePosterRenderOffThread(
                {
                  artwork: extractSerializableArtwork(poster.artwork),
                  price: poster.price,
                  outputWidth: targetW,
                  outputHeight: targetH,
                  validityText: poster.validityText,
                  dynamicTexts: serializableDynamic,
                },
                abortController?.signal
              );
            } catch {
              if (cancelled) return;
            }
          }
          if (cancelled || !poster.artwork) return;

          schedulePaint(() => {
            if (cancelled || !poster.artwork) return;
            void drawImported(
              canvas,
              poster.artwork,
              poster.price,
              targetW,
              targetH,
              poster.validityText,
              dynamicPayload,
              preparedPlan
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
          });
        }
      } else {
        onRenderedRef.current?.();
      }
    };

    void executeDraw();

    return () => {
      cancelled = true;
      abortController?.abort();
      if (rafId !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafId);
      }
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
    poster.hasBoxPrice,
    poster.boxQuantity,
    poster.boxUnitLabel,
    poster.boxPrice,
    poster.productImage,
    poster.showSurgicalGuides,
    poster.expositorPanel,
    isPrint,
    widthMm,
    heightMm,
    showGrid,
    selectedPartKey,
    activeSnapGuides,
  ]);

  return (
    <div
      className="poster imported-poster"
      style={posterStyle}
      aria-label={`Prévia da arte PSD em ${getFormatLabel(formatConfig)}`}
    >
      <canvas
        ref={ref}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerUp={interactive ? handlePointerUp : undefined}
        onPointerCancel={interactive ? handlePointerUp : undefined}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
          cursor: interactive ? dragCursor : undefined,
          touchAction: interactive ? 'none' : undefined,
        }}
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
