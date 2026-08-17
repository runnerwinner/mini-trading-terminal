import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

export interface ResizeSize {
  width: number;
  height: number;
}

interface UseResizableOptions {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  onResizeEnd?: (size: ResizeSize) => void;
}

/**
 * 调整大小 hook：右下角拖拽调整宽高。
 * 通过 rAF 节流 + 直接操作 DOM style，调整过程中不触发 React 渲染。
 */
export function useResizable<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: UseResizableOptions = {},
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
      const startWidth = rect.width;
      const startHeight = rect.height;
      const handle = event.currentTarget as HTMLElement;
      let rafId: number | null = null;

      event.preventDefault();
      event.stopPropagation();

      const onPointerMove = (ev: globalThis.PointerEvent) => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const opts = optionsRef.current;
          const width = Math.min(
            Math.max(startWidth + ev.clientX - startX, opts.minWidth ?? 320),
            opts.maxWidth ?? window.innerWidth,
          );
          const height = Math.min(
            Math.max(startHeight + ev.clientY - startY, opts.minHeight ?? 360),
            opts.maxHeight ?? window.innerHeight,
          );
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
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
        optionsRef.current.onResizeEnd?.({
          width: parseFloat(element.style.width) || startWidth,
          height: parseFloat(element.style.height) || startHeight,
        });
      };

      handle.style.cursor = "nwse-resize";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [ref],
  );

  return { onPointerDown };
}
