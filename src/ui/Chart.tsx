// recharts wrappers. Import from '../ui/Chart' (not the barrel) so chart-free apps stay light.
import { useId } from 'react'
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtDay } from './format'

export interface Series {
  key: string
  label: string
  color: string
}

const tooltipStyle = { background: '#ffffe1', border: '1px solid #000', borderRadius: 4, fontSize: 11, padding: '4px 8px' }

/** Time-series area chart. `data` rows need a numeric `t` (ms) plus one field per series key. */
export function AreaChartXP<T extends { t: number }>({ data, series, height = 180, yFormat = String, empty }: {
  data: T[]
  series: Series[]
  height?: number
  yFormat?: (v: number) => string
  /** Shown instead of an empty frame before enough history exists. */
  empty?: string
}) {
  // gradient ids are document-global: scope them per chart so two windows never share a fill
  const uid = useId().replace(/:/g, '')

  // At launch the indexer has one point, or none. recharts happily draws an
  // empty box, which reads as a broken chart rather than a new protocol.
  if (data.length < 2) {
    return (
      <div className="chart-frame chart-empty" style={{ height }}>
        <span className="muted">{empty ?? 'Not enough history yet. Come back after a few epochs.'}</span>
      </div>
    )
  }

  return (
    <div className="chart-frame">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`fill-${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.45} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="#e6e2d3" strokeDasharray="2 3" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={fmtDay} tick={{ fontSize: 10, fill: '#55534a' }} tickLine={false} axisLine={{ stroke: '#aca899' }} minTickGap={40} />
          <YAxis tickFormatter={yFormat} tick={{ fontSize: 10, fill: '#55534a' }} tickLine={false} axisLine={false} width={52} domain={['auto', 'auto']} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => new Date(Number(t)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })} formatter={(v, name) => [yFormat(Number(v)), name]} />
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} fill={`url(#fill-${uid}-${s.key})`} isAnimationActive={false} dot={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export interface Slice {
  name: string
  value: number
  color: string
}

export function DonutXP({ data, height = 180, valueFormat = String }: { data: Slice[]; height?: number; valueFormat?: (v: number) => string }) {
  return (
    <div className="chart-frame">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="88%" paddingAngle={2} stroke="#fff" isAnimationActive={false}>
            {data.map((d) => <Cell key={d.name} fill={d.color} />)}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [valueFormat(Number(v)), name]} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
