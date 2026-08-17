import { useCallback } from "react";
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import Decimal from "decimal.js";
import { findPoolByMints } from "@/lib/raydium-clmm/pool";
import { getQuote } from "@/lib/raydium-clmm/quote";
import { buildSwapTransaction } from "@/lib/raydium-clmm/swap";
import { DEFAULT_SLIPPAGE, WSOL_MINT } from "@/lib/raydium-clmm/constants";

const RPC_URL = import.meta.env.VITE_HELIUS_RPC_URL as string;

/** 查询 mint 所属的 token 程序（SPL 或 Token-2022） */
async function getTokenProgramForMint(mint: PublicKey): Promise<PublicKey> {
  if (mint.equals(WSOL_MINT)) return TOKEN_PROGRAM_ID;
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint.toBase58(), { encoding: "base64" }],
    }),
  });
  const json = await res.json();
  const owner = json.result?.value?.owner;
  if (!owner) throw new Error(`Mint not found: ${mint.toBase58()}`);
  return new PublicKey(owner);
}

export const useTrade = (tokenAddress: string, tokenAtomicBalance: Decimal) => {
  const createTransaction = useCallback(
    async (params: {
      direction: "buy" | "sell";
      value: number;
      signer: PublicKey;
    }): Promise<VersionedTransaction> => {
      const { direction, value, signer } = params;

      // 原子单位金额：buy 为 SOL lamports，sell 为 token 余额百分比
      let atomicAmount: bigint;
      if (direction === "buy") {
        atomicAmount = BigInt(Math.round(value * LAMPORTS_PER_SOL));
      } else {
        atomicAmount = BigInt(tokenAtomicBalance.mul(value).div(100).toFixed(0));
      }
      if (atomicAmount <= 0n) {
        throw new Error("Amount must be greater than 0");
      }

      const tokenMint = new PublicKey(tokenAddress);
      const inputMint = direction === "buy" ? WSOL_MINT : tokenMint;
      const outputMint = direction === "buy" ? tokenMint : WSOL_MINT;

      // 1. 查找该 token 的 Raydium CLMM 池子
      const found = await findPoolByMints(RPC_URL, tokenMint, WSOL_MINT);
      if (!found) {
        throw new Error("No Raydium CLMM pool found for this token");
      }

      // 2. 报价（链上 tick-by-tick 模拟）
      const quote = await getQuote({
        rpc: RPC_URL,
        poolPubkey: found.pubkey,
        inputMint,
        outputMint,
        inputAmount: atomicAmount,
      });

      // 3. 滑点保护后的最小输出金额
      const slippageBps = BigInt(Math.round((1 - DEFAULT_SLIPPAGE) * 10000));
      const minimumOutputAmount = (quote.outputAmount * slippageBps) / 10000n;

      // 4. 用户 token 账户（ATA，需按 mint 所属 token 程序派生）
      const inputTokenProgram = await getTokenProgramForMint(inputMint);
      const outputTokenProgram = await getTokenProgramForMint(outputMint);
      const userInputTokenAccount = getAssociatedTokenAddressSync(inputMint, signer, false, inputTokenProgram);
      const userOutputTokenAccount = getAssociatedTokenAddressSync(outputMint, signer, false, outputTokenProgram);

      // 5. 构造交易（含 SOL wrap/unwrap 与 tick arrays 收集）
      return buildSwapTransaction(RPC_URL, {
        payer: signer,
        inputMint,
        outputMint,
        inputAmount: atomicAmount,
        minimumOutputAmount,
        poolPubkey: found.pubkey,
        userInputTokenAccount,
        userOutputTokenAccount,
        endTick: quote.tickAfter,
        inputTokenProgram,
        outputTokenProgram,
      });
    },
    [tokenAddress, tokenAtomicBalance],
  );

  return { createTransaction };
};
