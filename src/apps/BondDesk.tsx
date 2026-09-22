import { useState } from 'react'
import { TOKEN } from '../config'
import { useBond, useClaim, useProtocol, useUser } from '../protocol/hooks'
import { bondPayout, claimable, vestedFraction } from '../protocol/math'
import type { BondMarket, UserBond } from '../protocol/types'
import { dialogs } from '../shell/dialogStore'
import { AmountInput, Callout, KV, ListView, ProgressBar, StatusBar, Tabs, fmtDay, fmtDuration, fmtNum, fmtPct, fmtSignedPct, fmtUsd, parseAmount, toneOf, useNow } from '../ui'
import type { Column } from '../ui'
import './BondDesk.css'

type Tab = 'markets' | 'mine'
const DAY_MS = 86_400_000
const DUST = 1e-6

export default function BondDesk() {
  const { data: p } = useProtocol()
  const { data: user } = useUser()
  const bond = useBond()
  const claim = useClaim()
  const now = useNow(1000)
  const [tab, setTab] = useState<Tab>('markets')
  const [marketId, setMarketId] = useState<string | null>(null)
  const [bondId, setBondId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')

  if (!p || !user) return <div className="window-content muted">Loading bond markets…</div>

  const market = p.bonds.find((m) => m.id === marketId) ?? p.bonds[0]
  const n = parseAmount(amount)
  const balance = market ? user.balances[market.asset] : 0
  const payout = market ? bondPayout(n, market.assetPriceUsd, market.bondPriceUsd) : 0
  const atMarket = market && p.priceUsd > 0 ? (n * market.assetPriceUsd) / p.priceUsd : 0
  const bonus = payout - atMarket
  const tooMuch = n > balance
  const overCap = !!market && payout > market.remainingMoass
  // The bond price is floored at backing, so when the market trades near
  // backing the "discount" can vanish or invert. Buying there is worse than
  // buying on the pool, so it needs saying out loud rather than a green button.
  const atPremium = !!market && market.discount <= 0

  const owed = (b: UserBond) => claimable(b.payoutMoass, b.claimedMoass, now, b.purchasedAt, b.vestEndsAt)
  const ripe = user.bonds.filter((b) => owed(b) > DUST)
  const allOwed = ripe.reduce((s, b) => s + owed(b), 0)
  const unclaimed = user.bonds.reduce((s, b) => s + b.payoutMoass - b.claimedMoass, 0)
  // sold-out markets do not count, same as Overview and Buy
  const openMarkets = p.bonds.filter((m) => m.remainingMoass > 0)
  const bestDiscount = openMarkets.reduce((best, m) => Math.max(best, m.discount), Number.NEGATIVE_INFINITY)

  const submitBond = async () => {
    if (!market) return
    const ok = await dialogs.runTx({
      title: 'Bonding…',
      text: `Sending ${fmtNum(n, 4)} ${market.asset} to the treasury`,
      action: () => bond.mutateAsync({ marketId: market.id, amount: n }),
      success: `Bonded ${fmtNum(n, 4)} ${market.asset} for ${fmtNum(payout, 4)} ${TOKEN.symbol}. Vests over ${market.vestDays} days.`,
    })
    if (ok) { setAmount(''); setTab('mine') }
  }

  const submitClaim = (ids: string[], total: number) =>
    dialogs.runTx({
      title: 'Claiming…',
      text: `Collecting ${fmtNum(total, 4)} vested ${TOKEN.symbol}`,
      action: () => claim.mutateAsync(ids),
      success: `Claimed ${fmtNum(total, 4)} ${TOKEN.symbol}. Tendies secured.`,
    })

  const marketCols: Column<BondMarket>[] = [
    { key: 'asset', header: 'Asset', render: (m) => <span className="bond-asset"><span aria-hidden="true">{m.icon}</span> {m.label}</span> },
    { key: 'bond', header: 'Bond price', align: 'right', render: (m) => <span className="num">{fmtUsd(m.bondPriceUsd)}</span> },
    { key: 'mkt', header: 'Market price', align: 'right', render: () => <span className="num">{fmtUsd(p.priceUsd)}</span> },
    { key: 'disc', header: 'Discount', align: 'right', render: (m) => <b className={`num ${toneOf(m.discount)}`}>{fmtPct(m.discount)}</b> },
    { key: 'vest', header: 'Vesting', render: (m) => `${m.vestDays} days` },
    { key: 'left', header: 'Left this epoch', align: 'right', render: (m) => <span className="num">{fmtNum(m.remainingMoass, 0)} {TOKEN.symbol}</span> },
  ]

  const bondCols: Column<UserBond>[] = [
    { key: 'asset', header: 'Asset', render: (b) => b.asset },
    { key: 'payout', header: `Payout (${TOKEN.symbol})`, align: 'right', render: (b) => <span className="num">{fmtNum(b.payoutMoass, 4)}</span> },
    { key: 'claimed', header: 'Claimed', align: 'right', render: (b) => <span className="num">{fmtNum(b.claimedMoass, 4)}</span> },
    { key: 'now', header: 'Claimable now', align: 'right', render: (b) => <b className={`num ${owed(b) > DUST ? 'up' : ''}`}>{fmtNum(owed(b), 4)}</b> },
    {
      key: 'vested', header: 'Vested', render: (b) => {
        const f = vestedFraction(now, b.purchasedAt, b.vestEndsAt)
        return <span className="bond-vest"><ProgressBar value={f} tone="gold" label="Vested" /><span className="num">{fmtPct(f, 0)}</span></span>
      },
    },
    { key: 'eta', header: 'Fully vested in', align: 'right', render: (b) => (b.vestEndsAt > now ? fmtDuration(b.vestEndsAt - now) : 'Done') },
  ]

  return (
    <>
      <div className="window-content stack">
        <Tabs<Tab>
          tabs={[{ id: 'markets', label: 'Markets' }, { id: 'mine', label: `My Bonds (${user.bonds.length})` }]}
          active={tab}
          onChange={setTab}
        >
          {tab === 'markets' ? (
            <div className="stack">
              <ListView
                columns={marketCols}
                rows={p.bonds}
                rowKey={(m) => m.id}
                selectedKey={market?.id}
                onSelect={(m) => { setMarketId(m.id); setAmount('') }}
                empty="No bond markets open right now. Check back next epoch."
              />
              {market && (
                <fieldset className="stack">
                  <legend>Bond {market.asset}</legend>
                  <AmountInput label="Amount to bond" value={amount} onChange={setAmount} symbol={market.asset} max={balance} />
                  <KV
                    rows={[
                      ['You receive', `${fmtNum(payout, 4)} ${TOKEN.symbol}`],
                      ['Same money at market', `${fmtNum(atMarket, 4)} ${TOKEN.symbol}`],
                      ['Bonus vs market', <b className={`num ${toneOf(bonus)}`}>{bonus >= 0 ? '+' : '-'}{fmtNum(Math.abs(bonus), 4)} {TOKEN.symbol} ({fmtSignedPct(market.bondPriceUsd > 0 ? p.priceUsd / market.bondPriceUsd - 1 : 0)})</b>],
                      ['Vesting', `Linear over ${market.vestDays} days, claim as it vests`],
                      ['Fully vested on', fmtDay(now + market.vestDays * DAY_MS)],
                    ]}
                  />
                  {atPremium && (
                    <Callout icon="⚠️" warn>
                      This bond is priced at or above market. You would get more {TOKEN.symbol} buying on the pool. Bonds are floored at backing, so this happens when the premium is thin.
                    </Callout>
                  )}
                  <button type="button" className={atPremium ? 'btn' : 'btn-primary'} disabled={n <= 0 || tooMuch || overCap} onClick={submitBond}>
                    {tooMuch ? 'Insufficient balance' : overCap ? "Exceeds this epoch's capacity" : atPremium ? `BOND ${market.asset} ANYWAY` : `BOND ${market.asset}`}
                  </button>
                </fieldset>
              )}
              <Callout>
                Bonds sell <b>newly minted</b> {TOKEN.symbol} below the market price. What you pay goes to the <b>treasury</b>, not the LP. That dilutes existing holders in order to grow backing. The discount floats with demand and <b>can go negative</b>, in which case apes are overpaying. Your payout vests linearly, so you claim it bit by bit.
              </Callout>
            </div>
          ) : (
            <div className="stack">
              <ListView
                columns={bondCols}
                rows={user.bonds}
                rowKey={(b) => b.id}
                selectedKey={bondId}
                onSelect={(b) => setBondId(b.id)}
                empty="No bonds yet. Pick a market, feed the treasury, come back for vested tendies."
              />
              <div className="row bond-actions">
                {/* The depository redeems every ripe note in one call, so a
                    per-bond claim is not something the chain can do. One
                    honest button rather than two that behave identically. */}
                <button type="button" className="btn-primary" disabled={allOwed <= DUST} onClick={() => submitClaim(ripe.map((b) => b.id), allOwed)}>
                  Claim all vested
                </button>
                <span className="grow muted num bond-actions-total">Claimable now: {fmtNum(allOwed, 4)} {TOKEN.symbol}</span>
              </div>
            </div>
          )}
        </Tabs>
      </div>
      <StatusBar>
        <span>{p.bonds.length} open {p.bonds.length === 1 ? 'market' : 'markets'}</span>
        <span>Best discount {openMarkets.length ? fmtPct(bestDiscount) : '--'}</span>
        <span>Unclaimed: {fmtNum(unclaimed, 4)} {TOKEN.symbol}</span>
      </StatusBar>
    </>
  )
}
