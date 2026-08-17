import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  CLMM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  WSOL_MINT,
  TICK_ARRAY_SIZE,
  TICK_ARRAY_BITMAP_SIZE,
  TICK_ARRAY_BITMAP_EXTENSION_LEN,
  SWAP_V2_DISCRIMINATOR,
} from "./constants";
import { ParsedPoolState } from "./layout";
import { getArrayStartIndex, deriveTickArrayAddress } from "./pool";
import { fetchAccountsData, loadPoolState } from "./quote";

/** TickArrayState 账户长度（8 + 32 + 4 + 60×168 + 1 + 8 + 115） */
const TICK_ARRAY_STATE_LEN = 10240;
/** TickArrayState 中 initialized_count 的偏移 */
const INITIALIZED_COUNT_OFFSET = 10124;

export interface SwapTransactionParams {
  payer: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputAmount: bigint;
  minimumOutputAmount: bigint;
  poolPubkey: PublicKey;
  userInputTokenAccount: PublicKey;
  userOutputTokenAccount: PublicKey;
  /** 报价终点 tick（决定收集哪些 tick arrays）；缺省仅覆盖当前 array */
  endTick?: number;
  /** 终点之外额外多取几个 tick array（安全余量），缺省 2 */
  extraArrays?: number;
  /** 价格限制（Q64.64）；缺省 0 = 链上自动 min+1/max-1 且要求全额成交 */
  sqrtPriceLimit?: bigint;
  /** mint 所属 token 程序（Token-2022 mint 需传 TOKEN_2022_PROGRAM_ID） */
  inputTokenProgram?: PublicKey;
  outputTokenProgram?: PublicKey;
}

/**
 * 构造 Raydium CLMM swap_v2 交易。
 * - 输入为 SOL 时自动 wrap（创建 WSOL ATA + 转入 + syncNative）
 * - 输出为 SOL 时自动 unwrap（交换后关闭 WSOL ATA 取回原生 SOL）
 * - 收集 swap 路径上的已初始化 tick arrays（含 tick_array_bitmap_extension，如需）
 */
export async function buildSwapTransaction(
  rpc: string,
  params: SwapTransactionParams,
): Promise<VersionedTransaction> {
  const {
    payer,
    inputMint,
    outputMint,
    inputAmount,
    minimumOutputAmount,
    poolPubkey,
    userInputTokenAccount,
    userOutputTokenAccount,
  } = params;

  const pool = await loadPoolState(rpc, poolPubkey);

  const zeroForOne = pool.tokenMint0.equals(inputMint) && pool.tokenMint1.equals(outputMint);
  if (!zeroForOne && !(pool.tokenMint1.equals(inputMint) && pool.tokenMint0.equals(outputMint))) {
    throw new Error("Pool mints do not match the requested input/output tokens");
  }

  const inputIsSol = inputMint.equals(WSOL_MINT);
  const outputIsSol = outputMint.equals(WSOL_MINT);
  const sqrtPriceLimit = params.sqrtPriceLimit ?? 0n;
  const outputTokenProgram = params.outputTokenProgram ?? TOKEN_PROGRAM_ID;

  // 收集 swap 路径所需的 tick arrays（已初始化的）
  const { tickArrays, includeExtension } = await collectTickArrays(
    rpc,
    poolPubkey,
    pool,
    zeroForOne,
    params.endTick,
    params.extraArrays ?? 2,
  );

  // 检查用户 token 账户是否存在
  const [inputData, outputData] = await fetchAccountsData(rpc, [userInputTokenAccount, userOutputTokenAccount]);
  const inputExists = !!inputData;
  const outputExists = !!outputData;

  const ixs: TransactionInstruction[] = [];

  // --- 输入侧 ---
  if (inputIsSol) {
    // wrap：确保 WSOL ATA 存在，并把输入金额转入
    if (!inputExists) {
      ixs.push(createAssociatedTokenAccountInstruction(payer, userInputTokenAccount, payer, WSOL_MINT));
    }
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: userInputTokenAccount, lamports: inputAmount }));
    ixs.push(createSyncNativeInstruction(userInputTokenAccount, TOKEN_PROGRAM_ID));
  } else if (!inputExists) {
    throw new Error("Input token account not found - nothing to sell");
  }

  // --- 输出侧：缺失则创建 ATA ---
  if (!outputExists) {
    ixs.push(
      createAssociatedTokenAccountInstruction(payer, userOutputTokenAccount, payer, outputMint, outputTokenProgram),
    );
  }

  // --- 主 swap 指令 ---
  ixs.push(
    buildSwapV2Instruction({
      pool,
      poolPubkey,
      zeroForOne,
      payer,
      userInputTokenAccount,
      userOutputTokenAccount,
      amount: inputAmount,
      otherAmountThreshold: minimumOutputAmount,
      sqrtPriceLimit,
      isBaseInput: true,
      tickArrays,
      includeExtension,
    }),
  );

  // --- 输出 SOL：交换完成后解包（关闭 WSOL ATA，取回原生 SOL）---
  if (outputIsSol) {
    ixs.push(createCloseAccountInstruction(userOutputTokenAccount, payer, payer, [], TOKEN_PROGRAM_ID));
  }

  const connection = new Connection(rpc);
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/**
 * 收集 swap 方向上的已初始化 tick arrays。
 * 链上 swap 主循环会按 remaining accounts 顺序消费：当前 tick array → 下一个已初始化 array。
 * 未初始化的 array（账户不存在 / initialized_count=0）绝不能混入，否则链上解析会中断。
 */
async function collectTickArrays(
  rpc: string,
  poolPubkey: PublicKey,
  pool: ParsedPoolState,
  zeroForOne: boolean,
  endTick?: number,
  extraArrays = 2,
): Promise<{ tickArrays: PublicKey[]; includeExtension: boolean }> {
  const tickSpacing = pool.tickSpacing;
  const span = TICK_ARRAY_SIZE * tickSpacing;
  const step = (zeroForOne ? -1 : 1) * span;
  const currentStart = getArrayStartIndex(pool.tickCurrent, tickSpacing);
  const endStart = endTick !== undefined ? getArrayStartIndex(endTick, tickSpacing) : currentStart;

  // 候选范围：current → end，方向之外再多 extraArrays 个
  const from = Math.min(currentStart, endStart) - (zeroForOne ? span * extraArrays : 0);
  const to = Math.max(currentStart, endStart) + (zeroForOne ? 0 : span * extraArrays);

  const starts: number[] = [];
  for (let s = currentStart; zeroForOne ? s >= from : s <= to; s += step) {
    starts.push(s);
    if (starts.length > 128) break; // 安全上限
  }

  const pubkeys = starts.map((s) => deriveTickArrayAddress(poolPubkey, s));
  const datas = await fetchAccountsData(rpc, pubkeys);

  const tickArrays: PublicKey[] = [];
  for (let i = 0; i < pubkeys.length; i++) {
    const data = datas[i];
    // 仅保留链上位图已标记初始化的 array（账户存在且 initialized_count > 0）
    if (data && data.length >= TICK_ARRAY_STATE_LEN && data[INITIALIZED_COUNT_OFFSET] > 0) {
      tickArrays.push(pubkeys[i]);
    }
  }
  if (tickArrays.length === 0) {
    throw new Error("No initialized tick arrays found along the swap path");
  }

  // 是否需要 tick_array_bitmap_extension（tick array 索引超出默认位图 [-512, 511]）
  let includeExtension = false;
  for (const s of starts) {
    const arrayIndex = s / span; // start 必为 span 的整数倍
    if (arrayIndex > TICK_ARRAY_BITMAP_SIZE - 1 || arrayIndex < -TICK_ARRAY_BITMAP_SIZE) {
      includeExtension = true;
      break;
    }
  }
  if (includeExtension) {
    const ext = deriveTickArrayBitmapExtensionAddress(poolPubkey);
    const [extData] = await fetchAccountsData(rpc, [ext]);
    // 只有账户真实存在才放行（否则链上解析 remaining accounts 会中断）
    if (!extData || extData.length !== TICK_ARRAY_BITMAP_EXTENSION_LEN) {
      includeExtension = false;
    }
  }

  return { tickArrays, includeExtension };
}

/**
 * 构造 swap_v2 指令。
 * 账户顺序复刻 SwapSingleV2（13 命名账户）+ [extension 可选] + tick arrays
 * 数据: amount(u64) + other_amount_threshold(u64) + sqrt_price_limit_x64(u128) + is_base_input(bool)
 */
function buildSwapV2Instruction(params: {
  pool: ParsedPoolState;
  poolPubkey: PublicKey;
  zeroForOne: boolean;
  payer: PublicKey;
  userInputTokenAccount: PublicKey;
  userOutputTokenAccount: PublicKey;
  amount: bigint;
  otherAmountThreshold: bigint;
  sqrtPriceLimit: bigint;
  isBaseInput: boolean;
  tickArrays: PublicKey[];
  includeExtension: boolean;
}): TransactionInstruction {
  const {
    pool,
    poolPubkey,
    zeroForOne,
    payer,
    userInputTokenAccount,
    userOutputTokenAccount,
    amount,
    otherAmountThreshold,
    sqrtPriceLimit,
    isBaseInput,
    tickArrays,
    includeExtension,
  } = params;

  // vault 与 mint 随方向切换
  const inputVault = zeroForOne ? pool.tokenVault0 : pool.tokenVault1;
  const outputVault = zeroForOne ? pool.tokenVault1 : pool.tokenVault0;
  const inputVaultMint = zeroForOne ? pool.tokenMint0 : pool.tokenMint1;
  const outputVaultMint = zeroForOne ? pool.tokenMint1 : pool.tokenMint0;

  const data = Buffer.alloc(8 + 8 + 8 + 16 + 1);
  SWAP_V2_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(otherAmountThreshold, 16);
  data.writeBigUInt64LE(sqrtPriceLimit & 0xffffffffffffffffn, 24);
  data.writeBigUInt64LE(sqrtPriceLimit >> 64n, 32);
  data.writeUInt8(isBaseInput ? 1 : 0, 40);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: pool.ammConfig, isSigner: false, isWritable: false },
    { pubkey: poolPubkey, isSigner: false, isWritable: true },
    { pubkey: userInputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userOutputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: pool.observationKey, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: inputVaultMint, isSigner: false, isWritable: false },
    { pubkey: outputVaultMint, isSigner: false, isWritable: false },
  ];

  if (includeExtension) {
    keys.push({ pubkey: deriveTickArrayBitmapExtensionAddress(poolPubkey), isSigner: false, isWritable: false });
  }
  for (const p of tickArrays) {
    keys.push({ pubkey: p, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({ programId: CLMM_PROGRAM_ID, keys, data });
}

/**
 * 计算 tick_array_bitmap_extension PDA
 * 种子: ["pool_tick_array_bitmap_extension", pool_id]
 */
function deriveTickArrayBitmapExtensionAddress(poolId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_tick_array_bitmap_extension"), poolId.toBuffer()],
    CLMM_PROGRAM_ID,
  )[0];
}
