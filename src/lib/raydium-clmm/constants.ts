import { PublicKey } from "@solana/web3.js";

/** Raydium CLMM (Concentrated Liquidity Market Maker) 程序 ID */
export const CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/** SPL Token 程序 */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Token-2022 程序 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Memo 程序（swap_v2 必需账户） */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** 包装后的 SOL */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** 费用率分母（0.05% = 500，0.25% = 2500） */
export const FEE_RATE_DENOMINATOR = 1_000_000n;

/** 每个 tick array 容纳的 tick 数 */
export const TICK_ARRAY_SIZE = 60;

/** tick 范围 */
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

/** sqrt_price 极值（Q64.64） */
export const MIN_SQRT_PRICE_X64 = 4295048016n;
export const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;

/** 默认 tick array 位图单侧数组数量（共 1024 位） */
export const TICK_ARRAY_BITMAP_SIZE = 512;

/** TickArrayBitmapExtension 账户长度（8 + 32 + 2×14×8×8） */
export const TICK_ARRAY_BITMAP_EXTENSION_LEN = 1832;

/** 默认滑点（百分比小数，0.01 = 1%） */
export const DEFAULT_SLIPPAGE = 0.01;

/** Anchor 指令 discriminator: sha256("global:swap_v2")[0..8] */
export const SWAP_V2_DISCRIMINATOR = Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
