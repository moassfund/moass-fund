export type AssetSymbol = 'MOASS' | 'sMOASS' | 'GME' | 'USDG' | 'LP'

export interface LeveragedLong {
  asset: 'GME'
  leverage: number
  collateralUsd: number
  notionalUsd: number
  sizeUnits: number
  entryPrice: number
  markPrice: number
  liqPrice: number
  pnlUsd: number
  /** PnL as a fraction of collateral */
  pnlPct: number
  equityUsd: number
  /** 0 = at liquidation, 1 = comfortably far from it */
  health: number
}

export interface TreasuryPosition {
  id: string
  label: string
  kind: 'leveraged-long' | 'spot' | 'stable' | 'lp'
  /** Equity value counted toward backing */
  valueUsd: number
  detail: string
}

export interface HistoryPoint {
  t: number
  price: number
  backing: number
  treasuryUsd: number
  gme: number
}

export interface BondMarket {
  id: string
  /** What the bonder pays with */
  asset: Exclude<AssetSymbol, 'MOASS' | 'sMOASS'>
  label: string
  icon: string
  assetPriceUsd: number
  /** Fraction, e.g. 0.085 = 8.5% below market */
  discount: number
  /** USD price of one MOASS through this bond */
  bondPriceUsd: number
  vestDays: number
  capacityMoass: number
  remainingMoass: number
}

export interface Epoch {
  number: number
  lengthSec: number
  startedAt: number
  endsAt: number
}

export interface ProtocolSnapshot {
  timestamp: number
  priceUsd: number
  priceGme: number
  /** Treasury equity per MOASS, USD */
  backingUsd: number
  /** price / backing */
  premium: number
  marketCapUsd: number
  totalSupply: number
  stakedSupply: number
  stakedPct: number
  index: number
  /** Reward per epoch as a fraction, e.g. 0.003 */
  rebaseRate: number
  /**
   * Fee charged on any AMM trade that touches a registered pair, as a fraction
   * (0.05 = 5%). Wallet-to-wallet transfers are free. Zero before launch.
   */
  tradingTax: number
  apy: number
  roi5d: number
  epoch: Epoch
  runwayDays: number
  treasury: { totalUsd: number; long: LeveragedLong; positions: TreasuryPosition[] }
  gme: { priceUsd: number; change24hPct: number }
  /** Oldest first, one point per epoch, ~30 days */
  history: HistoryPoint[]
  bonds: BondMarket[]
}

export interface UserBond {
  id: string
  marketId: string
  asset: BondMarket['asset']
  paidAmount: number
  payoutMoass: number
  claimedMoass: number
  purchasedAt: number
  vestEndsAt: number
}

export interface UserPosition {
  address: string | null
  balances: Record<AssetSymbol, number>
  bonds: UserBond[]
}

export interface TxResult {
  hash: string
}

/** The only surface the UI depends on. mockAdapter today, chainAdapter after deploy. */
export interface ProtocolAdapter {
  readonly kind: 'mock' | 'chain'
  getSnapshot(): Promise<ProtocolSnapshot>
  getUser(address: string | null): Promise<UserPosition>
  stake(address: string | null, amount: number): Promise<TxResult>
  unstake(address: string | null, amount: number): Promise<TxResult>
  bond(address: string | null, marketId: string, amount: number): Promise<TxResult>
  claim(address: string | null, bondIds: string[]): Promise<TxResult>
}
