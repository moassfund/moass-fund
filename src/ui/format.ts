const nf = (min: number, max: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

export const fmtNum = (v: number, digits = 2) => (Number.isFinite(v) ? nf(digits, digits).format(v) : '--')
export const fmtCompact = (v: number) => (Number.isFinite(v) ? compact.format(v) : '--')

/** $1,234.56 below 100k, $1.23M above. */
export const fmtUsd = (v: number, digits = 2) =>
  !Number.isFinite(v) ? '--' : Math.abs(v) >= 100_000 ? `$${compact.format(v)}` : `$${nf(digits, digits).format(v)}`

/** Fraction to percent: 0.085 → "8.50%". Huge APYs go compact: "2.6K%". */
export const fmtPct = (frac: number, digits = 2) => {
  if (!Number.isFinite(frac)) return '--'
  const p = frac * 100
  return Math.abs(p) >= 10_000 ? `${compact.format(p)}%` : `${nf(digits, digits).format(p)}%`
}
export const fmtSignedPct = (frac: number, digits = 2) => `${frac >= 0 ? '+' : ''}${fmtPct(frac, digits)}`
export const fmtSignedUsd = (v: number) => `${v >= 0 ? '+' : '-'}${fmtUsd(Math.abs(v))}`
export const toneOf = (v: number): 'up' | 'down' => (v >= 0 ? 'up' : 'down')

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** "2d 4h", "5h 12m", "9m" */
export const fmtDuration = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

export const fmtDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Parse a user-typed amount. Returns 0 for anything unusable. */
export const parseAmount = (s: string) => {
  const v = Number.parseFloat(s)
  return Number.isFinite(v) && v > 0 ? v : 0
}
