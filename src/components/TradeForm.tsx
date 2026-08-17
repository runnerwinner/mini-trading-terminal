import { memo, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EnhancedToken } from "@codex-data/sdk/dist/sdk/generated/graphql";
import { useBalance } from "@/hooks/use-balance";
import { useTrade } from "@/hooks/use-trade";
import { confirmTransaction, createConnection, createKeypair, sendTransaction, signTransaction } from "@/lib/solana";

export type TradeDirection = "buy" | "sell";

interface TradeFormProps {
  token: EnhancedToken;
  /** 受控方向（不传则内部管理） */
  direction?: TradeDirection;
  onDirectionChange?: (direction: TradeDirection) => void;
}

const SOL_BUY_AMOUNT_PRESETS = [0.0001, 0.001, 0.01, 0.1];
const SELL_PERCENTAGE_PRESETS = [25, 50, 75, 100];

/**
 * 可复用的买卖表单：余额展示 + Buy/Sell 切换 + 金额/百分比输入 + 提交。
 * 挂载在 `memo` 中，父组件渲染不会影响本组件（除非 token/方向变化）。
 */
export const TradeForm = memo(function TradeForm({
  token,
  direction: controlledDirection,
  onDirectionChange,
}: TradeFormProps) {
  const [localDirection, setLocalDirection] = useState<TradeDirection>("buy");
  const [buyAmount, setBuyAmount] = useState("");
  const [sellPercentage, setSellPercentage] = useState("");

  const direction = controlledDirection ?? localDirection;
  const setDirection = onDirectionChange ?? setLocalDirection;

  const tokenSymbol = token.symbol;
  const { nativeBalance: solanaBalance, tokenBalance, tokenAtomicBalance, loading, refreshBalance } = useBalance(
    token.address,
    Number(token.decimals),
    9,
    Number(token.networkId),
  );
  const { createTransaction } = useTrade(token.address, tokenAtomicBalance);

  // 缓存 keypair / connection，避免每次渲染重建导致 handleTrade 引用变化
  const keypair = useMemo(() => createKeypair(import.meta.env.VITE_SOLANA_PRIVATE_KEY), []);
  const connection = useMemo(() => createConnection(), []);

  const handleTrade = useCallback(async () => {
    const toastId = toast.loading("Submitting trade request...");
    try {
      // 链上实时余额校验（比 Codex 显示更可靠），避免 RPC 返回晦涩错误
      const GAS_BUFFER_SOL = 0.01; // 覆盖交易费 + ATA 创建 rent
      const onChainSolBalance = (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL;
      if (onChainSolBalance <= 0) {
        throw new Error(
          `交易钱包 ${keypair.publicKey.toBase58()} 的 SOL 余额为 0，无法支付 gas 与转账费用。请先向该地址充值 SOL 后再交易。`,
        );
      }
      if (direction === "buy") {
        const buyValue = parseFloat(buyAmount) || 0;
        if (onChainSolBalance < buyValue + GAS_BUFFER_SOL) {
          throw new Error(
            `交易钱包 SOL 余额不足（${onChainSolBalance.toFixed(6)} SOL）。本次买入需 ${buyValue.toFixed(4)} SOL，另需约 ${GAS_BUFFER_SOL} SOL 支付 gas 与账户创建费。请先向 ${keypair.publicKey.toBase58()} 充值。`,
          );
        }
      } else if (onChainSolBalance < GAS_BUFFER_SOL) {
        throw new Error(
          `交易钱包 SOL 余额不足（${onChainSolBalance.toFixed(6)} SOL），卖出至少需要约 ${GAS_BUFFER_SOL} SOL 支付 gas。请先向 ${keypair.publicKey.toBase58()} 充值。`,
        );
      }

      const transaction = await createTransaction({
        direction,
        value: direction === "buy" ? parseFloat(buyAmount) : parseFloat(sellPercentage),
        signer: keypair.publicKey,
      });

      toast.loading("Signing transaction...", { id: toastId });
      const signedTransaction = signTransaction(keypair, transaction);

      toast.loading("Sending transaction...", { id: toastId });
      const signature = await sendTransaction(signedTransaction, connection);

      toast.loading("Confirming transaction...", { id: toastId });
      const confirmation = await confirmTransaction(signature, connection);

      if (confirmation.value.err) {
        throw new Error("Trade failed");
      }
      toast.success(`Trade successful! TX: ${signature.slice(0, 8)}...`, { id: toastId });

      // Refresh balance after 1 second
      setTimeout(refreshBalance, 1000);
    } catch (error) {
      const raw = (error as Error).message;
      // 将常见 RPC 模拟错误映射为可读的中文提示
      let message = raw;
      if (/Attempt to debit an account but found no record of a prior credit/.test(raw)) {
        message = "交易失败：代币账户余额不足（SPL 转账源账户没有足够余额）。请确认钱包 SOL / 代币余额充足后重试。";
      } else if (/insufficient lamports|insufficient funds|AccountNotFound|account not found/.test(raw)) {
        message = "交易失败：账户余额不足或账户不存在。请确认钱包 SOL 余额充足（含 gas 与账户创建费）后重试。";
      }
      toast.error(message, { id: toastId });
    }
  }, [direction, buyAmount, sellPercentage, createTransaction, keypair, connection, refreshBalance]);

  const submitDisabled =
    loading ||
    (direction === "buy" && (!buyAmount || parseFloat(buyAmount) <= 0)) ||
    (direction === "sell" && (!sellPercentage || parseFloat(sellPercentage) <= 0));

  return (
    <div className="space-y-4">
      <div className="flex justify-between p-3 bg-muted/30 rounded-lg">
        <span className="text-sm text-muted-foreground">SOL Balance:</span>
        <span className="font-semibold">{solanaBalance.toFixed(4)} SOL</span>
      </div>

      {tokenSymbol && (
        <div className="flex justify-between p-3 bg-muted/30 rounded-lg">
          <span className="text-sm text-muted-foreground">{tokenSymbol} Balance:</span>
          <span className="font-semibold">{tokenBalance.toLocaleString()} {tokenSymbol}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setDirection("buy")}
          className={cn(
            "flex-1 py-2 px-4 rounded-lg font-medium transition-all",
            direction === "buy"
              ? "bg-green-500/20 text-green-500 border border-green-500/50"
              : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
          )}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => setDirection("sell")}
          className={cn(
            "flex-1 py-2 px-4 rounded-lg font-medium transition-all",
            direction === "sell"
              ? "bg-red-500/20 text-red-500 border border-red-500/50"
              : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
          )}
        >
          Sell
        </button>
      </div>

      {direction === "buy" ? (
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">Amount in SOL</label>
          <div className="flex gap-2">
            {SOL_BUY_AMOUNT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setBuyAmount(preset.toString())}
                className={cn(
                  "flex-1 py-1.5 px-2 rounded-md text-sm font-medium transition-all",
                  buyAmount === preset.toString()
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                )}
              >
                {preset}
              </button>
            ))}
          </div>
          <Input
            type="number"
            placeholder="0.00"
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
            min="0"
            step="0.01"
          />
          <div className="text-xs text-muted-foreground">
            Available: {solanaBalance.toFixed(4)} SOL
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="text-sm text-muted-foreground">Sell Percentage</label>
          <div className="flex gap-2">
            {SELL_PERCENTAGE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setSellPercentage(preset.toString())}
                className={cn(
                  "flex-1 py-1.5 px-2 rounded-md text-sm font-medium transition-all",
                  sellPercentage === preset.toString()
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                )}
              >
                {preset}%
              </button>
            ))}
          </div>
          <Input
            type="number"
            placeholder="0"
            value={sellPercentage}
            onChange={(e) => setSellPercentage(e.target.value)}
            min="0"
            max="100"
            step="1"
          />
          {sellPercentage && tokenBalance > 0 && (
            <div className="text-xs text-muted-foreground">
              Selling: {((tokenBalance * parseFloat(sellPercentage)) / 100).toLocaleString()} {tokenSymbol}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={handleTrade}
        disabled={submitDisabled}
        className={cn(
          "w-full py-3 px-4 rounded-lg font-semibold transition-all",
          direction === "buy"
            ? "bg-green-500 hover:bg-green-600 text-white disabled:bg-green-500/30 disabled:text-green-500/50"
            : "bg-red-500 hover:bg-red-600 text-white disabled:bg-red-500/30 disabled:text-red-500/50",
          "disabled:cursor-not-allowed"
        )}
      >
        {direction === "buy" ? "Buy" : "Sell"} {tokenSymbol || "Token"}
      </button>
    </div>
  );
});
