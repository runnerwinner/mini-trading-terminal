import {
  MIN_SQRT_PRICE_X64,
  MAX_SQRT_PRICE_X64,
  MAX_TICK,
  MIN_TICK,
  FEE_RATE_DENOMINATOR,
} from "./constants";

/** floor(a*b/denom) */
export function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  return (a * b) / denom;
}

/** ceil(a*b/denom) */
export function mulDivCeil(a: bigint, b: bigint, denom: bigint): bigint {
  return (a * b + denom - 1n) / denom;
}

/** ceil(a/b) */
export function divCeil(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** floor(a * 2^64 / c) */
export function mulPow2DivFloor(a: bigint, b: bigint, c: bigint): bigint {
  return (a * (1n << b)) / c;
}

/** ceil(a * 2^64 / c) */
export function mulPow2DivCeil(a: bigint, b: bigint, c: bigint): bigint {
  const divisor = 1n << b;
  return (a * divisor + c - 1n) / c;
}

/** u128 环绕（模拟 Rust u128 乘法溢出截断） */
function wrap128(x: bigint): bigint {
  const MASK = (1n << 128n) - 1n;
  return x & MASK;
}

const BIT_LUT: { mask: number; mul: bigint }[] = [
  { mask: 0x1, mul: 0xfffcb933bd6fb800n },
  { mask: 0x2, mul: 0xfff97272373d4000n },
  { mask: 0x4, mul: 0xfff2e50f5f657000n },
  { mask: 0x8, mul: 0xffe5caca7e10f000n },
  { mask: 0x10, mul: 0xffcb9843d60f7000n },
  { mask: 0x20, mul: 0xff973b41fa98e800n },
  { mask: 0x40, mul: 0xff2ea16466c9b000n },
  { mask: 0x80, mul: 0xfe5dee046a9a3800n },
  { mask: 0x100, mul: 0xfcbe86c7900bb000n },
  { mask: 0x200, mul: 0xf987a7253ac65800n },
  { mask: 0x400, mul: 0xf3392b0822bb6000n },
  { mask: 0x800, mul: 0xe7159475a2caf000n },
  { mask: 0x1000, mul: 0xd097f3bdfd2f2000n },
  { mask: 0x2000, mul: 0xa9f746462d9f8000n },
  { mask: 0x4000, mul: 0x70d869a156f31c00n },
  { mask: 0x8000, mul: 0x31be135f97ed3200n },
  { mask: 0x10000, mul: 0x9aa508b5b85a500n },
  { mask: 0x20000, mul: 0x5d6af8dedc582cn },
  { mask: 0x40000, mul: 0x2216e584f5fan },
];

/**
 * tick → sqrt_price_x64（Q64.64 定点数）
 * 复刻 Raydium CLMM tick_math::get_sqrt_price_at_tick
 */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} out of range`);
  }
  const absTick = Math.abs(tick);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fb800n : 0x10000000000000000n;
  for (const { mask, mul } of BIT_LUT) {
    if (absTick & mask) {
      ratio = (ratio * mul) >> 64n;
    }
  }
  if (tick > 0) {
    // U128::MAX / ratio（模拟 Rust 的 U128 除法）
    ratio = ((1n << 128n) - 1n) / ratio;
  }
  return ratio;
}

/** 计算 BigInt 的最高有效位索引（floor(log2(x))），x > 0 */
export function bitLength(x: bigint): number {
  if (x <= 0n) return 0;
  return x.toString(2).length;
}

/**
 * sqrt_price_x64 → tick
 * 复刻 Raydium CLMM tick_math::get_tick_at_sqrt_price
 */
export function getTickAtSqrtPrice(sqrtPriceX64: bigint): number {
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 >= MAX_SQRT_PRICE_X64) {
    throw new Error("sqrt_price out of range");
  }
  const msb = BigInt(bitLength(sqrtPriceX64) - 1); // 128 - leading_zeros - 1
  const log2pIntegerX32 = (msb - 64n) << 32n;

  let bit = 0x8000000000000000n;
  let precision = 0n;
  let log2pFractionX64 = 0n;

  let r = msb >= 64n ? sqrtPriceX64 >> (msb - 63n) : sqrtPriceX64 << (63n - msb);
  while (bit > 0n && precision < 16n) {
    r = wrap128(r * r);
    const isRMoreThanTwo = r >> 127n;
    r >>= 63n + isRMoreThanTwo;
    log2pFractionX64 += bit * isRMoreThanTwo;
    bit >>= 1n;
    precision += 1n;
  }

  const log2pFractionX32 = log2pFractionX64 >> 32n;
  const log2pX32 = log2pIntegerX32 + log2pFractionX32;
  const logSqrt10001X64 = log2pX32 * 59543866431248n;

  const tickLow = Number((logSqrt10001X64 - 184467440737095516n) >> 64n);
  const tickHigh = Number((logSqrt10001X64 + 15793534762490258745n) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  else if (getSqrtPriceAtTick(tickHigh) <= sqrtPriceX64) return tickHigh;
  else return tickLow;
}

/**
 * 增加流动性（带符号，模拟 Rust add_delta）
 */
export function addDelta(x: bigint, y: bigint): bigint {
  const result = x + y;
  if (result < 0n) throw new Error("liquidity underflow");
  return result;
}

/**
 * amount0 变化（模拟 Raydium CLMM liquidity_math::get_delta_amount_0_unsigned）
 * 输入 sqrt_ratio_a/b 已由调用方排序
 */
export function getDeltaAmount0Unsigned(
  sqrtRatioA: bigint,
  sqrtRatioB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [a, b] = sqrtRatioA <= sqrtRatioB ? [sqrtRatioA, sqrtRatioB] : [sqrtRatioB, sqrtRatioA];
  if (a <= 0n) throw new Error("sqrt_ratio_a is zero");
  const numerator1 = liquidity << 64n; // U256
  const numerator2 = b - a;
  const result = roundUp
    ? divCeil(mulDivCeil(numerator1, numerator2, b), a)
    : (mulDivFloor(numerator1, numerator2, b) / a);
  return result;
}

/**
 * amount1 变化（模拟 Raydium CLMM liquidity_math::get_delta_amount_1_unsigned）
 */
export function getDeltaAmount1Unsigned(
  sqrtRatioA: bigint,
  sqrtRatioB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [a, b] = sqrtRatioA <= sqrtRatioB ? [sqrtRatioA, sqrtRatioB] : [sqrtRatioB, sqrtRatioA];
  const numerator = (b - a) * liquidity;
  return roundUp ? divCeil(numerator, 1n << 64n) : numerator >> 64n;
}

export interface DeltaAmounts {
  amountIn: bigint;
  amountOut: bigint;
}

/**
 * 到 target 价格时的输入/输出量（模拟 get_delta_amounts_for_swap）
 */
export function getDeltaAmountsForSwap(
  sqrtRatioTargetX64: bigint,
  sqrtRatioCurrentX64: bigint,
  liquidity: bigint,
  zeroForOne: boolean,
): DeltaAmounts {
  if (sqrtRatioCurrentX64 === sqrtRatioTargetX64) {
    throw new Error("sqrt_price_current == sqrt_price_target");
  }
  const [a, b] =
    sqrtRatioCurrentX64 < sqrtRatioTargetX64
      ? [sqrtRatioCurrentX64, sqrtRatioTargetX64]
      : [sqrtRatioTargetX64, sqrtRatioCurrentX64];
  if (a <= 0n) throw new Error("sqrt_ratio_a is zero");
  const sqrtPriceDiff = b - a;
  const amount1X64 = liquidity * sqrtPriceDiff; // U256
  const sqrtPriceProduct = a * b; // U256

  let amountIn: bigint;
  let amountOut: bigint;
  if (zeroForOne) {
    amountIn = mulPow2DivCeil(amount1X64, 64n, sqrtPriceProduct);
    amountOut = amount1X64 >> 64n;
  } else {
    amountIn = divCeil(amount1X64, 1n << 64n);
    amountOut = mulPow2DivFloor(amount1X64, 64n, sqrtPriceProduct);
  }
  return { amountIn, amountOut };
}

/**
 * 根据输入金额计算 next sqrt_price（模拟 sqrt_price_math::get_next_sqrt_price_from_input）
 */
export function getNextSqrtPriceFromInput(
  sqrtPriceCurrentX64: bigint,
  liquidity: bigint,
  amount: bigint,
  zeroForOne: boolean,
): bigint {
  if (amount <= 0n) throw new Error("amount is zero");
  if (sqrtPriceCurrentX64 <= 0n) throw new Error("sqrt_price_current is zero");
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceCurrentX64, liquidity, amount)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceCurrentX64, liquidity, amount);
}

function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPriceCurrentX64: bigint,
  liquidity: bigint,
  amount: bigint,
): bigint {
  if (liquidity === 0n) return sqrtPriceCurrentX64;
  if (amount === 0n) return sqrtPriceCurrentX64;
  const numerator1 = liquidity << 64n; // U256
  const product = amount * sqrtPriceCurrentX64; // U256
  if (product / liquidity === amount) {
    // 无溢出：使用 U256 mul_div_ceil
    const denominator = numerator1 + product;
    return mulDivCeil(numerator1, sqrtPriceCurrentX64, denominator);
  } else {
    // 溢出：简化公式
    const denominator = numerator1 / sqrtPriceCurrentX64 + amount;
    return divCeil(numerator1, denominator);
  }
}

function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPriceCurrentX64: bigint,
  liquidity: bigint,
  amount: bigint,
): bigint {
  if (liquidity === 0n) return sqrtPriceCurrentX64;
  if (amount === 0n) return sqrtPriceCurrentX64;
  const quotient = (amount << 64n) / liquidity;
  return sqrtPriceCurrentX64 + quotient;
}

export interface SwapComputedResult {
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  sqrtPriceNextX64: bigint;
}

/**
 * 单步 swap 计算（模拟 Raydium CLMM swap_math::compute_swap）
 * is_base_input = true 时使用
 */
export function computeSwap(
  sqrtPriceCurrentX64: bigint,
  sqrtPriceTargetX64: bigint,
  liquidity: bigint,
  amountSpecified: bigint,
  feeRate: bigint,
  isBaseInput: boolean,
  zeroForOne: boolean,
  isFeeOnInput: boolean,
): SwapComputedResult {
  if (sqrtPriceCurrentX64 === sqrtPriceTargetX64) {
    throw new Error("sqrt_price_current == sqrt_price_target");
  }
  // 方向校验
  if (zeroForOne && sqrtPriceTargetX64 > sqrtPriceCurrentX64) {
    throw new Error("target price greater than current price (zero for one)");
  }
  if (!zeroForOne && sqrtPriceTargetX64 < sqrtPriceCurrentX64) {
    throw new Error("target price less than current price (one for zero)");
  }

  const amountForPriceCalc = isBaseInput
    ? isFeeOnInput
      ? mulDivFloor(amountSpecified, FEE_RATE_DENOMINATOR - feeRate, FEE_RATE_DENOMINATOR)
      : amountSpecified
    : isFeeOnInput
      ? amountSpecified
      : mulDivFloor(amountSpecified, FEE_RATE_DENOMINATOR, FEE_RATE_DENOMINATOR + feeRate);

  const { amountIn: amountInAtTarget, amountOut: amountOutAtTarget } = getDeltaAmountsForSwap(
    sqrtPriceTargetX64,
    sqrtPriceCurrentX64,
    liquidity,
    zeroForOne,
  );

  let amountIn = amountInAtTarget;
  let amountOut = amountOutAtTarget;
  let sqrtPriceNextX64: bigint;

  if (
    (isBaseInput && amountForPriceCalc >= amountInAtTarget) ||
    (!isBaseInput && amountForPriceCalc <= amountOutAtTarget)
  ) {
    sqrtPriceNextX64 = sqrtPriceTargetX64;
  } else {
    sqrtPriceNextX64 = isBaseInput
      ? getNextSqrtPriceFromInput(sqrtPriceCurrentX64, liquidity, amountForPriceCalc, zeroForOne)
      : getNextSqrtPriceFromOutput(sqrtPriceCurrentX64, liquidity, amountForPriceCalc, zeroForOne);
    const next = getDeltaAmountsForSwap(sqrtPriceNextX64, sqrtPriceCurrentX64, liquidity, zeroForOne);
    amountIn = next.amountIn;
    amountOut = next.amountOut;
  }

  // 方向检查
  if (zeroForOne && sqrtPriceNextX64 >= sqrtPriceCurrentX64) {
    throw new Error("sqrt_price_next is not less than current (zero for one)");
  }
  if (!zeroForOne && sqrtPriceNextX64 <= sqrtPriceCurrentX64) {
    throw new Error("sqrt_price_next is not greater than current (one for zero)");
  }

  let feeAmount = 0n;
  if (isBaseInput) {
    if (isFeeOnInput) {
      feeAmount =
        sqrtPriceNextX64 !== sqrtPriceTargetX64
          ? amountSpecified - amountIn
          : divCeil(amountIn * feeRate, FEE_RATE_DENOMINATOR - feeRate);
    } else {
      feeAmount = divCeil(amountOut * feeRate, FEE_RATE_DENOMINATOR);
      amountOut -= feeAmount;
      if (sqrtPriceNextX64 !== sqrtPriceTargetX64) {
        amountIn = amountSpecified;
      }
    }
  } else {
    if (isFeeOnInput) {
      if (sqrtPriceNextX64 !== sqrtPriceTargetX64) {
        feeAmount = amountSpecified - amountIn;
      } else {
        feeAmount = mulDivFloor(amountIn, feeRate, FEE_RATE_DENOMINATOR - feeRate);
      }
    } else {
      if (sqrtPriceNextX64 !== sqrtPriceTargetX64) {
        feeAmount = amountSpecified - amountIn;
      } else {
        feeAmount = mulDivCeil(amountIn, feeRate, FEE_RATE_DENOMINATOR);
      }
    }
  }

  return { amountIn, amountOut, feeAmount, sqrtPriceNextX64 };
}

function getNextSqrtPriceFromOutput(
  sqrtPriceCurrentX64: bigint,
  liquidity: bigint,
  amount: bigint,
  zeroForOne: boolean,
): bigint {
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPriceCurrentX64, liquidity, amount)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPriceCurrentX64, liquidity, amount);
}
