import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { compareToTarget, pointTranspose, referenceMidiAt } from '../audio/analysis'
import type { RawUserPoint } from '../audio/analysis'
import { centsFromNearestNote, clamp, formatCents, freqToMidi, midiToNoteName } from '../audio/pitch'
import type { ReferenceMelody } from '../core/types'

export interface PitchRollProps {
  melody: ReferenceMelody | null
  pointsRef: RefObject<RawUserPoint[]>
  duration: number
  transpose: number
  octaveAlign: boolean
  tolerance: number
  mode: 'practice' | 'free'
  /** 回放/播放头时间（秒） */
  getPlayhead: () => number
  /** 视图中心时间（秒） */
  getCenter: () => number
  /** 用户点选的时间；null 表示未选 */
  getCursor?: () => number | null
  loop?: { start: number; end: number } | null
  highlight?: { start: number; end: number } | null
  active?: boolean
  interactive?: boolean
  onPan?: (deltaSeconds: number) => void
  onPick?: (time: number) => void
  ariaLabel?: string
  /** 播放头徽标文字，默认“现在”；回看页可改成“回看” */
  playheadLabel?: string
  /** 滚轮缩放时间轴，默认开启 */
  zoomable?: boolean
  /** 鼠标悬停显示该点音名与偏差，默认开启 */
  hoverable?: boolean
}

interface DrawProps extends PitchRollProps {
  practiceRange: { lo: number; hi: number } | null
}

const COLORS = {
  good: '#2ec4a0',
  sharp: '#e8a33d',
  flat: '#5aa9f5',
  neutral: '#7e879a',
} as const

const BLACK_KEYS = [1, 3, 6, 8, 10]
const WHITE_KEY = '#e2e7f1'
const BLACK_KEY = '#1b2029'
const BAR_FILL = 'rgba(143, 125, 255, 0.28)'
const BAR_STROKE = 'rgba(184, 173, 255, 0.85)'
const ACCENT = '#8f7dff'
/** 底部时间刻度条带高度，与曲线绘制区完全分开 */
const TIME_BAND = 22

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
  if (span < 16) {
    span = 16
    lo = Math.floor(center - span / 2)
    hi = lo + span
  } else if (span > 30) {
    span = 30
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

function lowerBound(points: RawUserPoint[], time: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 与手机的 9 秒窗口相比，桌面显示 14 秒，让卷帘更像编辑器 */
function basePpsFor(width: number): number {
  const gutter = width < 480 ? 34 : 48
  const plotWidth = Math.max(1, width - gutter)
  if (width < 540) return 54
  const seconds = width < 900 ? 10 : 14
  return clamp(plotWidth / seconds, 42, 112)
}

function nearest(points: RawUserPoint[], time: number): RawUserPoint | null {
  if (points.length === 0) return null
  let index = lowerBound(points, time)
  if (index >= points.length) index = points.length - 1
  const a = points[index]
  const b = points[index - 1]
  if (!b) return a
  return Math.abs(a.t - time) <= Math.abs(b.t - time) ? a : b
}

export function PitchRoll(props: PitchRollProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef(0)
  const sizeRef = useRef({ width: 0, height: 0 })
  const freeRangeRef = useRef({ lo: 48, hi: 74 })
  const zoomRef = useRef(1)
  const hoverRef = useRef<{ time: number; x: number; y: number } | null>(null)
  const pointerRef = useRef<{
    id: number
    startX: number
    lastX: number
    moved: boolean
  } | null>(null)

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
      const dpr = Math.min(3, window.devicePixelRatio || 1)
      sizeRef.current = { width, height }
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const context = canvas.getContext('2d')
      if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(parent)

    const frame = () => {
      draw()
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)

    const draw = () => {
      const context = canvas.getContext('2d')
      const { width, height } = sizeRef.current
      if (!context || width < 2 || height < 2) return
      const p = propsRef.current
      const points = p.pointsRef.current
      const gutter = width < 480 ? 34 : 48
      const plotLeft = gutter
      const plotWidth = width - gutter
      const plotTop = 10
      const plotBottom = Math.max(plotTop + 24, height - TIME_BAND)
      const plotHeight = Math.max(20, plotBottom - plotTop)
      const centerX = plotLeft + plotWidth / 2
      const pps = basePpsFor(width) * zoomRef.current

      let playhead = p.getPlayhead()
      if (!Number.isFinite(playhead)) playhead = 0
      if (p.duration > 0) playhead = clamp(playhead, 0, p.duration)
      let center = p.getCenter()
      if (!Number.isFinite(center)) center = playhead
      if (p.duration > 0) center = clamp(center, 0, p.duration)
      const cursorRaw = p.getCursor?.() ?? null

      let lo: number
      let hi: number
      if (p.mode === 'practice' && p.practiceRange) {
        lo = p.practiceRange.lo
        hi = p.practiceRange.hi
      } else {
        const range = freeRangeRef.current
        const referencePoint = cursorRaw != null
          ? nearest(points, cursorRaw)
          : nearest(points, playhead)
        if (referencePoint) {
          let guard = 0
          while (referencePoint.midi > range.hi - 2 && guard < 5) {
            range.lo += 12
            range.hi += 12
            guard++
          }
          while (referencePoint.midi < range.lo + 2 && guard < 10) {
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
      const xFor = (time: number) => centerX + (time - center) * pps
      const visibleStart = center - (centerX - plotLeft) / pps
      const visibleEnd = center + (width - centerX) / pps

      context.clearRect(0, 0, width, height)
      const background = context.createLinearGradient(0, 0, 0, height)
      background.addColorStop(0, '#12161f')
      background.addColorStop(1, '#0c1017')
      context.fillStyle = background
      context.fillRect(0, 0, width, height)

      const minMidi = Math.ceil(lo)
      const maxMidi = Math.floor(hi)

      // 横向音高行
      for (let midi = minMidi; midi <= maxMidi; midi++) {
        const pitchClass = ((midi % 12) + 12) % 12
        const isBlack = BLACK_KEYS.includes(pitchClass)
        const yCenter = yFor(midi)
        const yTop = yCenter - rowHeight / 2
        if (isBlack) {
          context.fillStyle = 'rgba(255,255,255,0.05)'
          context.fillRect(plotLeft, yTop, plotWidth, rowHeight)
        }
        context.strokeStyle = pitchClass === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.085)'
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(plotLeft, Math.round(yTop) + 0.5)
        context.lineTo(width, Math.round(yTop) + 0.5)
        context.stroke()
      }

      // 钢琴键：只铺到时间条带上沿，音名最小 11px
      context.fillStyle = '#0b0d13'
      context.fillRect(0, 0, gutter, plotBottom)
      for (let midi = minMidi; midi <= maxMidi; midi++) {
        const pitchClass = ((midi % 12) + 12) % 12
        const isBlack = BLACK_KEYS.includes(pitchClass)
        const yCenter = yFor(midi)
        const yTop = Math.max(0, yCenter - rowHeight / 2)
        const yBottom = Math.min(plotBottom, yCenter + rowHeight / 2)
        const rowH = yBottom - yTop
        if (rowH <= 0) continue
        context.fillStyle = isBlack ? BLACK_KEY : WHITE_KEY
        context.fillRect(1, yTop, gutter - 3, Math.max(1, rowH - 1))
        if (isBlack) {
          context.fillStyle = 'rgba(0,0,0,0.32)'
          context.fillRect(gutter - 7, yTop, 6, rowH)
        }
        const name = midiToNoteName(midi)
        const showLabel =
          yCenter < plotBottom - 7 &&
          (pitchClass === 0 || (rowH >= 11.5 && !isBlack) || (rowH >= 20 && isBlack))
        if (showLabel) {
          context.fillStyle = isBlack ? '#7c8698' : '#202633'
          const fontSize = Math.round(clamp(rowH * 0.72, 11, 12))
          context.font = `${pitchClass === 0 ? '700' : '600'} ${fontSize}px system-ui, -apple-system, "PingFang SC", sans-serif`
          context.textAlign = 'left'
          context.textBaseline = 'middle'
          context.fillText(name.label, 5, yCenter)
        }
      }
      context.strokeStyle = 'rgba(255,255,255,0.16)'
      context.beginPath()
      context.moveTo(plotLeft + 0.5, 0)
      context.lineTo(plotLeft + 0.5, plotBottom)
      context.stroke()

      context.save()
      context.beginPath()
      context.rect(plotLeft, 0, plotWidth, plotBottom)
      context.clip()

      // 时间网格（文字刻度留到最后画在底部条带里）
      const tickStep = pps >= 90 ? 1 : pps >= 45 ? 2 : 5
      const firstTick = Math.ceil(visibleStart / tickStep) * tickStep
      for (let t = firstTick; t <= visibleEnd; t += tickStep) {
        if (t < 0) continue
        if (p.duration > 0 && t > p.duration + 0.5) continue
        const x = xFor(t)
        if (x < plotLeft + 8) continue
        context.strokeStyle = 'rgba(255,255,255,0.06)'
        context.beginPath()
        context.moveTo(Math.round(x) + 0.5, plotTop)
        context.lineTo(Math.round(x) + 0.5, plotBottom)
        context.stroke()
      }

      // 乐句高亮
      if (p.highlight) {
        const x1 = xFor(p.highlight.start)
        const x2 = xFor(p.highlight.end)
        context.fillStyle = 'rgba(143,125,255,0.09)'
        context.fillRect(x1, plotTop, Math.max(2, x2 - x1), plotBottom - plotTop)
      }

      // 循环范围
      if (p.loop) {
        const xA = xFor(p.loop.start)
        const xB = xFor(p.loop.end)
        context.fillStyle = 'rgba(0,0,0,0.34)'
        if (xA > plotLeft) context.fillRect(plotLeft, 0, xA - plotLeft, height)
        if (xB < width) context.fillRect(xB, 0, width - xB, height)
        context.strokeStyle = 'rgba(232,163,61,0.5)'
        context.lineWidth = 1.5
        context.setLineDash([4, 5])
        for (const x of [xA, xB]) {
          if (x < plotLeft || x > width) continue
          context.beginPath()
          context.moveTo(x, plotTop)
          context.lineTo(x, plotBottom)
          context.stroke()
        }
        context.setLineDash([])
      }

      // 参考音符圆角条
      if (p.melody && p.mode === 'practice') {
        for (const note of p.melody.notes) {
          const midi = note.midi + p.transpose
          const x1 = xFor(note.start + 0.01)
          const x2 = xFor(note.end - 0.01)
          if (x2 < plotLeft - 4 || x1 > width + 4) continue
          const yCenter = yFor(midi)
          if (yCenter < plotTop - rowHeight || yCenter > plotBottom + rowHeight) continue
          const blockHeight = clamp(rowHeight * 0.56, 5, 13)
          const rectWidth = Math.max(3, x2 - x1)
          const active = playhead >= note.start - 0.02 && playhead <= note.end + 0.02
          const gradient = context.createLinearGradient(0, yCenter - blockHeight / 2, 0, yCenter + blockHeight / 2)
          gradient.addColorStop(0, active ? 'rgba(190,179,255,0.62)' : BAR_FILL)
          gradient.addColorStop(1, active ? 'rgba(143,125,255,0.34)' : 'rgba(143,125,255,0.18)')
          roundRect(context, x1, yCenter - blockHeight / 2, rectWidth, blockHeight, Math.min(4, blockHeight / 2))
          context.fillStyle = gradient
          context.fill()
          context.strokeStyle = active ? 'rgba(196,186,255,0.95)' : BAR_STROKE
          context.lineWidth = active ? 1.4 : 1
          context.stroke()
          if (rectWidth > 26 && rowHeight > 10) {
            context.save()
            context.beginPath()
            context.rect(x1, yCenter - blockHeight, rectWidth, blockHeight * 2)
            context.clip()
            context.fillStyle = 'rgba(236,232,255,0.78)'
            const fontSize = clamp(rowHeight * 0.4, 8, 10)
            context.font = `600 ${fontSize}px system-ui, -apple-system, "PingFang SC", sans-serif`
            context.textAlign = 'left'
            context.textBaseline = 'middle'
            context.fillText(midiToNoteName(midi).label, x1 + 4, yCenter + 0.5)
            context.restore()
          }
        }
      }

      // 用户曲线：只取可见范围，分段绘制并轻微发光
      const from = Math.max(0, lowerBound(points, visibleStart - 0.4) - 2)
      const to = Math.min(points.length, lowerBound(points, visibleEnd + 0.4) + 2)
      let previous: { t: number; x: number; y: number; color: string } | null = null
      let lastName: { midi: number; color: string; cents: number | null } | null = null
      let lastPoint: RawUserPoint | null = null
      context.lineCap = 'round'
      context.lineJoin = 'round'
      for (let i = from; i < to; i++) {
        const point = points[i]
        let color: string
        let plotMidi = point.midi
        let cents: number | null = null
        if (p.mode === 'free') {
          cents = centsFromNearestNote(point.midi)
          color = Math.abs(cents) <= p.tolerance
            ? COLORS.good
            : cents > 0
              ? COLORS.sharp
              : COLORS.flat
        } else {
          const shift = pointTranspose(point, p.transpose)
          const target = p.melody ? referenceMidiAt(p.melody, point.t, shift) : null
          if (target == null) {
            color = COLORS.neutral
          } else {
            const comparison = compareToTarget(point.midi, target, p.octaveAlign, p.tolerance)
            color = Math.abs(comparison.cents) <= p.tolerance
              ? COLORS.good
              : comparison.cents > 0
                ? COLORS.sharp
                : COLORS.flat
            plotMidi = point.midi + comparison.octaveShift * 12
            cents = comparison.cents
          }
        }
        const x = xFor(point.t)
        const y = yFor(plotMidi)
        if (
          previous &&
          point.t >= previous.t &&
          point.t - previous.t <= 0.16 &&
          Math.abs(x - previous.x) < pps * 0.4
        ) {
          context.strokeStyle = color
          context.lineWidth = 2.8
          context.shadowColor = color
          context.shadowBlur = 9
          context.beginPath()
          context.moveTo(previous.x, previous.y)
          const midX = (previous.x + x) / 2
          const midY = (previous.y + y) / 2
          context.quadraticCurveTo(previous.x, previous.y, midX, midY)
          context.lineTo(x, y)
          context.stroke()
        }
        previous = { t: point.t, x, y, color }
        lastName = { midi: plotMidi, color, cents }
        lastPoint = point
      }
      context.shadowBlur = 0

      // 最近一个点
      if (lastPoint && lastName) {
        const age = playhead - lastPoint.t
        if (age < 3 && age > -0.4) {
          const opacity = age > 0.9 ? clamp(1 - (age - 0.9) / 2.1, 0, 1) : 1
          context.globalAlpha = opacity
          context.fillStyle = '#f5f7ff'
          const x = xFor(lastPoint.t)
          const y = yFor(lastName.midi)
          context.beginPath()
          context.arc(x, y, 4.6, 0, Math.PI * 2)
          context.fill()
          context.fillStyle = lastName.color
          context.beginPath()
          context.arc(x, y, 2.8, 0, Math.PI * 2)
          context.fill()
          if (lastName.cents != null && Math.abs(lastName.cents) > p.tolerance) {
            context.fillStyle = lastName.color
            context.font = '700 13px system-ui, -apple-system, "PingFang SC", sans-serif'
            context.textAlign = 'left'
            context.textBaseline = 'middle'
            context.fillText(lastName.cents > 0 ? '↑' : '↓', x + 8, y - 8)
          }
          context.globalAlpha = 1
        }
      }

      // 播放头
      const playX = xFor(playhead)
      if (playX >= plotLeft && playX <= width) {
        context.strokeStyle = ACCENT
        context.lineWidth = 1.6
        context.beginPath()
        context.moveTo(playX, plotTop)
        context.lineTo(playX, plotBottom)
        context.stroke()
        roundRect(context, playX - 17, 2, 34, 17, 8)
        context.fillStyle = ACCENT
        context.fill()
        context.fillStyle = '#100d22'
        context.font = '700 10px system-ui, -apple-system, "PingFang SC", sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(p.playheadLabel ?? '现在', playX, 10.5)
      }

      // 点选游标
      if (cursorRaw != null) {
        const cursor = p.duration > 0 ? clamp(cursorRaw, 0, p.duration) : cursorRaw
        const cursorX = xFor(cursor)
        if (cursorX >= plotLeft && cursorX <= width) {
          context.strokeStyle = 'rgba(242,244,249,0.65)'
          context.lineWidth = 1.2
          context.setLineDash([3, 4])
          context.beginPath()
          context.moveTo(cursorX, plotTop)
          context.lineTo(cursorX, plotBottom)
          context.stroke()
          context.setLineDash([])
          const point = nearest(points, cursor)
          if (point && Math.abs(point.t - cursor) < 0.3) {
            const plotMidi = p.mode === 'free'
              ? point.midi
              : (() => {
                  const shift = pointTranspose(point, p.transpose)
                  const target = p.melody ? referenceMidiAt(p.melody, point.t, shift) : null
                  if (target == null) return point.midi
                  return point.midi + compareToTarget(point.midi, target, p.octaveAlign, p.tolerance).octaveShift * 12
                })()
            const y = yFor(plotMidi)
            context.fillStyle = '#f2f4f9'
            context.beginPath()
            context.arc(cursorX, y, 4.2, 0, Math.PI * 2)
            context.fill()
            context.fillStyle = '#10131a'
            context.beginPath()
            context.arc(cursorX, y, 2, 0, Math.PI * 2)
            context.fill()
          }
        }
      }

      // 鼠标悬停：在卷帘上直接读出该点的音名与偏差
      const hover = hoverRef.current
      if (p.hoverable !== false && hover) {
        const hoverTime = p.duration > 0 ? clamp(hover.time, 0, p.duration) : hover.time
        if (
          hoverTime >= visibleStart &&
          hoverTime <= visibleEnd &&
          hover.x >= plotLeft &&
          hover.x <= width &&
          hover.y >= plotTop &&
          hover.y <= plotBottom
        ) {
          const point = nearest(points, hoverTime)
          if (point && Math.abs(point.t - hoverTime) < 0.8) {
            let hoverMidi = point.midi
            let cents: number | null = null
            if (p.mode === 'free') {
              cents = centsFromNearestNote(point.midi)
            } else if (p.melody) {
              const shift = pointTranspose(point, p.transpose)
              const target = referenceMidiAt(p.melody, point.t, shift)
              if (target != null) {
                const comparison = compareToTarget(point.midi, target, p.octaveAlign, p.tolerance)
                cents = comparison.cents
                hoverMidi = point.midi + comparison.octaveShift * 12
              }
            }
            const toneColor =
              cents == null
                ? COLORS.neutral
                : Math.abs(cents) <= p.tolerance
                  ? COLORS.good
                  : cents > 0
                    ? COLORS.sharp
                    : COLORS.flat
            const detail =
              cents == null
                ? '暂无参考'
                : Math.abs(cents) <= p.tolerance
                  ? `${formatCents(cents)} 音分 · 准`
                  : `${formatCents(cents)} 音分 ${cents > 0 ? '↑' : '↓'}`
            const note = midiToNoteName(hoverMidi)
            const px = xFor(point.t)
            const py = yFor(hoverMidi)

            context.strokeStyle = 'rgba(242,244,249,0.28)'
            context.lineWidth = 1
            context.setLineDash([2, 4])
            context.beginPath()
            context.moveTo(px, plotTop)
            context.lineTo(px, plotBottom)
            context.stroke()
            context.setLineDash([])

            context.fillStyle = '#f2f4f9'
            context.beginPath()
            context.arc(px, py, 4.4, 0, Math.PI * 2)
            context.fill()
            context.fillStyle = toneColor
            context.beginPath()
            context.arc(px, py, 2.4, 0, Math.PI * 2)
            context.fill()

            const text = `${note.label} · ${detail}`
            context.font = '600 11.5px system-ui, -apple-system, "PingFang SC", sans-serif'
            const textWidth = context.measureText(text).width
            const boxHeight = 24
            const boxWidth = textWidth + 30
            const boxX = clamp(px + 12, plotLeft + 4, width - boxWidth - 6)
            const boxY = clamp(py - 36, plotTop + 4, plotBottom - boxHeight - 4)
            roundRect(context, boxX, boxY, boxWidth, boxHeight, 8)
            context.fillStyle = 'rgba(8, 10, 16, 0.94)'
            context.fill()
            context.strokeStyle = 'rgba(255,255,255,0.16)'
            context.lineWidth = 1
            context.stroke()
            context.fillStyle = toneColor
            context.beginPath()
            context.arc(boxX + 11, boxY + boxHeight / 2, 3.2, 0, Math.PI * 2)
            context.fill()
            context.fillStyle = '#e9edf6'
            context.textAlign = 'left'
            context.textBaseline = 'middle'
            context.fillText(text, boxX + 19, boxY + boxHeight / 2 + 0.5)
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

      // 底部时间条带：刻度独立成带，不会被用户音高点盖住
      const bandTop = plotBottom
      const bandHeight = height - bandTop
      context.fillStyle = 'rgba(8, 10, 15, 0.94)'
      context.fillRect(0, bandTop, width, bandHeight)
      context.strokeStyle = 'rgba(255,255,255,0.1)'
      context.beginPath()
      context.moveTo(0, bandTop + 0.5)
      context.lineTo(width, bandTop + 0.5)
      context.stroke()

      context.save()
      context.beginPath()
      context.rect(plotLeft, bandTop, plotWidth, bandHeight)
      context.clip()
      context.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      for (let t = firstTick; t <= visibleEnd; t += tickStep) {
        if (t < 0) continue
        if (p.duration > 0 && t > p.duration + 0.5) continue
        const x = xFor(t)
        if (x < plotLeft + 16 || x > width - 18) continue
        const rounded = Math.round(x) + 0.5
        context.strokeStyle = 'rgba(255,255,255,0.18)'
        context.beginPath()
        context.moveTo(rounded, bandTop + 1)
        context.lineTo(rounded, bandTop + 5)
        context.stroke()
        const m = Math.floor(t / 60)
        const sec = Math.floor(t % 60)
        context.fillStyle = 'rgba(203,213,230,0.72)'
        context.fillText(
          `${m}:${sec.toString().padStart(2, '0')}`,
          x,
          bandTop + bandHeight / 2 + 1.5,
        )
      }
      context.restore()
    }

    return () => {
      cancelAnimationFrame(rafRef.current)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      if (propsRef.current.zoomable === false) return
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0018)
      zoomRef.current = clamp(zoomRef.current * factor, 0.4, 3.5)
      hoverRef.current = null
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  function timeAt(clientX: number): number {
    const canvas = canvasRef.current
    if (!canvas) return 0
    const rect = canvas.getBoundingClientRect()
    const width = rect.width
    const gutter = width < 480 ? 34 : 48
    const plotLeft = gutter
    const plotWidth = Math.max(1, width - gutter)
    const pps = basePpsFor(width) * zoomRef.current
    const centerX = plotLeft + plotWidth / 2
    const p = propsRef.current
    let center = p.getCenter()
    if (!Number.isFinite(center)) center = 0
    return center + (clientX - rect.left - centerX) / pps
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!props.interactive) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      moved: false,
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const pointer = pointerRef.current

    if (!pointer || pointer.id !== event.pointerId) {
      if (event.pointerType === 'mouse' && props.hoverable !== false) {
        hoverRef.current = {
          time: timeAt(event.clientX),
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }
      }
      return
    }

    hoverRef.current = null
    const delta = event.clientX - pointer.lastX
    if (Math.abs(event.clientX - pointer.startX) > 5) pointer.moved = true
    if (pointer.moved && props.onPan) {
      const pps = basePpsFor(rect.width) * zoomRef.current
      if (delta !== 0) props.onPan(-delta / pps)
    }
    pointer.lastX = event.clientX
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const pointer = pointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    pointerRef.current = null
    if (!pointer.moved) {
      props.onPick?.(timeAt(event.clientX))
    }
  }

  return (
    <div className={`pitch-roll ${props.mode} ${props.interactive ? 'interactive' : ''}`}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={props.ariaLabel ?? '音高钢琴卷帘图'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          pointerRef.current = null
          hoverRef.current = null
        }}
        onPointerLeave={() => {
          hoverRef.current = null
        }}
      />
    </div>
  )
}
