import { useEffect, useState, type ReactNode } from 'react'
import { EPOCHS_PER_DAY, TOKEN } from '../config'
import { useProtocol, useUser } from '../protocol/hooks'
import { projectBalance, rebaseFromApy } from '../protocol/math'
import type { ProtocolSnapshot } from '../protocol/types'
import { Callout, KV, StatTile, StatusBar, fmtNum, fmtPct, fmtSignedPct, fmtSignedUsd, fmtUsd, parseAmount, toneOf } from '../ui'
import './Calculator.css'

const APY_SLIDER_MAX = 10_000
const DEFAULT_DAYS = 30
const TENDIES_BUCKET_USD = 8

interface Fields { amount: string; apy: string; buy: string; future: string; days: number }

const trim = (v: number, digits = 4) => String(Number(v.toFixed(digits)))
const cleanDecimal = (raw: string) => {
  const [head, ...rest] = raw.replace(/,/g, '.').replace(/[^\d.]/g, '').split('.')
  return rest.length ? `${head}.${rest.join('')}` : head
}
const liveFields = (p: ProtocolSnapshot, stack: number): Fields => ({
  amount: stack > 0 ? trim(stack) : '100',
  apy: String(Math.round(p.apy * 100)),
  buy: trim(p.priceUsd),
  future: trim(p.priceUsd),
  days: DEFAULT_DAYS,
})

function NumField({ label, hint, value, onChange, onCurrent, extra, children }: {
  label: string
  hint?: ReactNode
  value: string
  onChange: (v: string) => void
  onCurrent?: () => void
  extra?: ReactNode
  children?: ReactNode
}) {
  return (
    <label className="calculator-field">
      <span className="calculator-field-head"><span>{label}</span>{hint}</span>
      <span className="calculator-field-row">
        <input className="field" inputMode="decimal" autoComplete="off" placeholder="0" value={value} onChange={(e) => onChange(cleanDecimal(e.target.value))} />
        {extra}
        {onCurrent && <button type="button" className="btn small" onClick={onCurrent}>Current</button>}
      </span>
      {children}
    </label>
  )
}

export default function Calculator() {
  const { data: p } = useProtocol()
  const { data: user } = useUser()
  const [f, setF] = useState<Fields | null>(null)

  // Seed once when data first arrives. Refetches must never stomp on what the user typed.
  useEffect(() => {
    if (p && user && !f) setF(liveFields(p, user.balances.MOASS + user.balances.sMOASS))
  }, [p, user, f])

  if (!p || !user || !f) return <div className="window-content muted">Loading the tendies machine…</div>

  const set = (patch: Partial<Fields>) => setF({ ...f, ...patch })
  const stack = user.balances.MOASS + user.balances.sMOASS
  const live = liveFields(p, stack)

  const amount = parseAmount(f.amount)
  const apy = parseAmount(f.apy) / 100
  const rate = rebaseFromApy(apy)
  const projected = projectBalance(amount, rate, f.days)
  const cost = amount * parseAmount(f.buy)
  const value = projected * parseAmount(f.future)
  const profit = value - cost
  const roi = cost > 0 ? profit / cost : 0

  return (
    <>
      <div className="window-content stack">
        <fieldset className="stack">
          <legend>Inputs</legend>
          <NumField
            label={`${TOKEN.symbol} amount`}
            hint={<span className="num">My stack: {fmtNum(stack, 2)}</span>}
            value={f.amount}
            onChange={(amount) => set({ amount })}
            extra={<button type="button" className="btn small" disabled={stack <= 0} onClick={() => set({ amount: trim(stack) })}>Use my stack</button>}
          />
          <NumField
            label="APY %"
            hint={<span>Current: <b>{fmtPct(p.apy, 0)}</b></span>}
            value={f.apy}
            onChange={(apy) => set({ apy })}
            onCurrent={() => set({ apy: live.apy })}
          >
            <input
              type="range"
              min={0}
              max={APY_SLIDER_MAX}
              step={10}
              aria-label="APY percent"
              value={Math.min(APY_SLIDER_MAX, parseAmount(f.apy))}
              onChange={(e) => set({ apy: e.target.value })}
            />
          </NumField>
          <div className="calculator-pair">
            <NumField label="Purchase price (USD)" value={f.buy} onChange={(buy) => set({ buy })} onCurrent={() => set({ buy: live.buy })} />
            <NumField label="Future price (USD)" value={f.future} onChange={(future) => set({ future })} onCurrent={() => set({ future: live.future })} />
          </div>
          <label className="calculator-field">
            <span className="calculator-field-head">
              <span>Days of diamond hands</span>
              <b>{f.days} {f.days === 1 ? 'day' : 'days'} ({f.days * EPOCHS_PER_DAY} rebases)</b>
            </span>
            <input type="range" min={1} max={365} value={f.days} onChange={(e) => set({ days: Number(e.target.value) })} />
          </label>
        </fieldset>

        <div className="stat-grid">
          <StatTile variant="dark" label={`Projected ${TOKEN.staked}`} value={fmtNum(projected, 2)} sub={`from ${fmtNum(amount, 2)} staked`} />
          <StatTile variant="red" label="Projected value" value={fmtUsd(value)} sub={`at ${fmtUsd(parseAmount(f.future), 4)}`} />
          <StatTile label="Profit" value={fmtSignedUsd(profit)} sub={`${fmtSignedPct(roi)} ROI`} tone={toneOf(profit)} />
        </div>

        <KV
          rows={[
            ['Initial cost', fmtUsd(cost)],
            ['Rebase rate used', `${fmtPct(rate, 4)} per epoch`],
            ['ROI', <span className={toneOf(roi)}>{fmtSignedPct(roi)}</span>],
            ['Buckets of tendies 🍗', fmtNum(Math.max(0, value) / TENDIES_BUCKET_USD, 0)],
          ]}
        />

        <Callout icon="⚠️" warn>
          This projection holds APY constant for the whole period, <b>which will not happen</b>. The rate follows the premium to backing and falls as supply grows. Rebases pay you in newly minted {TOKEN.symbol}. What a {TOKEN.symbol} is worth by then is a separate question, and the answer can be "less".
        </Callout>
      </div>
      <StatusBar>
        <span>Napkin math, not a promise</span>
        <span>{TOKEN.symbol} {fmtUsd(p.priceUsd)}</span>
      </StatusBar>
    </>
  )
}
