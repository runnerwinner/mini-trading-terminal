import { PublicKey } from "@solana/web3.js";
import {
  TICK_ARRAY_SIZE,
  MIN_SQRT_PRICE_X64,
  MAX_SQRT_PRICE_X64,
} from "./constants";
import {
  parsePoolState,
  parseTickArray,
  parseAmmConfig,
  ParsedPoolState,
  ParsedAmmConfig,
  ParsedTickState,
} from "./layout";
import { computeSwap, getSqrtPriceAtTick, getTickAtSqrtPrice } from "./math";
import {
  getArrayStartIndex,
  deriveTickArrayAddress,
} from "./pool";

/** 通过 RPC 拉取账户原始数据 */
async function fetchAccountData(rpc: string, pubkey: PublicKey): Promise<Buffer | null> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [pubkey.toBase58(), { encoding: "base64" }],
  };
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const value = json.result?.value;
  if (!value || !value.data || !value.data[0]) return null;
  return Buffer.from(value.data[0], "base64");
}

/** getMultipleAccounts 单次最多允许的地址数 */
const MAX_ACCOUNTS_PER_REQUEST = 100;

/** 批量拉取账户数据（自动分块） */
export async function fetchAccountsData(
  rpc: string,
  pubkeys: PublicKey[],
): Promise<(Buffer | null)[]> {
  if (pubkeys.length === 0) return [];
  const results: (Buffer | null)[] = new Array(pubkeys.length).fill(null);

  for (let i = 0; i < pubkeys.length; i += MAX_ACCOUNTS_PER_REQUEST) {
    const chunk = pubkeys.slice(i, i + MAX_ACCOUNTS_PER_REQUEST);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [chunk.map((p) => p.toBase58()), { encoding: "base64" }],
    };
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const values = (json.result?.value ?? []) as Array<{ data?: [string, string] } | null>;
    for (let j = 0; j < values.length; j++) {
      const v = values[j];
      results[i + j] = v && v.data && v.data[0] ? Buffer.from(v.data[0], "base64") : null;
    }
  }

  return results;
}

/** 加载 AmmConfig（手续费率） */
export async function loadAmmConfig(rpc: string, ammConfigPubkey: PublicKey): Promise<ParsedAmmConfig> {
  const data = await fetchAccountData(rpc, ammConfigPubkey);
  if (!data) throw new Error(`AmmConfig not found: ${ammConfigPubkey.toBase58()}`);
  return parseAmmConfig(data);
}

/** 加载 PoolState */
export async function loadPoolState(rpc: string, poolPubkey: PublicKey): Promise<ParsedPoolState> {
  const data = await fetchAccountData(rpc, poolPubkey);
  if (!data) throw new Error(`PoolState not found: ${poolPubkey.toBase58()}`);
  return parsePoolState(data);
}

/**
 * 报价请求参数
 */
export interface QuoteParams {
  rpc: string;
  poolPubkey: PublicKey;
  /** 输入代币 mint（token 或 SOL） */
  inputMint: PublicKey;
  /** 输出代币 mint */
  outputMint: PublicKey;
  /** 输入金额（原始单位） */
  inputAmount: bigint;
  /** 可选：手动指定价格限制（默认全程扫盘） */
  sqrtPriceLimit?: bigint;
}

/**
 * 报价结果
 */
export interface QuoteResult {
  /** 输出金额（原始单位） */
  outputAmount: bigint;
  /** 成交后 sqrt_price */
  sqrtPriceAfter: bigint;
  /** 成交后 tick */
  tickAfter: number;
  /** 输入代币为 token0 时为 true */
  zeroForOne: boolean;
  /** 预估滑点后的最小输出（1% 滑点，用于展示） */
  minimumOutput: bigint;
}

/**
 * 在 CLMM 池子上模拟一次 swap（tick-by-tick，复刻链上 swap_internal + compute_swap）。
 * 仅做本地报价，不提交交易。
 */
export async function getQuote(params: QuoteParams): Promise<QuoteResult> {
  const { rpc, poolPubkey, inputMint, outputMint, inputAmount } = params;
  const pool = await loadPoolState(rpc, poolPubkey);

  const zeroForOne = pool.tokenMint0.equals(inputMint) && pool.tokenMint1.equals(outputMint);
  if (!zeroForOne && !(pool.tokenMint1.equals(inputMint) && pool.tokenMint0.equals(outputMint))) {
    throw new Error("mints do not match pool");
  }

  const ammConfig = await loadAmmConfig(rpc, pool.ammConfig);
  const tradeFeeRate = BigInt(ammConfig.tradeFeeRate);
  const sqrtPriceLimit = params.sqrtPriceLimit ?? (zeroForOne ? MIN_SQRT_PRICE_X64 : MAX_SQRT_PRICE_X64);

  const { outputAmount, sqrtPriceAfter, tickAfter } = await simulateSwap({
    pool,
    poolPubkey,
    tradeFeeRate,
    inputAmount,
    zeroForOne,
    sqrtPriceLimit,
    tickSpacing: pool.tickSpacing,
    rpc,
  });

  return {
    outputAmount,
    sqrtPriceAfter,
    tickAfter,
    zeroForOne,
    minimumOutput: (outputAmount * 9900n) / 10000n,
  };
}

interface SimulateState {
  tickCurrent: number;
  sqrtPriceX64: bigint;
  liquidity: bigint;
  amountRemaining: bigint;
  amountCalculated: bigint;
  feeAmount: bigint;
}

/**
 * tick-by-tick 模拟 swap 主循环
 * 复刻 raydium-clmm swap_internal 的流动性消耗逻辑（不含 limit order / 动态费用细化）
 */
export async function simulateSwap(params: {
  pool: ParsedPoolState;
  poolPubkey: PublicKey;
  tradeFeeRate: bigint;
  inputAmount: bigint;
  zeroForOne: boolean;
  sqrtPriceLimit: bigint;
  tickSpacing: number;
  rpc: string;
}): Promise<{ outputAmount: bigint; sqrtPriceAfter: bigint; tickAfter: number }> {
  const { pool, poolPubkey, tradeFeeRate, inputAmount, zeroForOne, sqrtPriceLimit, tickSpacing, rpc } = params;

  const state: SimulateState = {
    tickCurrent: pool.tickCurrent,
    sqrtPriceX64: pool.sqrtPriceX64,
    liquidity: pool.liquidity,
    amountRemaining: inputAmount,
    amountCalculated: 0n,
    feeAmount: 0n,
  };

  // 当前 tick 所在的 tick array start index
  const currentArrayStart = getArrayStartIndex(state.tickCurrent, tickSpacing);
  // 缓存的 tick array 数据（避免重复拉取）
  const arrayCache = new Map<number, { startTickIndex: number; ticks: { tick: number; liquidityNet: bigint; liquidityGross: bigint }[] }>();
  let arrayStartIndex = currentArrayStart;

  const loadArray = async (start: number) => {
    if (arrayCache.has(start)) return arrayCache.get(start)!;
    const addr = deriveTickArrayAddress(poolPubkey, start);
    const data = await fetchAccountData(rpc, addr);
    if (!data || data.length < 10240) {
      const empty = { startTickIndex: start, ticks: [] as ParsedTickState[] };
      arrayCache.set(start, empty);
      return empty;
    }
    const parsed = parseTickArray(data);
    arrayCache.set(start, { startTickIndex: start, ticks: parsed.ticks });
    return arrayCache.get(start)!;
  };

  let guard = 0;
  while (state.amountRemaining > 0n && state.sqrtPriceX64 !== sqrtPriceLimit && guard++ < 1000) {
    // 边界检查（复刻 tick_math::MIN_TICK / MAX_TICK）
    if (zeroForOne && state.tickCurrent <= -443636) break;
    if (!zeroForOne && state.tickCurrent >= 443636) break;

    // 当前 tick array
    const arr = await loadArray(arrayStartIndex);
    if (arr.ticks.length === 0) {
      // tick array 未初始化或不存在：直接跳到下一个 array（价格边界）
      // 复刻 swap_internal：target price 为 array 末端价格
      const targetTick = zeroForOne
        ? arr.startTickIndex - tickSpacing
        : arr.startTickIndex + TICK_ARRAY_SIZE * tickSpacing;
      const targetPrice = getSqrtPriceAtTick(targetTick);
      const targetPriceClamped =
        zeroForOne && targetPrice < sqrtPriceLimit ? sqrtPriceLimit :
        !zeroForOne && targetPrice > sqrtPriceLimit ? sqrtPriceLimit : targetPrice;

      const result = computeSwap(
        state.sqrtPriceX64,
        targetPriceClamped,
        state.liquidity,
        state.amountRemaining,
        tradeFeeRate,
        true,
        zeroForOne,
        true,
      );

      state.sqrtPriceX64 = result.sqrtPriceNextX64;
      state.amountRemaining -= result.amountIn;
      state.amountCalculated += result.amountOut;
      state.feeAmount += result.feeAmount;

      if (result.sqrtPriceNextX64 === targetPriceClamped) {
        // 抵达 array 边界，推进到下一个 array
        if (zeroForOne) {
          arrayStartIndex -= TICK_ARRAY_SIZE * tickSpacing;
        } else {
          arrayStartIndex += TICK_ARRAY_SIZE * tickSpacing;
        }
        state.tickCurrent = targetTick;
      } else {
        break; // 输入耗尽
      }
      continue;
    }

    // 在当前 tick array 内找 next initialized tick（有流动性的 tick）
    const arrTicks = arr.ticks;
    const idx = getArrayIndexForTick(arr.startTickIndex, state.tickCurrent, tickSpacing);
    let nextTick: { tick: number; liquidityNet: bigint } | null = null;
    if (zeroForOne) {
      // 向下找（tick 递减），包含当前 index 之下的所有已初始化 tick
      for (let i = idx; i >= 0; i--) {
        const t = arrTicks[i];
        if (t.liquidityGross > 0n) {
          nextTick = { tick: t.tick, liquidityNet: t.liquidityNet };
          break;
        }
      }
    } else {
      for (let i = idx + 1; i < TICK_ARRAY_SIZE; i++) {
        const t = arrTicks[i];
        if (t.liquidityGross > 0n) {
          nextTick = { tick: t.tick, liquidityNet: t.liquidityNet };
          break;
        }
      }
    }

    let targetTick: number;
    let crossedTick: { tick: number; liquidityNet: bigint } | null = null;
    if (nextTick) {
      targetTick = nextTick.tick;
      crossedTick = nextTick;
    } else {
      // array 内无流动性 tick，目标为 array 末端价格
      targetTick = zeroForOne
        ? arr.startTickIndex
        : arr.startTickIndex + TICK_ARRAY_SIZE * tickSpacing - tickSpacing;
    }

    let targetPrice = getSqrtPriceAtTick(targetTick);
    // 价格限制（滑点保护）
    if (zeroForOne && targetPrice < sqrtPriceLimit) targetPrice = sqrtPriceLimit;
    if (!zeroForOne && targetPrice > sqrtPriceLimit) targetPrice = sqrtPriceLimit;

    const result = computeSwap(
      state.sqrtPriceX64,
      targetPrice,
      state.liquidity,
      state.amountRemaining,
      tradeFeeRate,
      true,
      zeroForOne,
      true,
    );

    state.sqrtPriceX64 = result.sqrtPriceNextX64;
    state.amountRemaining -= result.amountIn;
    state.amountCalculated += result.amountOut;
    state.feeAmount += result.feeAmount;

    if (result.sqrtPriceNextX64 === targetPrice && crossedTick) {
      // 跨越 tick：更新流动性
      state.tickCurrent = crossedTick.tick;
      state.liquidity =
        zeroForOne
          ? state.liquidity - crossedTick.liquidityNet
          : state.liquidity + crossedTick.liquidityNet;
    } else if (result.sqrtPriceNextX64 === targetPrice) {
      // 抵达 array 边界
      state.tickCurrent = targetTick;
      if (zeroForOne) {
        arrayStartIndex -= TICK_ARRAY_SIZE * tickSpacing;
      } else {
        arrayStartIndex += TICK_ARRAY_SIZE * tickSpacing;
      }
    } else {
      state.tickCurrent = getTickAtSqrtPrice(state.sqrtPriceX64);
      break; // 输入耗尽
    }
  }

  return {
    outputAmount: state.amountCalculated,
    sqrtPriceAfter: state.sqrtPriceX64,
    tickAfter: state.tickCurrent,
  };
}

function getArrayIndexForTick(arrayStart: number, tick: number, tickSpacing: number): number {
  return Math.floor((tick - arrayStart) / tickSpacing);
}
