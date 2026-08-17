import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

export interface DragPosition {
  x: number;
  y: number;
}

interface UseDraggableOptions {
  onDragEnd?: (position: DragPosition) => void;
}

/**
 * 拖拽 hook：通过 rAF 节流 + 直接操作 DOM style，拖拽过程中不触发 React 渲染，
 * 仅在拖拽结束时回调 onDragEnd（用于持久化位置）。
 */
export function useDraggable<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: UseDraggableOptions = {},
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const element = ref.current;
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const originLeft = rect.left;
      const originTop = rect.top;
      const handle = event.currentTarget as HTMLElement;
      let rafId: number | null = null;

      event.preventDefault();

      const onPointerMove = (ev: globalThis.PointerEvent) => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const maxX = Math.max(0, window.innerWidth - rect.width);
          const maxY = Math.max(0, window.innerHeight - 24);
          const x = Math.min(Math.max(0, originLeft + ev.clientX - startX), maxX);
          const y = Math.min(Math.max(0, originTop + ev.clientY - startY), maxY);
          element.style.left = `${x}px`;
          element.style.top = `${y}px`;
        });
      };

      const onPointerUp = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        handle.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        optionsRef.current.onDragEnd?.({
          x: parseFloat(element.style.left) || originLeft,
          y: parseFloat(element.style.top) || originTop,
        });
      };

      handle.style.cursor = "grabbing";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [ref],
  );

  return { onPointerDown };
}
