import { useState } from 'react'
import { STABLE, TOKEN } from '../config'
import { isMock, useProtocol } from '../protocol/hooks'
import type { TreasuryPosition } from '../protocol/types'
import type { AppId } from '../shell/apps'
import { useWindowStore } from '../shell/windowStore'
import { Callout, KV, ListView, MenuBar, ProgressBar, StatTile, StatusBar, Tabs, fmtCompact, fmtNum, fmtPct, fmtSignedPct, fmtSignedUsd, fmtUsd, toneOf, type Column } from '../ui'
import { AreaChartXP, DonutXP } from '../ui/Chart'
import './Treasury.css'

type ChartTab = 'allocation' | 'value' | 'gme'

const SLICE_COLORS = ['#e31b23', '#1a1a1a', '#15803d', '#f8b636']
const KIND_LABEL: Record<TreasuryPosition['kind'], string> = { 'leveraged-long': 'Leveraged long', spot: 'Spot', stable: 'Stablecoin', lp: 'Liquidity' }
const TASKS: { id: AppId; icon: string; label: string }[] = [
  { id: 'bond', icon: '🏦', label: 'Feed the treasury (bond)' },
  { id: 'stake', icon: '💎', label: `Stake your ${TOKEN.symbol}` },
  { id: 'prospectus', icon: '📄', label: 'Read the prospectus' },
]
const fmtUsdCompact = (v: number) => `$${fmtCompact(v)}`

export default function Treasury() {
  const { data: p } = useProtocol()
  const open = useWindowStore((s) => s.open)
  const [tab, setTab] = useState<ChartTab>('allocation')

  if (!p) return <div className="window-content muted">Loading treasury…</div>

  const { long, positions, totalUsd } = p.treasury
  const liqDistance = (long.markPrice - long.liqPrice) / long.markPrice
  const liqDrop = (long.entryPrice - long.liqPrice) / long.entryPrice
  const healthTone = long.health < 0.35 ? 'red' : long.health < 0.6 ? 'gold' : undefined
  const share = (v: number) => (totalUsd > 0 ? v / totalUsd : 0)

  const columns: Column<TreasuryPosition>[] = [
    { key: 'label', header: 'Position', render: (r) => <b>{r.label}</b> },
    { key: 'kind', header: 'Type', render: (r) => KIND_LABEL[r.kind] },
    { key: 'value', header: 'Value', align: 'right', render: (r) => fmtUsd(r.valueUsd) },
    { key: 'share', header: 'Share of treasury', align: 'right', render: (r) => fmtPct(share(r.valueUsd), 1) },
    { key: 'detail', header: 'Notes', render: (r) => <span className="muted">{r.detail}</span> },
  ]

  return (
    <>
      <MenuBar items={['File', 'Edit', 'View', 'Favorites', 'Tools', 'Help']} />
      <div className="window-content flush treasury-shell">
        <div className="treasury-body">
          <aside className="treasury-pane">
            <section className="treasury-box">
              <h3>Treasury Tasks</h3>
              <div className="treasury-box-body">
                {TASKS.map((t) => (
                  <button key={t.id} type="button" className="treasury-link" onClick={() => open(t.id)}>
                    <span aria-hidden="true">{t.icon}</span> {t.label}
                  </button>
                ))}
              </div>
            </section>
            <section className="treasury-box">
              <h3>Details</h3>
              <div className="treasury-box-body">
                <KV
                  rows={[
                    ['Total treasury', fmtUsd(totalUsd)],
                    [`Backing per ${TOKEN.symbol}`, fmtUsd(p.backingUsd)],
                    ['Runway', `${fmtNum(p.runwayDays, 0)} days`],
                    ['Premium', `${fmtNum(p.premium, 2)}x backing`],
                  ]}
                />
              </div>
            </section>
          </aside>

          <div className="treasury-main stack">
            <section className="treasury-hero stack">
              <div className="row between treasury-hero-head">
                <h2 className="treasury-hero-title">{fmtNum(long.leverage, 0)}x {long.asset} LONG</h2>
                <span className="treasury-badge">{fmtNum(long.leverage, 0)}x LEVERAGE</span>
              </div>
              <div className="stat-grid">
                <StatTile variant="dark" label="Equity" value={fmtUsd(long.equityUsd)} sub="Marked live, see note" />
                <StatTile label="PnL" value={fmtSignedUsd(long.pnlUsd)} sub={`${fmtSignedPct(long.pnlPct)} on collateral`} tone={toneOf(long.pnlUsd)} />
                <StatTile label="Mark price" value={fmtUsd(long.markPrice)} sub={`${fmtSignedPct(p.gme.change24hPct)} 24h`} />
                <StatTile label="Entry price" value={fmtUsd(long.entryPrice)} sub={`${fmtNum(long.sizeUnits, 0)} ${long.asset} exposure`} />
                <StatTile variant="red" label="Liquidation price" value={fmtUsd(long.liqPrice)} sub="Position is wiped here" />
                <StatTile label="Notional" value={fmtUsd(long.notionalUsd)} sub="Total exposure" />
                <StatTile label="Collateral" value={fmtUsd(long.collateralUsd)} sub="Posted by the treasury" />
              </div>
              <div>
                <div className="row between treasury-health-head">
                  <span>Position health</span>
                  <b className="num">{fmtPct(liqDistance, 1)} above liquidation</b>
                </div>
                <ProgressBar value={long.health} tone={healthTone} label={`Distance to liquidation ${fmtPct(liqDistance, 1)}`} />
              </div>
              <Callout icon="🛟">
                How this position works, plainly. The desk is run by the team multisig, not by an algorithm: it can only move funds to venues fixed when it was deployed, and can only send them back to the treasury, but a bad trade still loses the sleeve. Backing counts the collateral at cost, so the equity above can run ahead of backing while the trade is open and only lands when the position is closed. A liquidation takes that collateral with it.
              </Callout>
            </section>

            <section>
              <h3 className="section-title">Holdings</h3>
              <ListView columns={columns} rows={positions} rowKey={(r) => r.id} empty="The treasury is empty. Somebody bond something." />
            </section>

            <Tabs<ChartTab>
              tabs={[{ id: 'allocation', label: 'Allocation' }, { id: 'value', label: 'Treasury value' }, { id: 'gme', label: `${long.asset} price` }]}
              active={tab}
              onChange={setTab}
            >
              {tab === 'allocation' && (
                <div className="treasury-alloc">
                  <div className="grow">
                    <DonutXP data={positions.map((x, i) => ({ name: x.label, value: x.valueUsd, color: SLICE_COLORS[i % SLICE_COLORS.length] }))} valueFormat={fmtUsd} />
                  </div>
                  <ul className="treasury-legend">
                    {positions.map((x, i) => (
                      <li key={x.id}>
                        <i style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                        <span className="grow">{x.label}</span>
                        <b className="num">{fmtPct(share(x.valueUsd), 1)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {tab === 'value' && <AreaChartXP data={p.history} series={[{ key: 'treasuryUsd', label: 'Treasury value', color: SLICE_COLORS[0] }]} yFormat={fmtUsdCompact} empty="No history yet. One point lands per epoch." />}
              {tab === 'gme' && <AreaChartXP data={p.history} series={[{ key: 'gme', label: `${long.asset} price`, color: SLICE_COLORS[2] }]} yFormat={(v) => fmtUsd(v)} empty="No history yet. One point lands per epoch." />}
            </Tabs>

            <Callout warn icon="⚠️">
              <b>The {fmtNum(long.leverage, 0)}x long can be liquidated.</b> If {long.asset} falls roughly {fmtPct(liqDrop, 0)} below the entry price, the position is closed by force. That slice of the backing is gone and backing per {TOKEN.symbol} drops. The rest of the treasury (spot {long.asset}, {STABLE.symbol}, LP) is not touched by a liquidation, but the spot and LP parts still move with {long.asset}. Diamond hands do not change the math.
              {isMock && <> Figures shown are simulated.</>}
            </Callout>
          </div>
        </div>
      </div>
      <StatusBar>
        <span>{positions.length} {positions.length === 1 ? 'object' : 'objects'}</span>
        <span>Total {fmtUsd(totalUsd)}</span>
        <span>{long.asset} {fmtUsd(p.gme.priceUsd)} <span className={toneOf(p.gme.change24hPct)}>{fmtSignedPct(p.gme.change24hPct)}</span></span>
      </StatusBar>
    </>
  )
}
