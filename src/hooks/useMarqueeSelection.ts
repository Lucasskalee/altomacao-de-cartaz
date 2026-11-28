import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

export type MarqueeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

export type MarqueeBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function normalizeMarqueeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): MarqueeRect {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const right = Math.max(startX, endX);
  const bottom = Math.max(startY, endY);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function rectsIntersect(a: MarqueeBounds, b: MarqueeBounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/**
 * Pure helper computing the next selected ID set given item bounding boxes
 * and the active marquee rectangle.
 */
export function computeMarqueeSelection(
  items: { id: string; bounds: MarqueeBounds }[],
  marquee: MarqueeBounds,
  baseSelection: Set<string>,
  additive: boolean
): Set<string> {
  const next = additive ? new Set<string>(baseSelection) : new Set<string>();
  for (const item of items) {
    if (rectsIntersect(marquee, item.bounds)) {
      next.add(item.id);
    }
  }
  return next;
}

const INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a',
  'label',
  '[contenteditable="true"]',
  '[data-no-marquee="true"]',
  '.modal-backdrop',
  '.sk-floating-action-bar',
  '.sk-lib-batch-dock',
  '.sk-batch-bar',
  '.sk-canvas-toolbar',
  '.editor-document-bar',
  '.sk-lib-sidebar',
  '.offer-preview-box',
].join(', ');

const DRAG_THRESHOLD_PX = 6;

export type UseMarqueeSelectionOptions = {
  containerRef: RefObject<HTMLElement | null>;
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  itemAttribute?: string;
  enabled?: boolean;
};

export function useMarqueeSelection({
  containerRef,
  selectedIds,
  onSelectionChange,
  itemAttribute = 'data-marquee-id',
  enabled = true,
}: UseMarqueeSelectionOptions) {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const dragStateRef = useRef<{
    active: boolean;
    started: boolean;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    additive: boolean;
    baseSelection: Set<string>;
  } | null>(null);

  const rafRef = useRef<number | null>(null);

  const cancelActiveDrag = useCallback(() => {
    dragStateRef.current = null;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setIsDragging(false);
    setMarqueeRect(null);
  }, []);

  useEffect(() => {
    if (!enabled && dragStateRef.current) {
      cancelActiveDrag();
    }
  }, [enabled, cancelActiveDrag]);

  const updateSelectionFromPointer = useCallback(
    (startX: number, startY: number, currentX: number, currentY: number, baseSelection: Set<string>, additive: boolean) => {
      const rect = normalizeMarqueeRect(startX, startY, currentX, currentY);
      setMarqueeRect(rect);

      const container = containerRef.current;
      if (!container) return;

      const nodes = container.querySelectorAll<HTMLElement>(`[${itemAttribute}]`);
      const items: { id: string; bounds: MarqueeBounds }[] = [];
      nodes.forEach(node => {
        if (node.closest('[hidden]')) return;
        const id = node.getAttribute(itemAttribute);
        if (!id) return;
        const r = node.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        items.push({
          id,
          bounds: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        });
      });

      const next = computeMarqueeSelection(items, rect, baseSelection, additive);
      onSelectionChangeRef.current(next);
    },
    [containerRef, itemAttribute]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st || !st.active) return;

      st.currentX = e.clientX;
      st.currentY = e.clientY;

      if (!st.started) {
        const dist = Math.hypot(st.currentX - st.startX, st.currentY - st.startY);
        if (dist < DRAG_THRESHOLD_PX) return;
        st.started = true;
        setIsDragging(true);
        if (typeof window !== 'undefined') {
          window.getSelection()?.removeAllRanges();
        }
      }

      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const active = dragStateRef.current;
        if (!active || !active.active || !active.started) return;

        // Gentle auto-scroll when dragging near top/bottom of scrollable container
        const container = containerRef.current;
        if (container) {
          const cRect = container.getBoundingClientRect();
          const edge = 28;
          const prevScrollTop = container.scrollTop;
          if (active.currentY < cRect.top + edge && container.scrollTop > 0) {
            container.scrollTop -= 12;
          } else if (
            active.currentY > cRect.bottom - edge &&
            container.scrollTop + container.clientHeight < container.scrollHeight
          ) {
            container.scrollTop += 12;
          }
          const scrollDelta = container.scrollTop - prevScrollTop;
          if (scrollDelta !== 0) {
            active.startY -= scrollDelta;
          }
        }

        updateSelectionFromPointer(
          active.startX,
          active.startY,
          active.currentX,
          active.currentY,
          active.baseSelection,
          active.additive
        );
      });
    };

    const stopDragging = () => {
      const st = dragStateRef.current;
      if (!st) return;
      const hadStarted = st.started;
      dragStateRef.current = null;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (hadStarted) {
        setIsDragging(false);
        setMarqueeRect(null);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('blur', stopDragging);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('blur', stopDragging);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [containerRef, updateSelectionFromPointer]);

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!enabled || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(INTERACTIVE_SELECTOR)) return;

      dragStateRef.current = {
        active: true,
        started: false,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        additive: e.ctrlKey || e.metaKey || e.shiftKey,
        baseSelection: new Set(selectedIdsRef.current),
      };
    },
    [enabled]
  );

  return {
    marqueeRect,
    isDragging,
    handleMouseDown,
  };
}
