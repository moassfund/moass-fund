import { describe, expect, it } from 'vitest'
import {
  apyFromRebase, backingPerToken, bondDiscount, bondPayout, bondPrice, claimable, longLiqPrice,
  premium, projectBalance, rebaseFromApy, roiOverDays, runwayDays, vestedFraction,
} from './math'

describe('staking math', () => {
  it('compounds a 0.3% rebase 1095 times a year', () => {
    expect(apyFromRebase(0.003)).toBeCloseTo(Math.pow(1.003, 1095) - 1, 10)
    expect(apyFromRebase(0)).toBe(0)
  })
  it('rebaseFromApy inverts apyFromRebase', () => {
    expect(rebaseFromApy(apyFromRebase(0.0042))).toBeCloseTo(0.0042, 10)
  })
  it('5 day ROI is 15 epochs', () => {
    expect(roiOverDays(0.003, 5)).toBeCloseTo(Math.pow(1.003, 15) - 1, 12)
  })
  it('projects a balance', () => {
    expect(projectBalance(100, 0.01, 1)).toBeCloseTo(100 * 1.01 ** 3, 10)
  })
})

describe('bond math', () => {
  it('prices a discount and round-trips it', () => {
    expect(bondPrice(10, 0.085)).toBeCloseTo(9.15, 10)
    expect(bondDiscount(10, 9.15)).toBeCloseTo(0.085, 10)
    expect(bondDiscount(0, 1)).toBe(0)
  })
  it('pays out more MOASS than the market would', () => {
    // 10 GME at $30 = $300, bond price $9.15 → 32.79 MOASS vs 30 at market
    expect(bondPayout(10, 30, 9.15)).toBeCloseTo(300 / 9.15, 10)
    expect(bondPayout(10, 30, 0)).toBe(0)
  })
  it('vests linearly and clamps', () => {
    expect(vestedFraction(50, 0, 100)).toBe(0.5)
    expect(vestedFraction(-5, 0, 100)).toBe(0)
    expect(vestedFraction(500, 0, 100)).toBe(1)
    expect(vestedFraction(1, 5, 5)).toBe(1)
  })
  it('claimable subtracts what was already claimed', () => {
    expect(claimable(100, 20, 50, 0, 100)).toBe(30)
    expect(claimable(100, 60, 50, 0, 100)).toBe(0)
  })
})

describe('treasury math', () => {
  it('backing and premium', () => {
    expect(backingPerToken(2_400_000, 1_000_000)).toBeCloseTo(2.4, 10)
    expect(backingPerToken(1, 0)).toBe(0)
    expect(premium(6, 2.4)).toBeCloseTo(2.5, 10)
    expect(premium(6, 0)).toBe(0)
  })
  it('runway is zero when already at the floor, positive otherwise', () => {
    expect(runwayDays(100, 100, 0.003)).toBe(0)
    expect(runwayDays(100, 0, 0.003)).toBe(0)
    const days = runwayDays(2_400_000, 850_000, 0.003)
    expect(days).toBeCloseTo(Math.log(2_400_000 / 850_000) / Math.log(1.003) / 3, 8)
  })
  it('3x long liquidates roughly 28% below entry with 5% maintenance', () => {
    expect(longLiqPrice(30, 3)).toBeCloseTo(30 * (1 - 1 / 3 + 0.05), 10)
  })
})
