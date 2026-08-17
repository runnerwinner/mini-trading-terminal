import { memo, useCallback, useRef, useState } from "react";
import { X, Zap } from "lucide-react";
import { EnhancedToken } from "@codex-data/sdk/dist/sdk/generated/graphql";
import { TradeForm } from "@/components/TradeForm";
import { useTradePanel } from "@/contexts/trade-panel-context";
import { useDraggable } from "@/hooks/use-draggable";
import type { DragPosition } from "@/hooks/use-draggable";
import { useResizable } from "@/hooks/use-resizable";
import type { ResizeSize } from "@/hooks/use-resizable";

const STORAGE_KEY = "floating-trade-panel";
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 500;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 420;

interface PanelState {
  x: number;
  y: number;
  width: number;
  height: number;
}

function loadPanelState(): PanelState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PanelState;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number"
    ) {
      return parsed;
    }
  } catch {
    // 忽略损坏的持久化数据
  }
  return null;
}

function persistPanelState(state: PanelState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 忽略存储错误
  }
}

function getInitialState(): PanelState {
  const saved = loadPanelState();
  if (saved) return saved;
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: Math.max(0, window.innerWidth - DEFAULT_WIDTH - 24),
    y: Math.max(0, window.innerHeight - DEFAULT_HEIGHT - 24),
  };
}

function TradingConfigMissing() {
  return (
    <p className="text-sm text-muted-foreground">
      Trading requires VITE_SOLANA_PRIVATE_KEY, VITE_HELIUS_RPC_URL and
      VITE_JUPITER_REFERRAL_ACCOUNT to be configured in environment variables.
    </p>
  );
}

/**
 * 悬浮即时交易面板：
 * - 标题栏可拖拽移动，右下角可调整大小（rAF 节流 + 直接 DOM 操作，不触发渲染）
 * - 位置与尺寸持久化到 localStorage
 * - 内部复用 TradeForm，买卖方向与 Context 同步
 */
export const FloatingTradePanel = memo(function FloatingTradePanel({
  token,
}: {
  token: EnhancedToken;
}) {
  const { close, direction, setDirection } = useTradePanel();
  const [initial] = useState<PanelState>(getInitialState);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const handleDragEnd = useCallback(
    (position: DragPosition) => {
      const el = panelRef.current;
      persistPanelState({
        x: position.x,
        y: position.y,
        width: parseFloat(el?.style.width ?? "") || initial.width,
        height: parseFloat(el?.style.height ?? "") || initial.height,
      });
    },
    [initial],
  );

  const handleResizeEnd = useCallback(
    (size: ResizeSize) => {
      const el = panelRef.current;
      persistPanelState({
        x: parseFloat(el?.style.left ?? "") || initial.x,
        y: parseFloat(el?.style.top ?? "") || initial.y,
        width: size.width,
        height: size.height,
      });
    },
    [initial],
  );

  const drag = useDraggable(panelRef, { onDragEnd: handleDragEnd });
  const resize = useResizable(panelRef, {
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    onResizeEnd: handleResizeEnd,
  });

  const tradingEnabled = Boolean(
    import.meta.env.VITE_SOLANA_PRIVATE_KEY &&
      import.meta.env.VITE_HELIUS_RPC_URL &&
      import.meta.env.VITE_JUPITER_REFERRAL_ACCOUNT,
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Instant trade panel"
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      style={{
        width: initial.width,
        height: initial.height,
        left: initial.x,
        top: initial.y,
        touchAction: "none",
        willChange: "left, top, width, height",
      }}
    >
      {/* 拖拽标题栏 */}
      <div
        {...drag}
        title="Drag to move"
        className="flex h-11 shrink-0 cursor-grab select-none items-center gap-2 border-b border-border bg-muted/40 px-3"
      >
        <Zap className="h-4 w-4 text-yellow-500" />
        <span className="text-sm font-semibold">Instant Trade</span>
        {token.symbol && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {token.symbol}
          </span>
        )}
        <button
          type="button"
          onClick={close}
          aria-label="Close trade panel"
          className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {tradingEnabled ? (
          <TradeForm
            token={token}
            direction={direction}
            onDirectionChange={setDirection}
          />
        ) : (
          <TradingConfigMissing />
        )}
      </div>

      {/* 右下角调整大小把手 */}
      <div
        {...resize}
        className="absolute bottom-0 right-0 z-10 h-5 w-5 cursor-se-resize"
        aria-hidden="true"
      >
        <span className="absolute bottom-1 right-1 block h-2.5 w-2.5 rounded-br-sm border-b-2 border-r-2 border-muted-foreground/60" />
      </div>
    </div>
  );
});
