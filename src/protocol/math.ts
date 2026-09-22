// Pure protocol math. No I/O, unit-tested in math.test.ts.
const EPD = 3 // epochs per day (8h epochs)

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** APY from a per-epoch rebase rate, compounding every epoch. */
export const apyFromRebase = (rate: number, epochsPerDay = EPD) =>
  Math.pow(1 + rate, epochsPerDay * 365) - 1

/** Inverse of apyFromRebase. */
export const rebaseFromApy = (apy: number, epochsPerDay = EPD) =>
  Math.pow(1 + apy, 1 / (epochsPerDay * 365)) - 1

/** Compounded return over `days`. */
export const roiOverDays = (rate: number, days: number, epochsPerDay = EPD) =>
  Math.pow(1 + rate, epochsPerDay * days) - 1

/** Staked balance after `days` of rebases. */
export const projectBalance = (amount: number, rate: number, days: number, epochsPerDay = EPD) =>
  amount * Math.pow(1 + rate, epochsPerDay * days)

export const bondPrice = (marketPrice: number, discount: number) => marketPrice * (1 - discount)

export const bondDiscount = (marketPrice: number, bondPx: number) =>
  marketPrice > 0 ? (marketPrice - bondPx) / marketPrice : 0

/** MOASS received for `amount` of an asset worth `assetPriceUsd`, at `bondPriceUsd` per MOASS. */
export const bondPayout = (amount: number, assetPriceUsd: number, bondPriceUsd: number) =>
  bondPriceUsd > 0 ? (amount * assetPriceUsd) / bondPriceUsd : 0

export const vestedFraction = (now: number, start: number, end: number) =>
  end <= start ? 1 : clamp((now - start) / (end - start), 0, 1)

/** Linear vest: what can be claimed right now. */
export const claimable = (payout: number, claimed: number, now: number, start: number, end: number) =>
  Math.max(0, payout * vestedFraction(now, start, end) - claimed)

export const backingPerToken = (treasuryUsd: number, supply: number) =>
  supply > 0 ? treasuryUsd / supply : 0

export const premium = (price: number, backing: number) => (backing > 0 ? price / backing : 0)

/**
 * Days the current rebase rate can run before staked supply outgrows the
 * treasury at `floorUsd` backing per token (classic OHM runway).
 */
export const runwayDays = (
  treasuryUsd: number,
  stakedSupply: number,
  rate: number,
  floorUsd = 1,
  epochsPerDay = EPD,
) => {
  if (rate <= 0 || stakedSupply <= 0 || treasuryUsd <= stakedSupply * floorUsd) return 0
  return Math.log(treasuryUsd / (stakedSupply * floorUsd)) / Math.log(1 + rate) / epochsPerDay
}

/** Liquidation price of an isolated long, ignoring fees/funding. */
export const longLiqPrice = (entry: number, leverage: number, maintenance = 0.05) =>
  entry * (1 - 1 / leverage + maintenance)
