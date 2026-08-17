import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  CLMM_PROGRAM_ID,
  WSOL_MINT,
  TICK_ARRAY_SIZE,
} from "./constants";
import { parsePoolState, ParsedPoolState } from "./layout";

/** PoolState 账户 discriminator: sha256("account:PoolState")[0..8] */
export const POOL_STATE_DISCRIMINATOR = Buffer.from([0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46]);

/** 池子必须的最小数据长度（PoolState::LEN = 1176，覆盖 dynamic_fee_info） */
const MIN_POOL_DATA_LEN = 1176;

export interface RawPoolAccount {
  pubkey: PublicKey;
  state: ParsedPoolState;
}

export interface FoundPool {
  pubkey: PublicKey;
  state: ParsedPoolState;
  /** token0 == base mint 时为 true（token0 是报价代币则相反） */
  token0IsBase: boolean;
  /** 池子的两个 mint */
  mints: [PublicKey, PublicKey];
}

/**
 * 在 CLMM 程序上查找包含指定 token mint 与 quote mint 的池子。
 * 通过 Helius RPC getProgramAccounts + memcmp 过滤（服务端过滤，避免全量拉取）。
 */
export async function findPoolByMints(
  rpc: string,
  tokenMint: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
): Promise<FoundPool | null> {
  const [pools0, pools1] = await Promise.all([
    getPoolsByMintOffset(rpc, tokenMint, 73), // token_mint_0
    getPoolsByMintOffset(rpc, tokenMint, 105), // token_mint_1
  ]);
  const all = [...pools0, ...pools1];
  // 去重（按 pubkey）
  const seen = new Set<string>();
  const unique: RawPoolAccount[] = [];
  for (const p of all) {
    const k = p.pubkey.toBase58();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(p);
    }
  }

  for (const pool of unique) {
    const s = pool.state;
    const mint0 = s.tokenMint0.toBase58();
    const mint1 = s.tokenMint1.toBase58();
    const quote = quoteMint.toBase58();
    const token = tokenMint.toBase58();
    if (mint0 === quote && mint1 === token) {
      // 报价代币是 token0，基础代币是 token1
      return { pubkey: pool.pubkey, state: s, token0IsBase: false, mints: [s.tokenMint0, s.tokenMint1] };
    }
    if (mint1 === quote && mint0 === token) {
      // 报价代币是 token1，基础代币是 token0
      return { pubkey: pool.pubkey, state: s, token0IsBase: true, mints: [s.tokenMint0, s.tokenMint1] };
    }
  }
  return null;
}

/** 按 mint 字段偏移查询池子（offset 73 = token_mint_0, 105 = token_mint_1） */
async function getPoolsByMintOffset(
  rpc: string,
  mint: PublicKey,
  mintOffset: number,
): Promise<RawPoolAccount[]> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [
      CLMM_PROGRAM_ID.toBase58(),
      {
        encoding: "base64",
        dataSlice: { offset: 0, length: MIN_POOL_DATA_LEN },
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(POOL_STATE_DISCRIMINATOR) } },
          { memcmp: { offset: mintOffset, bytes: mint.toBase58() } },
        ],
      },
    ],
  };
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`getProgramAccounts failed: ${JSON.stringify(json.error)}`);
  }
  const accounts: { pubkey: string; account: { data: [string, string] } }[] = json.result ?? [];
  return accounts
    .filter((a) => a.account.data && a.account.data[0])
    .map((a) => {
      const buf = Buffer.from(a.account.data[0], "base64");
      return { pubkey: new PublicKey(a.pubkey), state: parsePoolState(buf) };
    });
}

/**
 * 计算 tick array PDA
 * 种子: ["tick_array", pool_id, start_tick_index.to_be_bytes()]
 */
export function deriveTickArrayAddress(poolId: PublicKey, startTickIndex: number): PublicKey {
  const seed = Buffer.alloc(4);
  seed.writeInt32BE(startTickIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), poolId.toBuffer(), seed],
    CLMM_PROGRAM_ID,
  )[0];
}

/**
 * 计算 observation PDA
 * 种子: ["observation", pool_id]
 */
export function deriveObservationAddress(poolId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), poolId.toBuffer()],
    CLMM_PROGRAM_ID,
  )[0];
}

/**
 * 计算 tick 所属的 tick array start index
 * 复刻 TickArrayState::get_array_start_index
 */
export function getArrayStartIndex(tick: number, tickSpacing: number): number {
  const tickCount = TICK_ARRAY_SIZE * tickSpacing;
  const compressed = Math.floor(tick / tickSpacing);
  const startIndex = Math.floor(compressed / TICK_ARRAY_SIZE) * tickCount;
  return startIndex;
}

/** tick 在 tick array 内的索引（0-59） */
export function getArrayIndex(tick: number, tickSpacing: number): number {
  const startIndex = getArrayStartIndex(tick, tickSpacing);
  return Math.floor((tick - startIndex) / tickSpacing);
}

/** 检查 startIndex 是否合法（tick_spacing 的整数倍） */
export function checkIsValidStartIndex(startIndex: number, tickSpacing: number): boolean {
  return startIndex % tickSpacing === 0;
}
