// Minimal ABIs for the reads and writes the UI needs. Human-readable form so a
// signature change is obvious in review; every one of these is checked against
// the compiled artifacts by `contracts/tools/check_abis.py`.
import { parseAbi } from 'viem'

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
])

/// MOASS itself, beyond the plain ERC-20 surface: the trading tax the Buy and
/// Prospectus windows have to disclose.
export const moassAbi = parseAbi([
  'function taxTotalBps() pure returns (uint256)',
  'function taxEnabled() view returns (bool)',
  'function isTaxedPair(address) view returns (bool)',
  'function canonicalPair() view returns (address)',
])

export const sMoassAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function circulatingSupply() view returns (uint256)',
  'function index() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
])

export const stakingAbi = parseAbi([
  // (length, number, end, distribute) — all seconds/absolute, never blocks.
  'function epoch() view returns (uint64, uint64, uint64, uint256)',
  'function totalStaked() view returns (uint256)',
  'function enabled() view returns (bool)',
  'function warmupEpochs() view returns (uint256)',
  'function stake(address to, uint256 amount) returns (uint256)',
  'function unstake(address to, uint256 amount) returns (uint256)',
  'function claim(address to) returns (uint256)',
  'function rebase()',
])

export const treasuryAbi = parseAbi([
  'function rfv() view returns (uint256)',
  'function backingPerToken() view returns (uint256)',
  'function liquidUsdg() view returns (uint256)',
  'function morphoAssets() view returns (uint256)',
  'function polRfv() view returns (uint256)',
  'function morphoCapBps() view returns (uint256)',
])

export const bondDepositoryAbi = parseAbi([
  'function marketCount() view returns (uint256)',
  'function quoteToken(uint256 marketId) view returns (address)',
  'function bondPrice(uint256 marketId) view returns (uint256)',
  'function payoutInEpoch(uint256 epochIndex) view returns (uint256)',
  'function startTime() view returns (uint64)',
  'function enabled() view returns (bool)',
  'function noteCount(address) view returns (uint256)',
  // (payout, claimed, start, end)
  'function notes(address, uint256) view returns (uint256, uint256, uint64, uint64)',
  'function pendingFor(address) view returns (uint256 totalPending, uint256 claimableNow)',
  'function deposit(uint256 marketId, uint256 amount, uint256 maxPriceWad, address to) returns (uint256, uint256)',
  'function redeem(address to) returns (uint256)',
])

export const oracleAbi = parseAbi([
  'function twapMoassUsdg() view returns (uint256)',
  'function checkpoint()',
])

export const gmeDeskAbi = parseAbi([
  // (venue, collateral, sizeUnits, entryPriceWad, debtQuoteWad, liquidAtOpen, openedAt)
  'function position() view returns (address, uint256, uint256, uint256, uint256, uint256, uint64)',
  'function totalAssets() view returns (uint256)',
  'function liquidAssets() view returns (uint256)',
  'function deployedAssets() view returns (uint256)',
  'function leverageWad() view returns (uint256)',
  'function realisedPnl() view returns (int256)',
])

export const pairAbi = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
])

export const inverseBondAbi = parseAbi([
  'function price() view returns (uint256)',
  'function active() view returns (bool)',
  'function capacityRemaining() view returns (uint256)',
  'function swap(uint256 moassAmount, uint256 minUsdgOutRaw) returns (uint256)',
])

/// Uniswap V3 pool. Only needed to price GME in dollars: on Robinhood Chain the
/// deep GME/USDG liquidity is V3 (1% fee tier), while the protocol's own
/// MOASS/GME pair is V2.
export const v3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
])

/// The founding offering. `purchase` and `refund` take and return the reserve
/// (GME) in its own raw units; `claim` returns MOASS. The sale is over when
/// `finalized` flips, and dead if the deadline passes below the minimum raise.
export const genesisBondAbi = parseAbi([
  'function purchase(uint256 reserveAmountRaw)',
  'function refund()',
  'function claim() returns (uint256)',
  'function finalize()',
  'function finalized() view returns (bool)',
  'function saleDeadline() view returns (uint64)',
  'function raisedRaw() view returns (uint256)',
  'function purchasedRaw(address account) view returns (uint256)',
  'function purchasedMoassOf(address account) view returns (uint256)',
  'function claimableMoassOf(address account) view returns (uint256)',
  'function totalRaised() view returns (uint256)',
  'function registryLength() view returns (uint256)',
])
