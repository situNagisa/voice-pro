import { useId } from 'react'

export interface TrendPoint {
  /** 横轴位置，可以是第几天或第几次 */
  x: number
  value: number
  /** 悬停提示，例如“7/12 · 82%” */
  label?: string
}

interface TrendChartProps {
  points: TrendPoint[]
  xMax: number
  xLabels?: [string, string]
  ariaLabel: string
  variant?: 'accent' | 'good'
  formatValue?: (value: number) => string
}

const WIDTH = 360
const HEIGHT = 150
const PAD = { left: 30, right: 10, top: 12, bottom: 24 }

/** 0–100 的轻量折线图，用于命中率与得分趋势。 */
export function TrendChart({
  points,
  xMax,
  xLabels,
  ariaLabel,
  variant = 'accent',
  formatValue,
}: TrendChartProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const gradientId = `trend-fill-${rawId}`
  const plotWidth = WIDTH - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const safeMax = Math.max(1, xMax)
  const sorted = points.slice().sort((a, b) => a.x - b.x)
  const xFor = (x: number) => PAD.left + (Math.max(0, Math.min(safeMax, x)) / safeMax) * plotWidth
  const yFor = (value: number) =>
    PAD.top + (1 - Math.max(0, Math.min(100, value)) / 100) * plotHeight

  const line = sorted
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point.x).toFixed(1)} ${yFor(point.value).toFixed(1)}`)
    .join(' ')
  const area =
    sorted.length > 0
      ? `${line} L ${xFor(sorted[sorted.length - 1].x).toFixed(1)} ${PAD.top + plotHeight} L ${xFor(sorted[0].x).toFixed(1)} ${PAD.top + plotHeight} Z`
      : ''
  const format = formatValue ?? ((value: number) => `${value}`)

  return (
    <div className={`trend-chart ${variant}`}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="trend-stop-top" />
            <stop offset="1" className="trend-stop-bottom" />
          </linearGradient>
        </defs>
        {[100, 50, 0].map((value) => (
          <g key={value}>
            <line
              className="trend-grid"
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={yFor(value)}
              y2={yFor(value)}
            />
            <text className="trend-y-label" x={PAD.left - 6} y={yFor(value) + 3.5} textAnchor="end">
              {value}
            </text>
          </g>
        ))}
        {area && <path d={area} fill={`url(#${gradientId})`} />}
        {line && <path className="trend-line" d={line} />}
        {sorted.map((point, index) => (
          <circle
            key={`${point.x}-${index}`}
            className="trend-dot"
            cx={xFor(point.x)}
            cy={yFor(point.value)}
            r={3.2}
          >
            <title>{point.label ?? format(point.value)}</title>
          </circle>
        ))}
        {xLabels && (
          <>
            <text className="trend-x-label" x={PAD.left} y={HEIGHT - 5} textAnchor="start">
              {xLabels[0]}
            </text>
            <text className="trend-x-label" x={WIDTH - PAD.right} y={HEIGHT - 5} textAnchor="end">
              {xLabels[1]}
            </text>
          </>
        )}
      </svg>
    </div>
  )
}
