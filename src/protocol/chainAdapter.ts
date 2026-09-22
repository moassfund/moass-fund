// Real-chain adapter. Reads the deployed Moass Fund contracts and shapes them
// into the ProtocolSnapshot / UserPosition the windows render. Nothing in
// src/apps or src/shell changes.
//
// Conventions at this seam (see README.md):
//   - amounts crossing the boundary are whole-token JS numbers, never wei;
//   - fractions are fractions (0.085, not 8.5);
//   - timestamps are ms;
//   - writes resolve only once the receipt has landed, because runTx treats a
//     resolved promise as "the state has changed" and refetches immediately;
//   - approvals happen inside stake/bond, because the UI models one dialog per
//     call and has nowhere to render a second step.
//
// DENOMINATION. The protocol's unit of account is the reserve asset, which for
// Moass Fund is GME — not dollars. `backingPerToken` is GME per MOASS and the
// TWAP is MOASS priced in GME. Everything the UI shows in USD is converted here
// using the GME/USDG pool price. That conversion lives in one place on purpose:
// `gmeUsd()`.
import {
  createPublicClient,
  http,
  formatUnits,
  parseUnits,
  type Address,
  type PublicClient,
} from 'viem'
import { getWalletClient, switchChain, waitForTransactionReceipt } from '@wagmi/core'
import { CHAIN, EPOCHS_PER_DAY, TOKEN, QUOTE } from '../config'
import { wagmiConfig, robinhoodChain } from './wagmi'
import {
  bondDepositoryAbi,
  genesisBondAbi,
  erc20Abi,
  moassAbi,
  gmeDeskAbi,
  oracleAbi,
  pairAbi,
  sMoassAbi,
  stakingAbi,
  treasuryAbi,
  v3PoolAbi,
} from './abis'
import {
  apyFromRebase,
  bondDiscount,
  clamp,
  longLiqPrice,
  premium as premiumOf,
  roiOverDays,
  runwayDays,
} from './math'
import type {
  AssetSymbol,
  BondMarket,
  HistoryPoint,
  LeveragedLong,
  ProtocolAdapter,
  ProtocolSnapshot,
  TreasuryPosition,
  TxResult,
  UserBond,
  UserPosition,
  GenesisOffering,
} from './types'

// Filled by `contracts/script/Deploy.s.sol`, which writes
// contracts/deployments/<network>.json with exactly these keys.
const env = (key: string) => (import.meta.env?.[key] as string | undefined) ?? ''

export const CONTRACTS = {
  moass: env('VITE_ADDR_MOASS'),
  sMoass: env('VITE_ADDR_SMOASS'),
  staking: env('VITE_ADDR_STAKING'),
  distributor: env('VITE_ADDR_DISTRIBUTOR'),
  treasury: env('VITE_ADDR_TREASURY'),
  bondDepository: env('VITE_ADDR_BOND_DEPOSITORY'),
  oracle: env('VITE_ADDR_ORACLE'),
  gmeDesk: env('VITE_ADDR_GME_DESK'),
  inverseBond: env('VITE_ADDR_INVERSE_BOND'),
  /** The founding offering. Only live before finalize; read for the Genesis app. */
  genesisBond: env('VITE_ADDR_GENESIS_BOND'),
  /** The reserve asset and the token the protocol is paired against. */
  gme: env('VITE_ADDR_GME'),
  /** Stablecoin, used only to price GME for display. */
  usdg: env('VITE_ADDR_USDG'),
  /** MOASS/GME canonical pair. */
  lp: env('VITE_ADDR_PAIR'),
  /**
   * GME/USDG pool, read to convert the GME-denominated protocol into USD.
   * This is a Uniswap **V3** pool: on Robinhood Chain the deep GME/USDG
   * liquidity is V3 at the 1% fee tier, unlike the protocol's own V2 pair.
   */
  gmeUsdgPool: env('VITE_ADDR_GME_USDG_POOL'),
} as const

/**
 * Genesis terms. The contract does not expose its caps or price, so the deploy
 * script reads them out of Constants.sol and writes them here. Never restate
 * them by hand: that duplication is how the caps drifted in the first place.
 */
const envNum = (key: string, fallback: number) => {
  const v = Number(env(key))
  return Number.isFinite(v) && v > 0 ? v : fallback
}
const GENESIS_TERMS = {
  priceGme: envNum('VITE_GENESIS_PRICE', 3),
  hardCapGme: envNum('VITE_GENESIS_HARD_CAP', 2_000),
  walletCapGme: envNum('VITE_GENESIS_WALLET_CAP', 80),
  minRaiseGme: envNum('VITE_GENESIS_MIN_RAISE', 625),
  vestDays: envNum('VITE_GENESIS_VEST_DAYS', 5),
}

const MOASS_DECIMALS = 9
const GME_DECIMALS = 18
const USDG_DECIMALS = 6
const DAY_MS = 86_400_000

/** Where the indexer publishes the per-epoch history the charts need. */
const HISTORY_URL = env('VITE_HISTORY_URL') || '/history.json'

const addr = (a: string) => a as Address

const num = (v: bigint, decimals: number) => Number(formatUnits(v, decimals))
/** A WAD fraction as a JS number. */
const wad = (v: bigint) => Number(formatUnits(v, 18))

let cached: PublicClient | null = null
function client(): PublicClient {
  if (!cached) {
    cached = createPublicClient({ chain: robinhoodChain, transport: http(CHAIN.rpcUrl) })
  }
  return cached
}

function requireAddresses() {
  const missing = Object.entries(CONTRACTS)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) {
    throw new Error(
      `Contract addresses are not configured: ${missing.join(', ')}. ` +
        'Set the VITE_ADDR_* variables from contracts/deployments, or use VITE_DATA_SOURCE=mock.',
    )
  }
}

// ── Prices ───────────────────────────────────────────────────────────────────

/**
 * USD price of one GME, from the GME/USDG pool.
 *
 * This is the only place dollars enter. The protocol itself never needs it: it
 * is denominated in GME throughout, and this exists purely so the windows can
 * print familiar numbers.
 */
async function gmeUsd(): Promise<number> {
  const c = client()
  const [slot0, token0] = await Promise.all([
    c.readContract({ address: addr(CONTRACTS.gmeUsdgPool), abi: v3PoolAbi, functionName: 'slot0' }),
    c.readContract({ address: addr(CONTRACTS.gmeUsdgPool), abi: v3PoolAbi, functionName: 'token0' }),
  ])
  const sqrtPriceX96 = (slot0 as unknown as [bigint, ...unknown[]])[0]
  if (sqrtPriceX96 === 0n) return 0

  // price(token1 per token0) = (sqrtPriceX96 / 2^96)^2, in RAW units. Done in
  // bigint first: sqrtPriceX96 is far past the range a float holds exactly.
  const rawScaled = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n
  const raw = Number(rawScaled) / 1e18

  // Whichever way round the pool is, the decimal bridge is the same.
  const scale = 10 ** (GME_DECIMALS - USDG_DECIMALS)
  const gmeIsToken0 = (token0 as string).toLowerCase() === CONTRACTS.gme.toLowerCase()
  if (raw === 0) return 0
  return gmeIsToken0 ? raw * scale : (1 / raw) * scale
}

// ── History ──────────────────────────────────────────────────────────────────

/**
 * Per-epoch history for the charts. Contracts only know the present, so this
 * comes from the indexer. A failure here must never take the app down: the
 * charts degrade to a single live point and everything else still renders.
 */
async function fetchHistory(): Promise<HistoryPoint[]> {
  try {
    const res = await fetch(HISTORY_URL, { cache: 'no-cache' })
    if (!res.ok) return []
    const body = (await res.json()) as { points?: HistoryPoint[] }
    return Array.isArray(body.points) ? body.points : []
  } catch {
    return []
  }
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

async function getSnapshot(): Promise<ProtocolSnapshot> {
  requireAddresses()
  const c = client()
  const now = Date.now()

  const [
    epochTuple,
    totalSupplyRaw,
    stakedRaw,
    indexRaw,
    rfvRaw,
    backingRaw,
    liquidRaw,
    deskAssetsRaw,
    polRaw,
    marketCountRaw,
    depoStartRaw,
    taxBpsRaw,
    taxEnabled,
    block,
    usdPerGme,
    history,
  ] = await Promise.all([
    c.readContract({ address: addr(CONTRACTS.staking), abi: stakingAbi, functionName: 'epoch' }),
    c.readContract({ address: addr(CONTRACTS.moass), abi: erc20Abi, functionName: 'totalSupply' }),
    c.readContract({ address: addr(CONTRACTS.sMoass), abi: sMoassAbi, functionName: 'circulatingSupply' }),
    c.readContract({ address: addr(CONTRACTS.sMoass), abi: sMoassAbi, functionName: 'index' }),
    c.readContract({ address: addr(CONTRACTS.treasury), abi: treasuryAbi, functionName: 'rfv' }),
    c.readContract({ address: addr(CONTRACTS.treasury), abi: treasuryAbi, functionName: 'backingPerToken' }),
    c.readContract({ address: addr(CONTRACTS.treasury), abi: treasuryAbi, functionName: 'liquidUsdg' }),
    c.readContract({ address: addr(CONTRACTS.treasury), abi: treasuryAbi, functionName: 'morphoAssets' }),
    c.readContract({ address: addr(CONTRACTS.treasury), abi: treasuryAbi, functionName: 'polRfv' }),
    c.readContract({ address: addr(CONTRACTS.bondDepository), abi: bondDepositoryAbi, functionName: 'marketCount' }),
    c.readContract({ address: addr(CONTRACTS.bondDepository), abi: bondDepositoryAbi, functionName: 'startTime' }),
    c.readContract({ address: addr(CONTRACTS.moass), abi: moassAbi, functionName: 'taxTotalBps' }),
    c.readContract({ address: addr(CONTRACTS.moass), abi: moassAbi, functionName: 'taxEnabled' }),
    c.getBlock(),
    gmeUsd(),
    fetchHistory(),
  ])

  const [lengthSec, epochNumber, endsAtSec, distributeRaw] = epochTuple as unknown as [
    bigint,
    bigint,
    bigint,
    bigint,
  ]

  // Every countdown and vesting bar in the UI is computed from the browser's
  // clock, so chain timestamps are shifted into that frame here. On a live
  // chain the two agree and this is a no-op; it matters when they do not —
  // a user with a skewed clock, or a local chain that has been time-travelled.
  const chainNowMs = Number((block as { timestamp: bigint }).timestamp) * 1000
  const skewMs = chainNowMs - now
  const toBrowserTime = (chainMs: number) => chainMs - skewMs

  const totalSupply = num(totalSupplyRaw as bigint, MOASS_DECIMALS)
  const stakedSupply = num(stakedRaw as bigint, MOASS_DECIMALS)

  // The TWAP reverts when the oracle is out of band, which is a normal state
  // rather than an error. Fall back to the pool's spot price so the UI can
  // still show a number; nothing on-chain uses this value.
  const priceGme = await twapOrSpot()

  // Everything the contracts report is denominated in GME. Convert once.
  const backingGme = wad(backingRaw as bigint)
  const backingUsd = backingGme * usdPerGme
  const priceUsd = priceGme * usdPerGme
  const treasuryUsd = wad(rfvRaw as bigint) * usdPerGme

  // The per-epoch reward divided by the float that earns it. Reading the
  // distributor's own rate instead would overstate APY by roughly the staked
  // ratio — the classic OHM-fork integration bug.
  const distribute = num(distributeRaw, MOASS_DECIMALS)
  const rebaseRate = stakedSupply > 0 ? distribute / stakedSupply : 0

  const long = await readDesk(usdPerGme)
  const positions = buildPositions(
    wad(liquidRaw as bigint) * usdPerGme,
    wad(deskAssetsRaw as bigint) * usdPerGme,
    wad(polRaw as bigint) * usdPerGme,
    long,
  )

  const bonds = await readMarkets({
    marketCount: Number(marketCountRaw as bigint),
    depoStartSec: Number(depoStartRaw as bigint),
    epochLengthSec: Number(lengthSec),
    totalSupply,
    usdPerGme,
    priceUsd,
  })

  const gmeChange24h = change24h(history, usdPerGme)

  return {
    genesis: await readGenesis(toBrowserTime),
    timestamp: now,
    priceUsd,
    priceGme,
    backingUsd,
    premium: premiumOf(priceUsd, backingUsd),
    marketCapUsd: priceUsd * totalSupply,
    totalSupply,
    stakedSupply,
    stakedPct: totalSupply > 0 ? stakedSupply / totalSupply : 0,
    index: num(indexRaw as bigint, MOASS_DECIMALS),
    rebaseRate,
    tradingTax: taxEnabled ? Number(taxBpsRaw as bigint) / 10_000 : 0,
    apy: apyFromRebase(rebaseRate, EPOCHS_PER_DAY),
    roi5d: roiOverDays(rebaseRate, 5, EPOCHS_PER_DAY),
    epoch: {
      number: Number(epochNumber),
      lengthSec: Number(lengthSec),
      startedAt: toBrowserTime((Number(endsAtSec) - Number(lengthSec)) * 1000),
      endsAt: toBrowserTime(Number(endsAtSec) * 1000),
    },
    runwayDays: runwayDays(treasuryUsd, stakedSupply, rebaseRate, backingUsd || 1, EPOCHS_PER_DAY),
    treasury: { totalUsd: treasuryUsd, long, positions },
    gme: { priceUsd: usdPerGme, change24hPct: gmeChange24h },
    history: history.length ? history : [livePoint(now, priceUsd, backingUsd, treasuryUsd, usdPerGme)],
    bonds,
  }
}

/** MOASS priced in GME. Prefers the TWAP; falls back to spot when out of band. */
async function twapOrSpot(): Promise<number> {
  const c = client()
  try {
    const twap = await c.readContract({
      address: addr(CONTRACTS.oracle),
      abi: oracleAbi,
      functionName: 'twapMoassUsdg',
    })
    return wad(twap as bigint)
  } catch {
    const [reserves, token0] = await Promise.all([
      c.readContract({ address: addr(CONTRACTS.lp), abi: pairAbi, functionName: 'getReserves' }),
      c.readContract({ address: addr(CONTRACTS.lp), abi: pairAbi, functionName: 'token0' }),
    ])
    const [r0, r1] = reserves as unknown as [bigint, bigint, number]
    const moassIsToken0 = (token0 as string).toLowerCase() === CONTRACTS.moass.toLowerCase()
    const moassR = moassIsToken0 ? r0 : r1
    const gmeR = moassIsToken0 ? r1 : r0
    if (moassR === 0n) return 0
    return num(gmeR, GME_DECIMALS) / num(moassR, MOASS_DECIMALS)
  }
}

/**
 * The leveraged sleeve.
 *
 * The desk stores the position's terms but values itself at cost, so mark, PnL,
 * liquidation price and health are derived here from those terms plus the live
 * GME price. That is deliberate: backing must not move with a price feed, but
 * the user should still see where the position stands.
 */
async function readDesk(usdPerGme: number): Promise<LeveragedLong> {
  const c = client()
  const [positionTuple, leverageRaw] = await Promise.all([
    c.readContract({ address: addr(CONTRACTS.gmeDesk), abi: gmeDeskAbi, functionName: 'position' }),
    c.readContract({ address: addr(CONTRACTS.gmeDesk), abi: gmeDeskAbi, functionName: 'leverageWad' }),
  ])
  const [, collateralRaw, sizeRaw, entryRaw] = positionTuple as unknown as [
    string,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ]

  const collateralGme = num(collateralRaw, GME_DECIMALS)
  const sizeUnits = num(sizeRaw, GME_DECIMALS)
  const entryPrice = wad(entryRaw)
  const leverage = wad(leverageRaw as bigint)
  const markPrice = usdPerGme
  const collateralUsd = collateralGme * entryPrice

  if (collateralGme === 0 || leverage === 0) {
    // Flat. Every field still has to be a number the UI can format.
    return {
      asset: 'GME',
      leverage: 0,
      collateralUsd: 0,
      notionalUsd: 0,
      sizeUnits: 0,
      entryPrice: 0,
      markPrice,
      liqPrice: 0,
      pnlUsd: 0,
      pnlPct: 0,
      equityUsd: 0,
      health: 1,
    }
  }

  const pnlUsd = sizeUnits * (markPrice - entryPrice)
  const liqPrice = longLiqPrice(entryPrice, leverage)
  return {
    asset: 'GME',
    leverage,
    collateralUsd,
    notionalUsd: sizeUnits * markPrice,
    sizeUnits,
    entryPrice,
    markPrice,
    liqPrice,
    pnlUsd,
    pnlPct: collateralUsd > 0 ? pnlUsd / collateralUsd : 0,
    equityUsd: Math.max(0, collateralUsd + pnlUsd),
    health: markPrice > 0 ? clamp((markPrice - liqPrice) / markPrice / 0.35, 0, 1) : 0,
  }
}

function buildPositions(
  liquidUsd: number,
  deskUsd: number,
  polUsd: number,
  long: LeveragedLong,
): TreasuryPosition[] {
  const out: TreasuryPosition[] = []
  if (deskUsd > 0) {
    out.push({
      id: 'desk',
      label: long.leverage > 0 ? `${long.leverage.toFixed(0)}x GME Long` : 'GME Desk (flat)',
      kind: 'leveraged-long',
      valueUsd: deskUsd,
      detail:
        long.leverage > 0
          ? `${long.sizeUnits.toFixed(0)} GME notional, run by the team multisig`
          : 'Idle, waiting for a position',
    })
  }
  if (liquidUsd > 0) {
    out.push({
      id: 'spot',
      label: 'GME (spot)',
      kind: 'spot',
      valueUsd: liquidUsd,
      detail: 'Reserves held directly by the treasury',
    })
  }
  if (polUsd > 0) {
    out.push({
      id: 'pol',
      label: `${TOKEN.symbol}-${QUOTE.symbol} LP`,
      kind: 'lp',
      valueUsd: polUsd,
      detail: 'Protocol-owned liquidity, valued at intrinsic',
    })
  }
  return out
}

const MARKET_META: Record<number, { label: string; icon: string; asset: BondMarket['asset'] }> = {
  0: { label: 'GME', icon: '🎮', asset: 'GME' },
  1: { label: `${TOKEN.symbol}-${QUOTE.symbol} LP`, icon: '🌊', asset: 'LP' },
}

async function readMarkets(args: {
  marketCount: number
  depoStartSec: number
  epochLengthSec: number
  totalSupply: number
  usdPerGme: number
  priceUsd: number
}): Promise<BondMarket[]> {
  const { marketCount, depoStartSec, epochLengthSec, totalSupply, usdPerGme, priceUsd } = args
  const c = client()

  const nowSec = Math.floor(Date.now() / 1000)
  const epochIndex = epochLengthSec > 0 ? Math.floor((nowSec - depoStartSec) / epochLengthSec) : 0

  // Capacity is per epoch and scales with supply: BOND_EPOCH_CAP_BPS = 25.
  const capacityMoass = (totalSupply * 25) / 10_000
  const usedRaw = await c.readContract({
    address: addr(CONTRACTS.bondDepository),
    abi: bondDepositoryAbi,
    functionName: 'payoutInEpoch',
    args: [BigInt(Math.max(0, epochIndex))],
  })
  const used = num(usedRaw as bigint, MOASS_DECIMALS)
  const remainingMoass = Math.max(0, capacityMoass - used)

  const markets: BondMarket[] = []
  for (let id = 0; id < marketCount; id++) {
    const meta = MARKET_META[id]
    if (!meta) continue

    let bondPriceGme: number
    try {
      const raw = await c.readContract({
        address: addr(CONTRACTS.bondDepository),
        abi: bondDepositoryAbi,
        functionName: 'bondPrice',
        args: [BigInt(id)],
      })
      bondPriceGme = wad(raw as bigint)
    } catch {
      // A stale oracle makes bonds unpriceable. Report the market as closed
      // rather than inventing a price.
      continue
    }

    const bondPriceUsd = bondPriceGme * usdPerGme
    const assetPriceUsd = meta.asset === 'LP' ? await lpUnitPriceUsd(usdPerGme) : usdPerGme

    markets.push({
      id: String(id),
      asset: meta.asset,
      label: meta.label,
      icon: meta.icon,
      assetPriceUsd,
      // Floored at backing, so this is never negative in practice, but the UI
      // handles it either way.
      discount: bondDiscount(priceUsd, bondPriceUsd),
      bondPriceUsd,
      vestDays: 2, // Constants.BOND_VEST
      capacityMoass,
      remainingMoass,
    })
  }
  return markets
}

/** USD value of one LP token, on the same intrinsic basis the treasury uses. */
async function lpUnitPriceUsd(usdPerGme: number): Promise<number> {
  const c = client()
  const [reserves, token0, supplyRaw] = await Promise.all([
    c.readContract({ address: addr(CONTRACTS.lp), abi: pairAbi, functionName: 'getReserves' }),
    c.readContract({ address: addr(CONTRACTS.lp), abi: pairAbi, functionName: 'token0' }),
    c.readContract({ address: addr(CONTRACTS.lp), abi: pairAbi, functionName: 'totalSupply' }),
  ])
  const [r0, r1] = reserves as unknown as [bigint, bigint, number]
  const supply = num(supplyRaw as bigint, 18)
  if (supply === 0) return 0

  const moassIsToken0 = (token0 as string).toLowerCase() === CONTRACTS.moass.toLowerCase()
  const moassR = num(moassIsToken0 ? r0 : r1, MOASS_DECIMALS)
  const gmeR = num(moassIsToken0 ? r1 : r0, GME_DECIMALS)
  // 2·√(x·y) with the MOASS leg at its one-GME floor, matching Treasury.polRfv.
  const rfvGme = 2 * Math.sqrt(gmeR * moassR)
  return (rfvGme * usdPerGme) / supply
}

function change24h(history: HistoryPoint[], currentGme: number): number {
  if (!history.length || currentGme === 0) return 0
  const cutoff = Date.now() - DAY_MS
  const past = [...history].reverse().find((p) => p.t <= cutoff)
  if (!past || !past.gme) return 0
  return (currentGme - past.gme) / past.gme
}

function livePoint(
  t: number,
  price: number,
  backing: number,
  treasuryUsd: number,
  gme: number,
): HistoryPoint {
  return { t, price, backing, treasuryUsd, gme }
}

// ── User ─────────────────────────────────────────────────────────────────────

const EMPTY_BALANCES: Record<AssetSymbol, number> = {
  MOASS: 0,
  sMOASS: 0,
  GME: 0,
  USDG: 0,
  LP: 0,
}

/**
 * Null only when no offering is configured. It deliberately survives
 * finalization: buyers still have five days of vesting to claim through.
 */
async function readGenesis(toBrowserTime: (chainMs: number) => number): Promise<GenesisOffering | null> {
  if (!CONTRACTS.genesisBond) return null
  const c = client()
  const g = { address: addr(CONTRACTS.genesisBond), abi: genesisBondAbi } as const
  const [finalized, raisedRaw, deadlineRaw, registryLen] = await Promise.all([
    c.readContract({ ...g, functionName: 'finalized' }),
    c.readContract({ ...g, functionName: 'raisedRaw' }),
    c.readContract({ ...g, functionName: 'saleDeadline' }),
    c.readContract({ ...g, functionName: 'registryLength' }),
  ])
  const raisedGme = num(raisedRaw as bigint, GME_DECIMALS)
  const deadline = toBrowserTime(Number(deadlineRaw as bigint) * 1000)
  const done = finalized as boolean
  return {
    ...GENESIS_TERMS,
    finalized: done,
    failed: !done && Date.now() > deadline && raisedGme < GENESIS_TERMS.minRaiseGme,
    raisedGme,
    deadline,
    shareholders: Number(registryLen as bigint),
  }
}

const NO_GENESIS = { contributedGme: 0, purchasedMoass: 0, claimableMoass: 0 }

async function readUserGenesis(who: `0x${string}`) {
  if (!CONTRACTS.genesisBond) return { ...NO_GENESIS }
  const c = client()
  const g = { address: addr(CONTRACTS.genesisBond), abi: genesisBondAbi } as const
  const [contributed, purchased, claimable] = await Promise.all([
    c.readContract({ ...g, functionName: 'purchasedRaw', args: [who] }),
    c.readContract({ ...g, functionName: 'purchasedMoassOf', args: [who] }),
    c.readContract({ ...g, functionName: 'claimableMoassOf', args: [who] }),
  ])
  return {
    contributedGme: num(contributed as bigint, GME_DECIMALS),
    purchasedMoass: num(purchased as bigint, MOASS_DECIMALS),
    claimableMoass: num(claimable as bigint, MOASS_DECIMALS),
  }
}

async function getUser(address: string | null): Promise<UserPosition> {
  requireAddresses()
  if (!address) return { address: null, balances: { ...EMPTY_BALANCES }, bonds: [], genesis: { ...NO_GENESIS } }

  const c = client()
  const who = addr(address)

  // Same clock correction as the snapshot: the Bond Desk draws its vesting
  // bars against the browser's clock.
  const block = await c.getBlock()
  const skewMs = Number(block.timestamp) * 1000 - Date.now()
  const toBrowserTime = (chainMs: number) => chainMs - skewMs

  const [moassRaw, sMoassRaw, gmeRaw, usdgRaw, lpRaw, noteCountRaw] = await Promise.all([
    c.readContract({ address: addr(CONTRACTS.moass), abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    c.readContract({ address: addr(CONTRACTS.sMoass), abi: sMoassAbi, functionName: 'balanceOf', args: [who] }),
    c.readContract({ address: addr(CONTRACTS.gme), abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    c.readContract({ address: addr(CONTRACTS.usdg), abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    c.readContract({ address: addr(CONTRACTS.lp), abi: pairAbi, functionName: 'balanceOf', args: [who] }),
    c.readContract({ address: addr(CONTRACTS.bondDepository), abi: bondDepositoryAbi, functionName: 'noteCount', args: [who] }),
  ])

  const count = Number(noteCountRaw as bigint)
  const bonds: UserBond[] = []
  for (let i = 0; i < count; i++) {
    const note = (await c.readContract({
      address: addr(CONTRACTS.bondDepository),
      abi: bondDepositoryAbi,
      functionName: 'notes',
      args: [who, BigInt(i)],
    })) as unknown as [bigint, bigint, bigint, bigint]

    const [payout, claimed, start, end] = note
    // Fully claimed notes stay in the array forever, which is what keeps the
    // index a stable id. Hide the spent ones from the list.
    if (payout === claimed) continue
    bonds.push({
      // Stable across refetches: the depository never compacts the array.
      id: `note:${i}`,
      marketId: '0',
      asset: 'GME',
      paidAmount: 0,
      payoutMoass: num(payout, MOASS_DECIMALS),
      claimedMoass: num(claimed, MOASS_DECIMALS),
      purchasedAt: toBrowserTime(Number(start) * 1000),
      vestEndsAt: toBrowserTime(Number(end) * 1000),
    })
  }

  return {
    address,
    genesis: await readUserGenesis(who),
    balances: {
      MOASS: num(moassRaw as bigint, MOASS_DECIMALS),
      sMOASS: num(sMoassRaw as bigint, MOASS_DECIMALS),
      GME: num(gmeRaw as bigint, GME_DECIMALS),
      USDG: num(usdgRaw as bigint, USDG_DECIMALS),
      LP: num(lpRaw as bigint, 18),
    },
    bonds,
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function wallet() {
  let w = await getWalletClient(wagmiConfig)
  if (!w) throw new Error('Connect a wallet first.')

  // Prompt the switch rather than just complaining about it. If the wallet
  // refuses, say so plainly.
  if (w.chain?.id !== CHAIN.id) {
    try {
      await switchChain(wagmiConfig, { chainId: CHAIN.id })
      w = await getWalletClient(wagmiConfig)
    } catch {
      throw new Error(`Wrong network. Switch to ${CHAIN.name} and try again.`)
    }
    if (!w || w.chain?.id !== CHAIN.id) {
      throw new Error(`Wrong network. Switch to ${CHAIN.name} and try again.`)
    }
  }
  return w
}

/**
 * Ensures `spender` may move `amount` of `token`, approving first if not.
 *
 * This lives inside the write rather than in the UI because `dialogs.runTx`
 * models exactly one progress dialog per call, so there is nowhere to render a
 * separate approve step.
 */
async function ensureAllowance(token: Address, spender: Address, amount: bigint, owner: Address) {
  const c = client()
  const allowance = (await c.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint
  if (allowance >= amount) return

  const w = await wallet()
  const hash = await w.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
    chain: robinhoodChain,
    account: w.account,
  })
  await waitForTransactionReceipt(wagmiConfig, { hash })
}

/** Submits, waits for the receipt, and surfaces a revert as a readable error. */
async function send(fn: () => Promise<`0x${string}`>): Promise<TxResult> {
  let hash: `0x${string}`
  try {
    hash = await fn()
  } catch (e) {
    throw new Error(humanise(e))
  }
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash })
  if (receipt.status === 'reverted') throw new Error('The transaction reverted on chain.')
  return { hash }
}

/**
 * viem's errors are several paragraphs long and the XP dialog is a fixed box,
 * so take the shortest useful line.
 */
function humanise(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (/User rejected|denied transaction/i.test(raw)) return 'You rejected the transaction.'
  if (/EpochCapExceeded/.test(raw)) return "That is more than this epoch's bond capacity."
  if (/PriceAboveMax/.test(raw)) return 'The bond price moved. Try again.'
  if (/NotEnabled/.test(raw)) return 'The protocol is not live yet.'
  if (/insufficient funds/i.test(raw)) return 'Not enough balance to cover gas.'
  const first = raw.split('\n')[0]?.trim()
  return first && first.length < 160 ? first : 'The transaction failed.'
}

async function stake(address: string | null, amount: number): Promise<TxResult> {
  requireAddresses()
  if (!address) throw new Error('Connect a wallet first.')
  const w = await wallet()
  const value = parseUnits(String(amount), MOASS_DECIMALS)

  await ensureAllowance(addr(CONTRACTS.moass), addr(CONTRACTS.staking), value, addr(address))
  return send(() =>
    w.writeContract({
      address: addr(CONTRACTS.staking),
      abi: stakingAbi,
      functionName: 'stake',
      args: [addr(address), value],
      chain: robinhoodChain,
      account: w.account,
    }),
  )
}

async function unstake(address: string | null, amount: number): Promise<TxResult> {
  requireAddresses()
  if (!address) throw new Error('Connect a wallet first.')
  const w = await wallet()
  const value = parseUnits(String(amount), MOASS_DECIMALS)

  await ensureAllowance(addr(CONTRACTS.sMoass), addr(CONTRACTS.staking), value, addr(address))
  return send(() =>
    w.writeContract({
      address: addr(CONTRACTS.staking),
      abi: stakingAbi,
      functionName: 'unstake',
      args: [addr(address), value],
      chain: robinhoodChain,
      account: w.account,
    }),
  )
}

/** Slippage allowance on the bond price, since the UI supplies no bound. */
const BOND_MAX_PRICE_TOLERANCE = 101n // percent

async function bond(address: string | null, marketId: string, amount: number): Promise<TxResult> {
  requireAddresses()
  if (!address) throw new Error('Connect a wallet first.')
  const w = await wallet()
  const c = client()
  const id = BigInt(marketId)

  const isLp = marketId === '1'
  const token = isLp ? addr(CONTRACTS.lp) : addr(CONTRACTS.gme)
  const decimals = isLp ? 18 : GME_DECIMALS
  const value = parseUnits(String(amount), decimals)

  // Read the price fresh and allow a little drift, rather than sending an
  // unbounded max price.
  const priceRaw = (await c.readContract({
    address: addr(CONTRACTS.bondDepository),
    abi: bondDepositoryAbi,
    functionName: 'bondPrice',
    args: [id],
  })) as bigint
  const maxPrice = (priceRaw * BOND_MAX_PRICE_TOLERANCE) / 100n

  await ensureAllowance(token, addr(CONTRACTS.bondDepository), value, addr(address))
  return send(() =>
    w.writeContract({
      address: addr(CONTRACTS.bondDepository),
      abi: bondDepositoryAbi,
      functionName: 'deposit',
      args: [id, value, maxPrice, addr(address)],
      chain: robinhoodChain,
      account: w.account,
    }),
  )
}

/**
 * Claims vested bond payouts.
 *
 * `redeem` sweeps every ripe note in one call — the depository has no per-note
 * redemption — so the ids the UI passes are informational. Claiming one bond
 * claims them all, which is why the Bond Desk's "claim selected" button is
 * labelled accordingly.
 */
async function claim(address: string | null, _bondIds: string[]): Promise<TxResult> {
  requireAddresses()
  if (!address) throw new Error('Connect a wallet first.')
  const w = await wallet()

  return send(() =>
    w.writeContract({
      address: addr(CONTRACTS.bondDepository),
      abi: bondDepositoryAbi,
      functionName: 'redeem',
      args: [addr(address)],
      chain: robinhoodChain,
      account: w.account,
    }),
  )
}

async function genesisPurchase(address: string | null, amount: number): Promise<TxResult> {
  requireAddresses()
  if (!address) throw new Error('Connect a wallet first.')
  if (!CONTRACTS.genesisBond) throw new Error('The founding offering is not configured for this deployment.')
  const w = await wallet()
  const value = parseUnits(String(amount), GME_DECIMALS)

  await ensureAllowance(addr(CONTRACTS.gme), addr(CONTRACTS.genesisBond), value, addr(address))
  return send(() =>
    w.writeContract({
      address: addr(CONTRACTS.genesisBond),
      abi: genesisBondAbi,
      functionName: 'purchase',
      args: [value],
      chain: robinhoodChain,
      account: w.account,
    }),
  )
}

/** Both of these are argument-free: the contract reads msg.sender. */
function genesisSelfCall(fn: 'claim' | 'refund') {
  return async (address: string | null): Promise<TxResult> => {
    requireAddresses()
    if (!address) throw new Error('Connect a wallet first.')
    if (!CONTRACTS.genesisBond) throw new Error('The founding offering is not configured for this deployment.')
    const w = await wallet()
    return send(() =>
      w.writeContract({
        address: addr(CONTRACTS.genesisBond),
        abi: genesisBondAbi,
        functionName: fn,
        chain: robinhoodChain,
        account: w.account,
      }),
    )
  }
}

export const chainAdapter: ProtocolAdapter = {
  genesisPurchase,
  genesisClaim: genesisSelfCall('claim'),
  genesisRefund: genesisSelfCall('refund'),
  kind: 'chain',
  getSnapshot,
  getUser,
  stake,
  unstake,
  bond,
  claim,
}
