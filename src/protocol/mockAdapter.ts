// Simulated protocol. Everything is a deterministic function of wall-clock time
// (so numbers are stable across reloads) plus per-user state in localStorage.
import { EPOCH_HOURS, TOKEN, QUOTE } from '../config'
import {
  apyFromRebase, backingPerToken, bondPayout, bondPrice, claimable, clamp, longLiqPrice,
  premium as premiumOf, roiOverDays, runwayDays,
} from './math'
import type {
  BondMarket, HistoryPoint, LeveragedLong, ProtocolAdapter, ProtocolSnapshot, TreasuryPosition,
  TxResult, UserBond, UserPosition,
} from './types'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const EPOCH_MS = EPOCH_HOURS * HOUR
const GENESIS = Date.UTC(2026, 7, 1)
const BASE_RATE = 0.003
const STAKED_PCT = 0.86
const INITIAL_SUPPLY = 1_000_000
const MAX_AGE_DAYS = 120 // growth curves flatten here so the mock stays sane forever

// --- deterministic noise -----------------------------------------------------
const hash = (n: number, seed: number) => {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
/** Smooth value noise in [-1, 1]; `period` is ms per lattice step. */
const noise = (t: number, period: number, seed: number) => {
  const x = t / period
  const i = Math.floor(x)
  const f = x - i
  const s = f * f * (3 - 2 * f)
  return (hash(i, seed) * (1 - s) + hash(i + 1, seed) * s) * 2 - 1
}

const ageDays = (t: number) => clamp((t - GENESIS) / DAY, 0, MAX_AGE_DAYS)

const gmeAt = (t: number) =>
  28 + ageDays(t) * 0.06 + 4.5 * noise(t, 6 * DAY, 1) + 1.8 * noise(t, 18 * HOUR, 2) + 0.5 * noise(t, 2 * HOUR, 3)

const premiumAt = (t: number) => 2.4 + 0.7 * noise(t, 5 * DAY, 4) + 0.25 * noise(t, 9 * HOUR, 5)

const epochNumberAt = (t: number) => Math.max(0, Math.floor((t - GENESIS) / EPOCH_MS))
const growthEpochsAt = (t: number) => Math.floor((ageDays(t) * DAY) / EPOCH_MS)
const indexAt = (t: number) => Math.pow(1 + BASE_RATE, growthEpochsAt(t))
const supplyAt = (t: number) => INITIAL_SUPPLY * Math.pow(1 + BASE_RATE * STAKED_PCT, growthEpochsAt(t))

const LONG_ENTRY = gmeAt(GENESIS + 2 * DAY)
const LONG_COLLATERAL = 800_000
const LONG_LEVERAGE = 3

function longAt(t: number): LeveragedLong {
  const markPrice = gmeAt(t)
  const notionalAtEntry = LONG_COLLATERAL * LONG_LEVERAGE
  const sizeUnits = notionalAtEntry / LONG_ENTRY
  const pnlUsd = sizeUnits * (markPrice - LONG_ENTRY)
  const liqPrice = longLiqPrice(LONG_ENTRY, LONG_LEVERAGE)
  return {
    asset: 'GME',
    leverage: LONG_LEVERAGE,
    collateralUsd: LONG_COLLATERAL,
    notionalUsd: sizeUnits * markPrice,
    sizeUnits,
    entryPrice: LONG_ENTRY,
    markPrice,
    liqPrice,
    pnlUsd,
    pnlPct: pnlUsd / LONG_COLLATERAL,
    equityUsd: Math.max(0, LONG_COLLATERAL + pnlUsd),
    health: clamp((markPrice - liqPrice) / markPrice / 0.35, 0, 1),
  }
}

function treasuryAt(t: number) {
  const d = ageDays(t)
  const gme = gmeAt(t)
  const long = longAt(t)
  const spotUnits = 14_000 + 420 * d
  const usdg = 520_000 + 7_500 * d
  const pol = (380_000 + 3_000 * d) * Math.sqrt(gme / 28)
  const positions: TreasuryPosition[] = [
    { id: 'long', label: '3x GME Long', kind: 'leveraged-long', valueUsd: long.equityUsd, detail: `${long.sizeUnits.toFixed(0)} GME notional, isolated margin` },
    { id: 'spot', label: 'GME (spot)', kind: 'spot', valueUsd: spotUnits * gme, detail: `${spotUnits.toFixed(0)} GME from bond sales` },
    { id: 'usdg', label: 'USDG reserve', kind: 'stable', valueUsd: usdg, detail: 'Dry powder and margin top-ups' },
    { id: 'pol', label: `${TOKEN.symbol}-${QUOTE.symbol} LP`, kind: 'lp', valueUsd: pol, detail: 'Protocol-owned liquidity' },
  ]
  return { totalUsd: positions.reduce((s, p) => s + p.valueUsd, 0), long, positions }
}

function pointAt(t: number): HistoryPoint {
  const treasuryUsd = treasuryAt(t).totalUsd
  const backing = backingPerToken(treasuryUsd, supplyAt(t))
  return { t, price: backing * premiumAt(t), backing, treasuryUsd, gme: gmeAt(t) }
}

// --- user state ----------------------------------------------------------------
interface StoredUser {
  moass: number
  /** sMOASS is stored as index-normalised shares so it rebases on its own */
  shares: number
  gme: number
  usdg: number
  lp: number
  bonds: UserBond[]
  /** MOASS bonded per market per UTC day, to draw down capacity */
  bondedToday: Record<string, number>
  /** Reserve put into the simulated founding offering */
  genesisGme: number
  genesisClaimed: number
}

// A simulated offering, open so the Founding Offering window is demoable. The
// mock protocol is otherwise post-launch; these two do not have to agree,
// because each window demonstrates its own thing.
const GENESIS_TERMS = {
  priceGme: 3,
  hardCapGme: 2_000,
  walletCapGme: 80,
  minRaiseGme: 625,
  vestDays: 5,
}
const GENESIS_DEADLINE = Date.now() + 3 * DAY
/** Subscribed by everyone who is not you. */
const GENESIS_OTHERS = 512

const keyFor = (address: string | null) => `moass.mock.v1:${(address ?? 'guest').toLowerCase()}`
const memory = new Map<string, string>()
const store = {
  get(k: string) {
    try { return localStorage.getItem(k) } catch { return memory.get(k) ?? null }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v) } catch { memory.set(k, v) }
  },
}

function loadUser(address: string | null): StoredUser {
  const raw = store.get(keyFor(address))
  if (raw) {
    try { return JSON.parse(raw) as StoredUser } catch { /* fall through to a fresh account */ }
  }
  const now = Date.now()
  const fresh: StoredUser = {
    moass: 1_250,
    shares: 420.69 / indexAt(now),
    gme: 42,
    usdg: 1_000,
    lp: 12,
    genesisGme: 0,
    genesisClaimed: 0,
    // one half-vested bond so "My Bonds" is never empty on first open
    bonds: [{
      id: 'seed-1', marketId: 'gme', asset: 'GME', paidAmount: 10, payoutMoass: 52.5,
      claimedMoass: 0, purchasedAt: now - 3 * DAY, vestEndsAt: now + 2 * DAY,
    }],
    bondedToday: {},
  }
  store.set(keyFor(address), JSON.stringify(fresh))
  return fresh
}
const saveUser = (address: string | null, u: StoredUser) => store.set(keyFor(address), JSON.stringify(u))

const dayKey = (marketId: string, t: number) => `${marketId}:${Math.floor(t / DAY)}`

function marketsAt(t: number, priceUsd: number, user?: StoredUser): BondMarket[] {
  const gme = gmeAt(t)
  const defs = [
    { id: 'gme', asset: 'GME' as const, label: 'GME', icon: '🎮', px: gme, base: 0.06, amp: 0.035, vest: 5, cap: 6_000, seed: 11 },
    { id: 'lp', asset: 'LP' as const, label: `${TOKEN.symbol}-${QUOTE.symbol} LP`, icon: '🌊', px: 2 * Math.sqrt(priceUsd * gme), base: 0.09, amp: 0.04, vest: 5, cap: 4_000, seed: 12 },
    { id: 'usdg', asset: 'USDG' as const, label: 'USDG', icon: '💵', px: 1, base: 0.04, amp: 0.025, vest: 3, cap: 3_000, seed: 13 },
  ]
  return defs.map((d) => {
    const discount = clamp(d.base + d.amp * noise(t, 7 * HOUR, d.seed), 0.005, 0.2)
    const organicFill = 0.25 + 0.3 * (noise(t, 5 * HOUR, d.seed + 50) + 1)
    const used = d.cap * organicFill + (user?.bondedToday[dayKey(d.id, t)] ?? 0)
    return {
      id: d.id, asset: d.asset, label: d.label, icon: d.icon, assetPriceUsd: d.px, discount,
      bondPriceUsd: bondPrice(priceUsd, discount), vestDays: d.vest, capacityMoass: d.cap,
      remainingMoass: Math.max(0, d.cap - used),
    }
  })
}

function snapshotAt(t: number, user?: StoredUser): ProtocolSnapshot {
  const treasury = treasuryAt(t)
  const totalSupply = supplyAt(t)
  const stakedSupply = totalSupply * STAKED_PCT
  const backingUsd = backingPerToken(treasury.totalUsd, totalSupply)
  const priceUsd = backingUsd * premiumAt(t)
  const prem = premiumOf(priceUsd, backingUsd)
  // Rate follows the premium: hotter market, higher emissions, capped.
  const rebaseRate = clamp(0.0018 + 0.0008 * (prem - 1), 0.0008, 0.0045)
  const gme = gmeAt(t)
  const gmeYesterday = gmeAt(t - DAY)
  const epochNo = epochNumberAt(t)
  const startedAt = GENESIS + epochNo * EPOCH_MS
  const history: HistoryPoint[] = []
  for (let i = 90; i >= 1; i--) history.push(pointAt(startedAt - i * EPOCH_MS))
  history.push(pointAt(t))
  return {
    genesis: null,
    timestamp: t,
    priceUsd,
    priceGme: priceUsd / gme,
    backingUsd,
    premium: prem,
    marketCapUsd: priceUsd * totalSupply,
    totalSupply,
    stakedSupply,
    stakedPct: STAKED_PCT,
    index: indexAt(t),
    rebaseRate,
    // Matches TAX_TOTAL_BPS in the contracts.
    tradingTax: 0.05,
    apy: apyFromRebase(rebaseRate),
    roi5d: roiOverDays(rebaseRate, 5),
    epoch: { number: epochNo, lengthSec: EPOCH_MS / 1000, startedAt, endsAt: startedAt + EPOCH_MS },
    runwayDays: runwayDays(treasury.totalUsd, stakedSupply, rebaseRate),
    treasury,
    gme: { priceUsd: gme, change24hPct: (gme - gmeYesterday) / gmeYesterday },
    history,
    bonds: marketsAt(t, priceUsd, user),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fakeTx = async (): Promise<TxResult> => {
  await sleep(1300 + Math.random() * 900)
  const hex = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return { hash: `0x${hex}` }
}
const requireAmount = (amount: number, balance: number, symbol: string) => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.')
  if (amount > balance + 1e-9) throw new Error(`Not enough ${symbol}. You have ${balance.toFixed(4)}.`)
}

export const mockAdapter: ProtocolAdapter = {
  kind: 'mock',

  async getSnapshot() {
    const snap = snapshotAt(Date.now(), loadUser(null))
    const raisedGme = GENESIS_OTHERS + loadUser(null).genesisGme
    snap.genesis = {
      ...GENESIS_TERMS,
      finalized: false,
      failed: false,
      raisedGme,
      deadline: GENESIS_DEADLINE,
      shareholders: 34 + (loadUser(null).genesisGme > 0 ? 1 : 0),
    }
    return snap
  },

  async getUser(address) {
    const u = loadUser(address)
    const position: UserPosition = {
      address,
      balances: { MOASS: u.moass, sMOASS: u.shares * indexAt(Date.now()), GME: u.gme, USDG: u.usdg, LP: u.lp },
      bonds: u.bonds,
      genesis: {
        contributedGme: u.genesisGme,
        purchasedMoass: u.genesisGme / GENESIS_TERMS.priceGme,
        claimableMoass: Math.max(0, u.genesisGme / GENESIS_TERMS.priceGme - u.genesisClaimed),
      },
    }
    return position
  },

  async stake(address, amount) {
    const u = loadUser(address)
    requireAmount(amount, u.moass, TOKEN.symbol)
    const tx = await fakeTx()
    u.moass -= amount
    u.shares += amount / indexAt(Date.now())
    saveUser(address, u)
    return tx
  },

  async unstake(address, amount) {
    const u = loadUser(address)
    const index = indexAt(Date.now())
    requireAmount(amount, u.shares * index, TOKEN.staked)
    const tx = await fakeTx()
    u.shares = Math.max(0, u.shares - amount / index)
    u.moass += amount
    saveUser(address, u)
    return tx
  },

  async bond(address, marketId, amount) {
    const u = loadUser(address)
    const now = Date.now()
    const market = snapshotAt(now, u).bonds.find((m) => m.id === marketId)
    if (!market) throw new Error('That bond market does not exist.')
    const field = market.asset === 'GME' ? 'gme' : market.asset === 'USDG' ? 'usdg' : 'lp'
    requireAmount(amount, u[field], market.asset)
    const payout = bondPayout(amount, market.assetPriceUsd, market.bondPriceUsd)
    if (payout > market.remainingMoass) throw new Error(`Only ${market.remainingMoass.toFixed(2)} ${TOKEN.symbol} left in this bond today.`)
    const tx = await fakeTx()
    u[field] -= amount
    u.bonds.unshift({
      id: tx.hash.slice(0, 12), marketId, asset: market.asset, paidAmount: amount, payoutMoass: payout,
      claimedMoass: 0, purchasedAt: now, vestEndsAt: now + market.vestDays * DAY,
    })
    const k = dayKey(marketId, now)
    const todaySuffix = `:${Math.floor(now / DAY)}`
    u.bondedToday = Object.fromEntries(Object.entries(u.bondedToday).filter(([key]) => key.endsWith(todaySuffix)))
    u.bondedToday[k] = (u.bondedToday[k] ?? 0) + payout
    saveUser(address, u)
    return tx
  },

  async claim(address, bondIds) {
    const u = loadUser(address)
    const now = Date.now()
    const due = u.bonds.filter((b) => bondIds.includes(b.id))
    const total = due.reduce((s, b) => s + claimable(b.payoutMoass, b.claimedMoass, now, b.purchasedAt, b.vestEndsAt), 0)
    if (total <= 0) throw new Error('Nothing has vested yet. Patience, ape.')
    const tx = await fakeTx()
    for (const b of due) b.claimedMoass += claimable(b.payoutMoass, b.claimedMoass, now, b.purchasedAt, b.vestEndsAt)
    u.bonds = u.bonds.filter((b) => b.payoutMoass - b.claimedMoass > 1e-9)
    u.moass += total
    saveUser(address, u)
    return tx
  },

  async genesisPurchase(address, amount) {
    const u = loadUser(address)
    requireAmount(amount, u.gme, QUOTE.symbol)
    if (u.genesisGme + amount > GENESIS_TERMS.walletCapGme) {
      throw new Error(`The wallet cap is ${GENESIS_TERMS.walletCapGme} ${QUOTE.symbol}. You are already in for ${u.genesisGme}.`)
    }
    const tx = await fakeTx()
    u.gme -= amount
    u.genesisGme += amount
    saveUser(address, u)
    return tx
  },

  async genesisClaim(address) {
    const u = loadUser(address)
    const due = u.genesisGme / GENESIS_TERMS.priceGme - u.genesisClaimed
    if (due <= 0) throw new Error('Nothing vested yet. Founding shares release over 5 days.')
    const tx = await fakeTx()
    u.genesisClaimed += due
    u.moass += due
    saveUser(address, u)
    return tx
  },

  async genesisRefund(address) {
    const u = loadUser(address)
    if (u.genesisGme <= 0) throw new Error('You did not subscribe, so there is nothing to refund.')
    const tx = await fakeTx()
    u.gme += u.genesisGme
    u.genesisGme = 0
    saveUser(address, u)
    return tx
  },
}
