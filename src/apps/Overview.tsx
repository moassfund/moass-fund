// First window on boot: the whole fund at a glance, with shortcuts into the other apps.
import { QUOTE, TOKEN } from '../config'
import { isMock, useProtocol } from '../protocol/hooks'
import type { AppId } from '../shell/apps'
import { useWindowStore } from '../shell/windowStore'
import { Countdown, KV, MenuBar, ProgressBar, StatTile, StatusBar, fmtCompact, fmtNum, fmtPct, fmtSignedPct, fmtSignedUsd, fmtUsd, toneOf } from '../ui'
import { AreaChartXP, type Series } from '../ui/Chart'
import './Overview.css'

const SERIES: Series[] = [
  { key: 'price', label: `${TOKEN.symbol} price`, color: '#e31b23' },
  { key: 'backing', label: 'Backing per token', color: '#15803d' },
]

const openApp = (id: AppId) => useWindowStore.getState().open(id)

export default function Overview() {
  const { data: p } = useProtocol()

  if (!p) return <div className="window-content muted">Loading fund data…</div>

  const long = p.treasury.long
  const bestDiscount = p.bonds.reduce((best, b) => (b.remainingMoass > 0 ? Math.max(best, b.discount) : best), 0)
  const healthTone = long.health < 0.35 ? 'red' : long.health < 0.6 ? 'gold' : undefined
  const healthWord = long.health < 0.35 ? 'Sweating' : long.health < 0.6 ? 'Watch it' : 'Comfortable'
  // No position is open at launch, and until one is the leverage, liquidation
  // price and health are all zero or meaningless. Saying "the 0x long" with a
  // liquidation price of $0.00 reads as broken rather than as flat.
  const flat = long.leverage <= 0 || long.sizeUnits <= 0

  return (
    <>
      <MenuBar />
      <div className="window-content stack">
        <div className="stat-grid">
          <StatTile variant="dark" label={`$${TOKEN.symbol} price`} value={fmtUsd(p.priceUsd)} sub={`${fmtNum(p.priceGme, 4)} ${QUOTE.symbol}`} />
          <StatTile label={`Backing per ${TOKEN.symbol}`} value={fmtUsd(p.backingUsd)} sub="treasury / supply" />
          <StatTile label="Premium" value={`${fmtNum(p.premium)}x`} sub="price over backing" />
          <StatTile label="APY" value={fmtPct(p.apy, 0)} sub={`${fmtPct(p.rebaseRate, 3)} per epoch`} tone="up" />
          <StatTile variant="red" label="Treasury" value={fmtUsd(p.treasury.totalUsd)} sub={`${long.leverage}x ${QUOTE.symbol} long inside`} />
          <StatTile label="Market cap" value={fmtUsd(p.marketCapUsd)} sub={`${fmtCompact(p.totalSupply)} ${TOKEN.symbol}`} />
          <StatTile label="Staked" value={fmtPct(p.stakedPct, 0)} sub="of supply, diamond handed" />
          <StatTile label="Runway" value={`${fmtNum(p.runwayDays, 0)} days`} sub="at the current rebase rate" />
          <StatTile label="Next rebase" value={<Countdown to={p.epoch.endsAt} />} sub={`Epoch ${p.epoch.number}`} />
        </div>

        <section>
          <div className="section-title">Price vs backing, 30 days</div>
          <AreaChartXP data={p.history} series={SERIES} height={190} yFormat={fmtUsd} empty="No history yet. The chart fills in one point per epoch." />
          <div className="overview-legend muted">
            {SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
          </div>
        </section>

        <div className="overview-pair">
          <fieldset>
            <legend>{QUOTE.symbol}</legend>
            <KV
              rows={[
                ['Spot price', <span className="num">{fmtUsd(p.gme.priceUsd)}</span>],
                ['24h change', <b className={`num ${toneOf(p.gme.change24hPct)}`}>{fmtSignedPct(p.gme.change24hPct)}</b>],
                [`1 ${TOKEN.symbol} in ${QUOTE.symbol}`, <span className="num">{fmtNum(p.priceGme, 4)} {QUOTE.symbol}</span>],
              ]}
            />
          </fieldset>

          <fieldset>
            <legend>{flat ? `The ${long.asset} desk` : `The ${fmtNum(long.leverage, 0)}x long`}</legend>
            {flat ? (
              <KV
                rows={[
                  ['Position', 'None open'],
                  [`${long.asset} price`, <span className="num">{fmtUsd(long.markPrice)}</span>],
                ]}
              />
            ) : (
              <>
                <KV
                  rows={[
                    ['PnL', <b className={`num ${toneOf(long.pnlUsd)}`}>{fmtSignedUsd(long.pnlUsd)} ({fmtSignedPct(long.pnlPct)})</b>],
                    ['Mark vs liquidation', <span className="num">{fmtUsd(long.markPrice)} vs {fmtUsd(long.liqPrice)}</span>],
                  ]}
                />
                <div>
                  <div className="overview-health">
                    <span>Position health</span>
                    <span className="num">{healthWord}, {fmtPct(long.health, 0)}</span>
                  </div>
                  <ProgressBar value={long.health} tone={healthTone} label="Long position health" />
                </div>
              </>
            )}
            <div className="row between">
              <span className="muted">
                {flat
                  ? 'The treasury is not levered right now. Reserves are sitting in GME.'
                  : 'Leverage cuts both ways. This can be liquidated.'}
              </span>
              <button type="button" className="btn small" onClick={() => openApp('treasury')}>Open My Treasury</button>
            </div>
          </fieldset>
        </div>

        <div className="overview-actions">
          <button type="button" className="btn-primary" onClick={() => openApp('stake')}>Stake</button>
          <button type="button" className="btn" onClick={() => openApp('bond')}>
            {bestDiscount > 0 ? `Bond at ${fmtPct(bestDiscount, 1)} off` : 'Bond Desk'}
          </button>
        </div>
      </div>
      <StatusBar>
        <span>Supply: {fmtNum(p.totalSupply, 0)} {TOKEN.symbol}</span>
        <span>Epoch {p.epoch.number}</span>
        <span>{isMock ? 'Simulated data' : 'Live'}</span>
      </StatusBar>
    </>
  )
}
