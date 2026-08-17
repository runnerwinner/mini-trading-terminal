import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type TradeDirection = "buy" | "sell";

interface TradePanelContextValue {
  /** 面板是否显示 */
  isOpen: boolean;
  /** 当前买卖方向 */
  direction: TradeDirection;
  setDirection: (direction: TradeDirection) => void;
  /** 开关面板 */
  toggle: () => void;
  /** 关闭面板 */
  close: () => void;
}

const TradePanelContext = createContext<TradePanelContextValue | null>(null);

export function TradePanelProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [direction, setDirection] = useState<TradeDirection>("buy");

  const toggle = useCallback(() => setIsOpen((open) => !open), []);
  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo(
    () => ({ isOpen, direction, setDirection, toggle, close }),
    [isOpen, direction, toggle, close],
  );

  return (
    <TradePanelContext.Provider value={value}>{children}</TradePanelContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTradePanel(): TradePanelContextValue {
  const context = useContext(TradePanelContext);
  if (!context) {
    throw new Error("useTradePanel must be used within a TradePanelProvider");
  }
  return context;
}
