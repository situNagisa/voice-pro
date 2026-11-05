import { useLayoutEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import {
  compareToTarget,
  referenceMidiAt,
  severityForCents,
} from '../audio/analysis'
import type { RawUserPoint, Severity } from '../audio/analysis'
import { centsFromNearestNote, clamp, freqToMidi, midiToNoteName } from '../audio/pitch'
import type { ReferenceMelody } from '../core/types'

interface PitchRollProps {
  melody: ReferenceMelody | null
  pointsRef: RefObject<RawUserPoint[]>
  getNow: () => number
  duration: number
  transpose: number
  octaveAlign: boolean
  tolerance: number
  loop: { start: number; end: number } | null
  mode: 'practice' | 'free'
  active: boolean
}

interface DrawProps extends PitchRollProps {
  practiceRange: { lo: number; hi: number } | null
}

const COLORS: Record<Severity, string> = {
  good: '#3ddc97',
  warn: '#ffb020',
  bad: '#ff5c6c',
  neutral: '#7987a3',
}

const KEY_WHITE = '#2a3140'
const KEY_BLACK = '#151a24'
const NOTE_FILL = 'rgba(52, 217, 195, 0.2)'
const NOTE_ACTIVE_FILL = 'rgba(61, 220, 151, 0.36)'
const NOTE_STROKE = 'rgba(94, 234, 212, 0.65)'

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = (sorted.length - 1) * p
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  if (lo === hi) return sorted[lo]
  const weight = index - lo
  return sorted[lo] * (1 - weight) + sorted[hi] * weight
}

function computePracticeRange(
  melody: ReferenceMelody | null,
  transpose: number,
): { lo: number; hi: number } {
  let values: number[] = []
  if (melody) {
    if (melody.notes.length > 0) {
      values = melody.notes.map((note) => note.midi + transpose)
    } else if (melody.frames.length > 0) {
      const step = Math.max(1, Math.floor(melody.frames.length / 240))
      for (let i = 0; i < melody.frames.length; i += step) {
        const f0 = melody.frames[i].f0
        if (f0 != null) values.push(freqToMidi(f0) + transpose)
      }
    }
  }
  if (values.length === 0) return { lo: 48, hi: 74 }
  values.sort((a, b) => a - b)
  let lo = Math.floor(quantile(values, 0.03)) - 2
  let hi = Math.ceil(quantile(values, 0.97)) + 2
  const center = (lo + hi) / 2
  let span = hi - lo
  if (span < 17) {
    span = 17
    lo = Math.floor(center - span / 2)
    hi = lo + span
  } else if (span > 31) {
    span = 31
    lo = Math.round(center - span / 2)
    hi = lo + span
  }
  return { lo, hi }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

export function PitchRoll(props: PitchRollProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef({ width: 0, height: 0 })
  const freeRangeRef = useRef({ lo: 45, hi: 81 })

  const practiceRange = useMemo(
    () => (props.mode === 'practice' ? computePracticeRange(props.melody, props.transpose) : null),
    [props.mode, props.melody, props.transpose],
  )

  const propsRef = useRef<DrawProps>({ ...props, practiceRange })
  useLayoutEffect(() => {
    propsRef.current = { ...props, practiceRange }
  })

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return

    const resize = () => {
      const rect = parent.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      sizeRef.current = { width, height }
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const context = canvas.getContext('2d')
      if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(parent)

    let raf = 0
    const frame = () => {
      draw()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    const draw = () => {
      const context = canvas.getContext('2d')
      const { width, height } = sizeRef.current
      if (!context || width < 2 || height < 2) return
      const p = propsRef.current
      const points = p.pointsRef.current
      const gutter = width < 480 ? 32 : 46
      const plotLeft = gutter
      const plotWidth = width - gutter
      const plotTop = 6
      const plotBottom = height - 16
      const plotHeight = Math.max(20, plotBottom - plotTop)
      const centerX = plotLeft + plotWidth * 0.5
      const pps = width < 540 ? 72 : clamp(plotWidth / 7, 90, 140)

      let now = p.getNow()
      if (!Number.isFinite(now)) now = 0
      if (p.mode === 'practice' && p.duration > 0) now = clamp(now, 0, p.duration)

      let lo: number
      let hi: number
      if (p.mode === 'practice' && p.practiceRange) {
        lo = p.practiceRange.lo
        hi = p.practiceRange.hi
      } else {
        const range = freeRangeRef.current
        const latest = points.length > 0 ? points[points.length - 1] : null
        if (latest) {
          let guard = 0
          while (latest.midi > range.hi - 2 && guard < 4) {
            range.lo += 12
            range.hi += 12
            guard++
          }
          while (latest.midi < range.lo + 2 && guard < 8) {
            range.lo -= 12
            range.hi -= 12
            guard++
          }
          range.lo = clamp(range.lo, 12, 96)
          range.hi = clamp(range.hi, range.lo + 16, 112)
        }
        lo = range.lo
        hi = range.hi
      }

      const span = Math.max(6, hi - lo)
      const rowHeight = plotHeight / span
      const yFor = (midi: number) => plotTop + ((hi - midi) / span) * plotHeight
      const xFor = (time: number) => centerX + (time - now) * pps

      context.clearRect(0, 0, width, height)
      const background = context.createLinearGradient(0, 0, 0, height)
      background.addColorStop(0, '#0b0f18')
      background.addColorStop(1, '#080b12')
      context.fillStyle = background
      context.fillRect(0, 0, width, height)

      const minMidi = Math.ceil(lo)
      const maxMidi = Math.floor(hi)
      const visibleStart = now - (centerX - plotLeft) / pps
      const visibleEnd = now + (width - centerX) / pps

      // 钢琴卷帘行与横向网格
      for (let midi = minMidi; midi <= maxMidi; midi++) {
        const pitchClass = ((midi % 12) + 12) % 12
        const isBlack = [1, 3, 6, 8, 10].includes(pitchClass)
        const yCenter = yFor(midi)
        const yTop = yCenter - rowHeight / 2
        if (isBlack) {
          context.fillStyle = 'rgba(255,255,255,0.022)'
          context.fillRect(plotLeft, yTop, plotWidth, rowHeight)
        }
        context.strokeStyle = pitchClass === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)'
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(plotLeft, Math.round(yTop) + 0.5)
        context.lineTo(width, Math.round(yTop) + 0.5)
        context.stroke()
      }

      // 键盘
      context.fillStyle = '#0d121d'
      context.fillRect(0, 0, gutter, height)
      for (let midi = minMidi; midi <= maxMidi; midi++) {
        const pitchClass = ((midi % 12) + 12) % 12
        const isBlack = [1, 3, 6, 8, 10].includes(pitchClass)
        const yCenter = yFor(midi)
        const yTop = Math.max(0, yCenter - rowHeight / 2)
        const yBottom = Math.min(height, yCenter + rowHeight / 2)
        const rowH = yBottom - yTop
        if (rowH <= 0) continue
        context.fillStyle = isBlack ? KEY_BLACK : KEY_WHITE
        context.fillRect(1, yTop, gutter - 3, Math.max(1, rowH - 1))
        if (isBlack) {
          context.fillStyle = 'rgba(0,0,0,0.28)'
          context.fillRect(gutter - 8, yTop, 7, rowH)
        }
        const showLabel =
          pitchClass === 0 ||
          (rowHeight >= 15 && !isBlack) ||
          (rowHeight >= 20 && isBlack)
        if (showLabel && rowH >= 7) {
          const name = midiToNoteName(midi)
          context.fillStyle = pitchClass === 0 ? '#dbe4f7' : isBlack ? '#8c98b0' : '#aab5cb'
          const fontSize = Math.min(10, Math.max(7, rowH * 0.66))
          context.font = `${pitchClass === 0 ? '600' : '500'} ${fontSize}px system-ui, -apple-system, "PingFang SC", sans-serif`
          context.textAlign = 'left'
          context.textBaseline = 'middle'
          context.fillText(name.label, 5, yCenter)
        }
      }
      context.strokeStyle = 'rgba(255,255,255,0.14)'
      context.beginPath()
      context.moveTo(plotLeft + 0.5, 0)
      context.lineTo(plotLeft + 0.5, height)
      context.stroke()

      // 时间刻度
      const tickStep = pps >= 100 ? 1 : 2
      const firstTick = Math.ceil(visibleStart / tickStep) * tickStep
      context.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.textAlign = 'center'
      context.textBaseline = 'bottom'
      for (let t = firstTick; t <= visibleEnd; t += tickStep) {
        if (t < 0) continue
        const x = xFor(t)
        if (x < plotLeft + 2) continue
        context.strokeStyle = 'rgba(255,255,255,0.03)'
        context.beginPath()
        context.moveTo(Math.round(x) + 0.5, plotTop)
        context.lineTo(Math.round(x) + 0.5, plotBottom)
        context.stroke()
        const m = Math.floor(t / 60)
        const sec = Math.floor(t % 60)
        context.fillStyle = 'rgba(180,192,214,0.38)'
        context.fillText(`${m}:${sec.toString().padStart(2, '0')}`, x, height - 2)
      }

      // 循环范围
      if (p.loop) {
        const xA = xFor(p.loop.start)
        const xB = xFor(p.loop.end)
        context.save()
        context.beginPath()
        context.rect(plotLeft, 0, plotWidth, height)
        context.clip()
        context.fillStyle = 'rgba(0,0,0,0.3)'
        if (xA > plotLeft) context.fillRect(plotLeft, 0, Math.min(xA - plotLeft, plotWidth), height)
        if (xB < width) context.fillRect(Math.max(plotLeft, xB), 0, width - Math.max(plotLeft, xB), height)
        context.restore()

        context.strokeStyle = 'rgba(255,176,32,0.5)'
        context.lineWidth = 1.5
        context.setLineDash([4, 5])
        if (xA >= plotLeft) {
          context.beginPath()
          context.moveTo(xA, plotTop)
          context.lineTo(xA, plotBottom)
          context.stroke()
        }
        if (xB <= width) {
          context.beginPath()
          context.moveTo(xB, plotTop)
          context.lineTo(xB, plotBottom)
          context.stroke()
        }
        context.setLineDash([])
      }

      // 参考音符条块
      if (p.melody && p.mode === 'practice') {
        context.save()
        context.beginPath()
        context.rect(plotLeft, 0, plotWidth, height)
        context.clip()
        for (const note of p.melody.notes) {
          const midi = note.midi + p.transpose
          const x1 = xFor(note.start + 0.01)
          const x2 = xFor(note.end - 0.01)
          if (x2 < plotLeft - 4 || x1 > width + 4) continue
          const yCenter = yFor(midi)
          if (yCenter < plotTop - rowHeight || yCenter > plotBottom + rowHeight) continue
          const blockHeight = clamp(rowHeight * 0.62, 5, 14)
          const active = now >= note.start - 0.02 && now <= note.end + 0.02
          const widthPx = Math.max(3, x2 - x1)
          roundRect(context, x1, yCenter - blockHeight / 2, widthPx, blockHeight, Math.min(4, blockHeight / 2))
          context.fillStyle = active ? NOTE_ACTIVE_FILL : NOTE_FILL
          context.fill()
          context.strokeStyle = active ? 'rgba(94,234,212,0.95)' : NOTE_STROKE
          context.lineWidth = active ? 1.4 : 1
          context.stroke()
          if (widthPx > 30 && rowHeight > 10) {
            context.save()
            context.beginPath()
            context.rect(x1, yCenter - blockHeight, widthPx, blockHeight * 2)
            context.clip()
            context.fillStyle = 'rgba(225,255,250,0.82)'
            const fontSize = clamp(rowHeight * 0.42, 8, 10)
            context.font = `600 ${fontSize}px system-ui, -apple-system, "PingFang SC", sans-serif`
            context.textAlign = 'left'
            context.textBaseline = 'middle'
            context.fillText(midiToNoteName(midi).label, x1 + 4, yCenter + 0.5)
            context.restore()
          }
        }
        context.restore()
      }

      // 用户音高曲线
      const startIndex = Math.max(0, points.length - 5000)
      let previous: { t: number; x: number; y: number } | null = null
      let lastDrawn: { x: number; y: number; color: string; midi: number; cents: number | null } | null = null

      const comparisonFor = (
        midi: number,
        time: number,
        free: boolean,
      ): { cents: number | null; color: string; plotMidi: number; octaveShift: number } => {
        if (free) {
          const cents = centsFromNearestNote(midi)
          return {
            cents,
            color: COLORS[severityForCents(cents, p.tolerance)],
            plotMidi: midi,
            octaveShift: 0,
          }
        }
        const target = p.melody ? referenceMidiAt(p.melody, time, p.transpose) : null
        if (target == null) return { cents: null, color: COLORS.neutral, plotMidi: midi, octaveShift: 0 }
        const comparison = compareToTarget(midi, target, p.octaveAlign, p.tolerance)
        return {
          cents: comparison.cents,
          color: COLORS[comparison.severity],
          plotMidi: midi + comparison.octaveShift * 12,
          octaveShift: comparison.octaveShift,
        }
      }

      context.save()
      context.beginPath()
      context.rect(plotLeft, 0, plotWidth, height)
      context.clip()
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.lineWidth = 2.6
      let lastPoint: RawUserPoint | null = null
      for (let i = startIndex; i < points.length; i++) {
        const point = points[i]
        if (point.t < visibleStart - 0.5 || point.t > visibleEnd + 0.5) {
          previous = null
          continue
        }
        const info = comparisonFor(point.midi, point.t, p.mode === 'free')
        const x = xFor(point.t)
        const y = yFor(info.plotMidi)
        if (
          previous &&
          point.t >= previous.t &&
          point.t - previous.t <= 0.14 &&
          Math.abs(x - previous.x) < pps * 0.3
        ) {
          context.strokeStyle = info.color
          context.beginPath()
          context.moveTo(previous.x, previous.y)
          context.lineTo(x, y)
          context.stroke()
        }
        previous = { t: point.t, x, y }
        lastPoint = point
        lastDrawn = { x, y, color: info.color, midi: info.plotMidi, cents: info.cents }
      }

      if (lastPoint && lastDrawn) {
        const age = now - lastPoint.t
        if (age < 2.5 && age > -0.3) {
          const opacity = age > 0.9 ? clamp(1 - (age - 0.9) / 1.6, 0, 1) : 1
          context.globalAlpha = opacity
          context.fillStyle = '#ffffff'
          context.beginPath()
          context.arc(lastDrawn.x, lastDrawn.y, 4.4, 0, Math.PI * 2)
          context.fill()
          context.fillStyle = lastDrawn.color
          context.beginPath()
          context.arc(lastDrawn.x, lastDrawn.y, 2.7, 0, Math.PI * 2)
          context.fill()
          if (lastDrawn.cents != null && Math.abs(lastDrawn.cents) > p.tolerance) {
            const arrow = lastDrawn.cents > 0 ? '↑' : '↓'
            context.fillStyle = lastDrawn.color
            context.font = '700 14px system-ui, -apple-system, "PingFang SC", sans-serif'
            context.textAlign = 'left'
            context.textBaseline = 'middle'
            context.fillText(arrow, lastDrawn.x + 8, lastDrawn.y - 9)
          }
          context.globalAlpha = 1

          if (lastDrawn.midi < lo + 0.4 || lastDrawn.midi > hi - 0.4) {
            context.fillStyle = 'rgba(255,176,32,0.9)'
            context.font = '600 11px system-ui, -apple-system, "PingFang SC", sans-serif'
            context.textAlign = 'center'
            context.textBaseline = 'bottom'
            context.fillText(
              lastDrawn.midi < lo ? '你的音高在视图下方 ↓' : '你的音高在视图上方 ↑',
              centerX,
              height - 22,
            )
          }
        }
      }

      if (points.length === 0 && p.active) {
        context.fillStyle = 'rgba(200,211,231,0.4)'
        context.font = '13px system-ui, -apple-system, "PingFang SC", sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText('等待声音…', centerX, (plotTop + plotBottom) / 2)
      }
      context.restore()

      // 自由练习：最近半音目标线
      if (p.mode === 'free' && points.length > 0) {
        const latest = points[points.length - 1]
        const nearest = Math.round(latest.midi)
        const y = yFor(nearest)
        context.strokeStyle = 'rgba(255,255,255,0.12)'
        context.setLineDash([5, 6])
        context.beginPath()
        context.moveTo(plotLeft, y)
        context.lineTo(width, y)
        context.stroke()
        context.setLineDash([])
        context.fillStyle = 'rgba(220,230,247,0.42)'
        context.font = '600 10px system-ui, -apple-system, "PingFang SC", sans-serif'
        context.textAlign = 'right'
        context.textBaseline = 'middle'
        context.fillText(midiToNoteName(nearest).label, width - 7, y - 8)
      }

      // 中线与“现在”标记
      context.strokeStyle = 'rgba(139,124,255,0.78)'
      context.lineWidth = 1.5
      context.beginPath()
      context.moveTo(centerX + 0.5, plotTop)
      context.lineTo(centerX + 0.5, plotBottom)
      context.stroke()
      roundRect(context, centerX - 18, 3, 36, 17, 8)
      context.fillStyle = 'rgba(139,124,255,0.92)'
      context.fill()
      context.fillStyle = '#ffffff'
      context.font = '600 9px system-ui, -apple-system, "PingFang SC", sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText('现在', centerX, 11.5)
    }

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  return (
    <div className={`pitch-roll ${props.mode}`}>
      <canvas ref={canvasRef} role="img" aria-label="音高钢琴卷帘图" />
    </div>
  )
}
