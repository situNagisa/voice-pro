/** 把一次练习报告画成一张可保存/分享的 PNG 成绩卡。 */
import { compareToTarget, referenceMidiAt } from '../audio/analysis'
import type { SessionReport } from '../audio/analysis'
import { formatCents } from '../audio/pitch'
import { recordMelody } from '../audio/review'
import type { PracticeRecord } from '../state/records'

const WIDTH = 1080
const HEIGHT = 1440
const ACCENT = '#9a8bff'
const GOOD = '#2ec4a0'
const SHARP = '#e8a33d'
const FLAT = '#5aa9f5'
const TEXT = '#f2f4f9'
const TEXT_2 = '#c3c9d7'
const TEXT_3 = '#8a93a7'

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

function quantile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = (sorted.length - 1) * ratio
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  if (lo === hi) return sorted[lo]
  const weight = index - lo
  return sorted[lo] * (1 - weight) + sorted[hi] * weight
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  font: (size: number) => string,
): { text: string; size: number } {
  let size = maxSize
  let value = text
  while (size > minSize) {
    ctx.font = font(size)
    if (ctx.measureText(value).width <= maxWidth) return { text: value, size }
    size -= 2
  }
  ctx.font = font(size)
  while (value.length > 1 && ctx.measureText(value).width > maxWidth) {
    value = value.slice(0, -1)
  }
  return { text: value.length < text.length ? `${value}…` : value, size }
}

function loadIcon(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = '/icon.svg'
  })
}

function drawBrandMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const gradient = ctx.createLinearGradient(x, y, x + size, y + size)
  gradient.addColorStop(0, ACCENT)
  gradient.addColorStop(1, GOOD)
  roundRect(ctx, x, y, size, size, size * 0.24)
  ctx.fillStyle = '#12101f'
  ctx.fill()
  ctx.strokeStyle = gradient
  ctx.lineWidth = 4
  ctx.stroke()
  const bars = [0.36, 0.24, 0.44, 0.28, 0.36]
  const barWidth = size * 0.075
  const gap = size * 0.085
  const total = bars.length * barWidth + (bars.length - 1) * gap
  const startX = x + (size - total) / 2
  const centerY = y + size / 2
  ctx.fillStyle = ACCENT
  bars.forEach((ratio, index) => {
    const height = size * ratio
    roundRect(
      ctx,
      startX + index * (barWidth + gap),
      centerY - height / 2,
      barWidth,
      height,
      barWidth / 2,
    )
    ctx.fill()
  })
}

function drawIcon(
  ctx: CanvasRenderingContext2D,
  icon: HTMLImageElement | null,
  x: number,
  y: number,
  size: number,
): void {
  if (!icon) {
    drawBrandMark(ctx, x, y, size)
    return
  }
  ctx.save()
  roundRect(ctx, x, y, size, size, size * 0.24)
  ctx.clip()
  ctx.drawImage(icon, x, y, size, size)
  ctx.restore()
}

function drawCurvePanel(
  ctx: CanvasRenderingContext2D,
  record: PracticeRecord,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  roundRect(ctx, x, y, width, height, 28)
  ctx.fillStyle = 'rgba(255,255,255,0.035)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.fillStyle = TEXT_3
  ctx.font = '600 22px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('音高轨迹', x + 28, y + 34)

  const plotLeft = x + 28
  const plotRight = x + width - 28
  const plotTop = y + 64
  const plotBottom = y + height - 38
  const plotWidth = plotRight - plotLeft
  const plotHeight = plotBottom - plotTop

  const melody = recordMelody(record)
  const points = record.points
    .filter((point) => point.clarity >= 0.8 && Number.isFinite(point.midi))
    .slice()
    .sort((a, b) => a.t - b.t)
  const lastPointTime = points.reduce((max, point) => Math.max(max, point.t), 0)
  const duration = Math.max(1, record.melodyDuration, lastPointTime)

  const values: number[] = melody.notes.map((note) => note.midi)
  const curve: { t: number; midi: number; color: string }[] = []
  for (const point of points) {
    const target = referenceMidiAt(melody, point.t, record.transpose)
    let midi = point.midi - record.transpose
    let color = TEXT_3
    if (target != null) {
      const comparison = compareToTarget(point.midi, target, record.octaveAlign, record.tolerance)
      midi += comparison.octaveShift * 12
      color =
        Math.abs(comparison.cents) <= record.tolerance
          ? GOOD
          : comparison.cents > 0
            ? SHARP
            : FLAT
    }
    curve.push({ t: point.t, midi, color })
    values.push(midi)
  }
  if (values.length === 0) {
    ctx.fillStyle = 'rgba(200,211,231,0.55)'
    ctx.font = '24px system-ui, -apple-system, "PingFang SC", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('本次没有可绘制的有效音高', plotLeft + plotWidth / 2, plotTop + plotHeight / 2)
    return
  }

  let lo = Math.floor(quantile(values, 0.02)) - 1
  let hi = Math.ceil(quantile(values, 0.98)) + 1
  if (hi - lo < 12) {
    const center = (lo + hi) / 2
    lo = Math.floor(center - 6)
    hi = lo + 12
  }
  if (hi - lo > 30) {
    const center = (lo + hi) / 2
    lo = Math.floor(center - 15)
    hi = lo + 30
  }
  const span = Math.max(6, hi - lo)
  const xFor = (time: number) => plotLeft + (time / duration) * plotWidth
  const yFor = (midi: number) => plotTop + ((hi - midi) / span) * plotHeight

  const background = ctx.createLinearGradient(0, plotTop, 0, plotBottom)
  background.addColorStop(0, 'rgba(10,12,18,0.0)')
  background.addColorStop(1, 'rgba(10,12,18,0.35)')
  ctx.fillStyle = background
  ctx.fillRect(plotLeft, plotTop, plotWidth, plotHeight)

  for (let line = 0; line <= 3; line++) {
    const gy = plotTop + (plotHeight / 3) * line
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(plotLeft, gy)
    ctx.lineTo(plotRight, gy)
    ctx.stroke()
  }

  for (const note of melody.notes) {
    if (note.midi < lo - 1 || note.midi > hi + 1) continue
    const nx = xFor(note.start)
    const nw = Math.max(2, xFor(note.end) - nx)
    const ny = yFor(note.midi)
    roundRect(ctx, nx, ny - 5, nw, 10, 5)
    ctx.fillStyle = 'rgba(143,125,255,0.28)'
    ctx.fill()
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(plotLeft, plotTop, plotWidth, plotBottom - plotTop)
  ctx.clip()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  let previous: { x: number; y: number; t: number } | null = null
  let drawn: { x: number; y: number } | null = null
  for (const point of curve) {
    const px = xFor(point.t)
    const py = yFor(point.midi)
    if (!previous || point.t - previous.t > 0.2 || point.t < previous.t) {
      drawn = { x: px, y: py }
    } else if (drawn && Math.abs(px - drawn.x) >= 0.7) {
      ctx.strokeStyle = point.color
      ctx.lineWidth = 3
      ctx.shadowColor = point.color
      ctx.shadowBlur = 7
      ctx.beginPath()
      ctx.moveTo(drawn.x, drawn.y)
      ctx.lineTo(px, py)
      ctx.stroke()
      drawn = { x: px, y: py }
    }
    previous = { x: px, y: py, t: point.t }
  }
  if (drawn && previous && (previous.x !== drawn.x || previous.y !== drawn.y)) {
    const last = curve[curve.length - 1]
    ctx.strokeStyle = last.color
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(drawn.x, drawn.y)
    ctx.lineTo(previous.x, previous.y)
    ctx.stroke()
  }
  ctx.shadowBlur = 0
  if (curve.length > 0) {
    const last = curve[curve.length - 1]
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(xFor(last.t), yFor(last.midi), 5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  ctx.fillStyle = TEXT_3
  ctx.font = '500 18px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'left'
  ctx.fillText('0:00', plotLeft, y + height - 18)
  ctx.textAlign = 'right'
  const minutes = Math.floor(duration / 60)
  const seconds = Math.floor(duration % 60)
  ctx.fillText(`${minutes}:${seconds.toString().padStart(2, '0')}`, plotRight, y + height - 18)
}

export interface ScoreCardData {
  grade: string
  report: SessionReport
}

/** 生成 1080×1440 的成绩卡画布。 */
export async function renderScoreCard(
  record: PracticeRecord,
  data: ScoreCardData,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')

  const icon = await loadIcon()

  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
  background.addColorStop(0, '#11131d')
  background.addColorStop(0.55, '#090a11')
  background.addColorStop(1, '#07080c')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  const glowA = ctx.createRadialGradient(900, 120, 0, 900, 120, 520)
  glowA.addColorStop(0, 'rgba(143,125,255,0.28)')
  glowA.addColorStop(1, 'rgba(143,125,255,0)')
  ctx.fillStyle = glowA
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  const glowB = ctx.createRadialGradient(160, 1160, 0, 160, 1160, 420)
  glowB.addColorStop(0, 'rgba(46,196,160,0.13)')
  glowB.addColorStop(1, 'rgba(46,196,160,0)')
  ctx.fillStyle = glowB
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  roundRect(ctx, 48, 48, WIDTH - 96, HEIGHT - 96, 44)
  ctx.strokeStyle = 'rgba(255,255,255,0.09)'
  ctx.lineWidth = 2
  ctx.stroke()

  // 品牌
  drawIcon(ctx, icon, 90, 88, 84)
  ctx.fillStyle = TEXT
  ctx.font = '700 32px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('音准镜', 196, 112)
  ctx.fillStyle = TEXT_3
  ctx.font = '500 20px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('看见每一个音', 196, 148)

  const date = new Date(record.createdAt)
  const dateText = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(
    date.getDate(),
  ).padStart(2, '0')}`
  ctx.fillStyle = TEXT_3
  ctx.font = '500 20px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'right'
  ctx.fillText(dateText, WIDTH - 96, 130)

  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(90, 216)
  ctx.lineTo(WIDTH - 90, 216)
  ctx.stroke()

  // 歌曲与结果
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = ACCENT
  ctx.font = '650 21px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(record.songKind === 'exercise' ? '练声小课' : '本次练习', 92, 270)

  const title = fitText(
    ctx,
    record.songName,
    WIDTH - 200,
    56,
    36,
    (size) => `700 ${size}px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`,
  )
  ctx.fillStyle = TEXT
  ctx.fillText(title.text, 92, 332)

  ctx.fillStyle = TEXT_2
  ctx.font = '500 23px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(`${data.grade} · ${record.loop ? '循环练习' : '完整练习'}`, 92, 380)

  // 分数环
  const score = record.score ?? 0
  const ringX = WIDTH - 230
  const ringY = 500
  const ringR = 126
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 18
  ctx.beginPath()
  ctx.arc(ringX, ringY, ringR, 0, Math.PI * 2)
  ctx.stroke()
  const ringGradient = ctx.createLinearGradient(ringX - ringR, ringY - ringR, ringX + ringR, ringY + ringR)
  ringGradient.addColorStop(0, ACCENT)
  ringGradient.addColorStop(1, GOOD)
  ctx.strokeStyle = ringGradient
  ctx.lineWidth = 18
  ctx.beginPath()
  ctx.arc(ringX, ringY, ringR, -Math.PI / 2, -Math.PI / 2 + (Math.max(0, Math.min(100, score)) / 100) * Math.PI * 2)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = TEXT
  ctx.font = '740 128px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(record.score == null ? '—' : String(record.score), ringX, ringY + 10)
  ctx.fillStyle = TEXT_3
  ctx.font = '500 21px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('总分', ringX, ringY + 54)
  ctx.textBaseline = 'alphabetic'

  // 左侧说明
  ctx.textAlign = 'left'
  ctx.fillStyle = TEXT_2
  ctx.font = '500 23px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('这次唱得怎么样？', 92, 470)
  ctx.fillStyle = TEXT
  ctx.font = '700 64px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(data.grade, 92, 548)
  ctx.fillStyle = TEXT_3
  ctx.font = '500 21px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText(`判定范围 ±${record.tolerance} 音分`, 92, 600)

  // 统计
  const stats = [
    {
      label: '命中率',
      value: data.report.hitRate == null ? '—' : `${Math.round(data.report.hitRate * 100)}%`,
    },
    {
      label: '平均偏差',
      value: data.report.avgCents == null ? '—' : `${formatCents(data.report.avgCents)} 音分`,
    },
    { label: '有效音高', value: `${data.report.validFrames}` },
  ]
  const boxWidth = 280
  const boxGap = 24
  stats.forEach((stat, index) => {
    const boxX = 92 + index * (boxWidth + boxGap)
    roundRect(ctx, boxX, 664, boxWidth, 128, 22)
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fillStyle = TEXT_3
    ctx.font = '500 19px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(stat.label, boxX + 24, 704)
    ctx.fillStyle = TEXT
    ctx.font = '700 38px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.fillText(stat.value, boxX + 24, 756)
  })

  drawCurvePanel(ctx, record, 92, 834, WIDTH - 184, 320)

  // 底部
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(90, 1224)
  ctx.lineTo(WIDTH - 90, 1224)
  ctx.stroke()

  ctx.fillStyle = ACCENT
  ctx.font = '600 23px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('音准镜 · 看见每一个音', 92, 1282)
  ctx.fillStyle = TEXT_3
  ctx.font = '500 19px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillText('所有音频与音高分析都在本机完成，不上传服务器', 92, 1322)
  ctx.textAlign = 'right'
  ctx.font = '600 34px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.fillStyle = 'rgba(154,139,255,0.85)'
  ctx.fillText('Voice Pro', WIDTH - 92, 1300)

  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片生成失败'))
    }, 'image/png')
  })
}

export function scoreCardFileName(record: PracticeRecord): string {
  const safeSong = record.songName.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40)
  const score = record.score == null ? '未评分' : `${record.score}分`
  return `音准镜-${safeSong}-${score}.png`
}

export function shareSupportsFile(file: File): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false
  if (typeof navigator.canShare !== 'function') return true
  try {
    return navigator.canShare({ files: [file] })
  } catch {
    return false
  }
}

export type ShareOutcome = 'shared' | 'cancelled'

export async function shareScoreCard(
  file: File,
  title: string,
  text: string,
): Promise<ShareOutcome> {
  try {
    await navigator.share({ files: [file], title, text })
    return 'shared'
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled'
    throw error
  }
}

export function downloadScoreCard(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2500)
}
