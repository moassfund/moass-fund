// Luna Red UI kit. Styles live in src/styles/luna-red.css.
import type { CSSProperties, ReactNode } from 'react'
import { fmtCountdown } from './format'
import { useNow } from './useNow'

export function IconTile({ emoji, tint, size }: { emoji: string; tint?: string; size?: number }) {
  const style = { '--tint': tint, ...(size ? { width: size, height: size, fontSize: size * 0.55 } : {}) } as CSSProperties
  return (
    <span className="icon-tile" style={style} aria-hidden="true">
      <span>{emoji}</span>
    </span>
  )
}

export function StatTile({ label, value, sub, tone, variant }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'up' | 'down'
  variant?: 'dark' | 'red'
}) {
  return (
    <div className={`stat-tile ${variant ?? ''}`}>
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  )
}

/** Label/value rows with dotted rules. */
export function KV({ rows }: { rows: [label: ReactNode, value: ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ProgressBar({ value, tone, marquee, label }: { value?: number; tone?: 'red' | 'gold'; marquee?: boolean; label?: string }) {
  // `?? 0` does not catch NaN, and Math.max(0, NaN) is NaN — which renders as
  // width: "NaN%". A zeroed epoch at genesis produces exactly that.
  const safe = Number.isFinite(value) ? (value as number) : 0
  const pct = Math.round(Math.min(1, Math.max(0, safe)) * 100)
  return (
    <div className={`progress ${tone ?? ''} ${marquee ? 'marquee' : ''}`} role="progressbar" aria-label={label} aria-valuenow={marquee ? undefined : pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Tabs<T extends string>({ tabs, active, onChange, children }: {
  tabs: { id: T; label: ReactNode }[]
  active: T
  onChange: (id: T) => void
  children: ReactNode
}) {
  return (
    <div className="tabs">
      <div className="tab-list" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={t.id === active} onClick={() => onChange(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel">{children}</div>
    </div>
  )
}

export function AmountInput({ label, value, onChange, symbol, max, maxLabel = 'Balance' }: {
  label: string
  value: string
  onChange: (v: string) => void
  symbol: string
  max?: number
  maxLabel?: string
}) {
  const clean = (raw: string) => {
    const s = raw.replace(/,/g, '.').replace(/[^\d.]/g, '')
    const [head, ...rest] = s.split('.')
    return rest.length ? `${head}.${rest.join('')}` : head
  }
  return (
    <label className="amount-input">
      <span className="amount-input-head">
        <span>{label}</span>
        {max != null && <span className="num">{maxLabel}: {max.toLocaleString('en-US', { maximumFractionDigits: 4 })} {symbol}</span>}
      </span>
      <span className="amount-input-row">
        <input className="field" inputMode="decimal" placeholder="0.00" autoComplete="off" value={value} onChange={(e) => onChange(clean(e.target.value))} />
        <span className="amount-input-symbol">{symbol}</span>
        {max != null && (
          <button type="button" className="btn" onClick={() => onChange(String(Math.floor(max * 1e6) / 1e6))}>Max</button>
        )}
      </span>
    </label>
  )
}

export interface Column<T> {
  key: string
  header: string
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
}

/** XP "details" list. onSelect = single click / Space, onActivate = double click / Enter ("open"). */
export function ListView<T>({ columns, rows, rowKey, selectedKey, onSelect, onActivate, empty = 'Nothing here.' }: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  selectedKey?: string | null
  onSelect?: (row: T) => void
  onActivate?: (row: T) => void
  empty?: ReactNode
}) {
  return (
    <div className="listview-wrap">
      <table className="listview">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.align === 'right' ? 'right' : undefined}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} className="muted" style={{ padding: 14, textAlign: 'center' }}>{empty}</td></tr>
          )}
          {rows.map((r) => {
            const k = rowKey(r)
            return (
              <tr
                key={k}
                className={onSelect ? 'selectable' : undefined}
                aria-selected={selectedKey === k}
                tabIndex={onSelect ? 0 : undefined}
                onClick={onSelect ? () => onSelect(r) : undefined}
                onDoubleClick={onActivate ? () => onActivate(r) : undefined}
                onKeyDown={onSelect ? (e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  if (e.key === 'Enter' && onActivate) onActivate(r)
                  else onSelect(r)
                } : undefined}
              >
                {columns.map((c) => <td key={c.key} className={c.align === 'right' ? 'right' : undefined}>{c.render(r)}</td>)}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Decorative File / Edit / View strip. */
export function MenuBar({ items = ['File', 'Edit', 'View', 'Help'] }: { items?: string[] }) {
  return <div className="menubar" aria-hidden="true">{items.map((i) => <span key={i}>{i}</span>)}</div>
}

export function StatusBar({ children }: { children: ReactNode }) {
  return <footer className="statusbar">{children}</footer>
}

export function Callout({ icon = '💡', warn, children }: { icon?: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className={`callout ${warn ? 'warn' : ''}`}>
      <span aria-hidden="true">{icon}</span>
      <div>{children}</div>
    </div>
  )
}

/** Live hh:mm:ss until `to` (ms timestamp). */
export function Countdown({ to }: { to: number }) {
  const now = useNow(1000)
  return <span className="num">{fmtCountdown(to - now)}</span>
}
