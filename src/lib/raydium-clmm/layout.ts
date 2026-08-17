import { PublicKey } from "@solana/web3.js";

/** 读取 u64（LE） */
export function readU64(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

/** 读取 u128（LE） */
export function readU128(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/** 读取 i32（LE） */
export function readI32(buf: Buffer, offset: number): number {
  return buf.readInt32LE(offset);
}

/** 读取 u16（LE） */
export function readU16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

/** 读取 i128（LE，带符号扩展） */
export function readI128(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  const combined = (hi << 64n) | lo;
  return combined >= 1n << 127n ? combined - (1n << 128n) : combined;
}

/** 读取 Pubkey */
export function readPubkey(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + 32));
}

/**
 * Raydium CLMM PoolState 布局（8 字节 discriminator 之后）
 * 参考: raydium-clmm/programs/amm/src/states/pool.rs
 */
export interface ParsedPoolState {
  ammConfig: PublicKey;
  owner: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  tokenVault0: PublicKey;
  tokenVault1: PublicKey;
  observationKey: PublicKey;
  mintDecimals0: number;
  mintDecimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  feeOn: number;
  /** tick_array_bitmap: [u64; 16]，bit i 对应 tick array (i-512) */
  tickArrayBitmap: bigint;
  /** dynamic fee 是否启用（dynamic_fee_info 非全 0） */
  dynamicFeeEnabled: boolean;
  /** 全部原始数据（含 discriminator） */
  raw: Buffer;
}

export function parsePoolState(data: Buffer): ParsedPoolState {
  if (data.length < 1176) {
    throw new Error(`PoolState data too short: ${data.length}`);
  }
  const dynamicFeeEnabled = !data.subarray(1096, 1176).every((b) => b === 0);
  let tickArrayBitmap = 0n;
  for (let i = 0; i < 16; i++) {
    tickArrayBitmap |= readU64(data, 904 + i * 8) << BigInt(i * 64);
  }
  return {
    ammConfig: readPubkey(data, 9),
    owner: readPubkey(data, 41),
    tokenMint0: readPubkey(data, 73),
    tokenMint1: readPubkey(data, 105),
    tokenVault0: readPubkey(data, 137),
    tokenVault1: readPubkey(data, 169),
    observationKey: readPubkey(data, 201),
    mintDecimals0: data[233],
    mintDecimals1: data[234],
    tickSpacing: readU16(data, 235),
    liquidity: readU128(data, 237),
    sqrtPriceX64: readU128(data, 253),
    tickCurrent: readI32(data, 269),
    feeOn: data[390],
    tickArrayBitmap,
    dynamicFeeEnabled,
    raw: data,
  };
}

/**
 * Raydium CLMM TickState 布局（168 字节）
 * 参考: raydium-clmm/programs/amm/src/states/tick_array.rs
 */
export interface ParsedTickState {
  tick: number;
  liquidityNet: bigint;
  liquidityGross: bigint;
  hasLiquidity: boolean;
  /** 该 tick 上是否有未成交的 limit order */
  hasLimitOrders: boolean;
  /** 剩余 limit order 数量 */
  ordersAmount: bigint;
  /** 已部分成交订单的剩余量（x64） */
  unfilledRatioX64: bigint;
}

export function parseTickState(data: Buffer, offset: number): ParsedTickState {
  const liquidityGross = readU128(data, offset + 20);
  const ordersAmount = readU64(data, offset + 124);
  const unfilledRatioX64 = readU128(data, offset + 140);
  const hasLimitOrders = ordersAmount > 0n || unfilledRatioX64 > 0n;
  return {
    tick: readI32(data, offset),
    liquidityNet: readI128(data, offset + 4),
    liquidityGross,
    hasLiquidity: liquidityGross > 0n,
    hasLimitOrders,
    ordersAmount,
    unfilledRatioX64,
  };
}

/**
 * Raydium CLMM TickArrayState 布局（10240 字节）
 * discriminator[8] pool_id[32] start_tick_index[4] ticks[60×168] initialized_count[1] recent_epoch[8] padding[115]
 */
export interface ParsedTickArray {
  poolId: PublicKey;
  startTickIndex: number;
  ticks: ParsedTickState[];
}

export function parseTickArray(data: Buffer): ParsedTickArray {
  if (data.length < 44) {
    throw new Error(`TickArray data too short: ${data.length}`);
  }
  const ticks: ParsedTickState[] = [];
  const base = 44;
  for (let i = 0; i < 60; i++) {
    ticks.push(parseTickState(data, base + i * 168));
  }
  return {
    poolId: readPubkey(data, 8),
    startTickIndex: readI32(data, 40),
    ticks,
  };
}

/**
 * Raydium CLMM AmmConfig 布局（117 字节）
 * 参考: raydium-clmm/programs/amm/src/states/config.rs
 */
export interface ParsedAmmConfig {
  index: number;
  owner: PublicKey;
  protocolFeeRate: number;
  tradeFeeRate: number;
  tickSpacing: number;
  fundFeeRate: number;
  fundOwner: PublicKey;
}

export function parseAmmConfig(data: Buffer): ParsedAmmConfig {
  if (data.length < 93) {
    throw new Error(`AmmConfig data too short: ${data.length}`);
  }
  return {
    index: readU16(data, 9),
    owner: readPubkey(data, 11),
    protocolFeeRate: data.readUInt32LE(43),
    tradeFeeRate: data.readUInt32LE(47),
    tickSpacing: readU16(data, 51),
    fundFeeRate: data.readUInt32LE(53),
    fundOwner: readPubkey(data, 61),
  };
}
