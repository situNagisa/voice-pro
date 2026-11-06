import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionReport } from '../audio/analysis'
import { compareToTarget, evaluateSession, referenceMidiAt } from '../audio/analysis'
import { formatTime, midiToNoteName } from '../audio/pitch'
import { recordMelody } from '../audio/review'
import type { PracticeRecord, PracticeRecordMeta } from '../state/records'
import { loadRecord } from '../state/records'
import { TopBar } from '../ui/controls'
import { ChevronRightIcon } from '../ui/icons'
import { TrendChart } from '../ui/TrendChart'

interface SongProgressViewProps {
  records: PracticeRecordMeta[]
  songName: string
  onBack: () => void
  onOpenRecord: (id: string) => void
}

interface Analysis {
  report: SessionReport
  melodyDuration: number
}

function analyzeRecord(record: PracticeRecord): Analysis {
  const melody = recordMelody(record)
  return {
    report: evaluateSession(record.points, melody, {
      transpose: record.transpose,
      octaveAlign: record.octaveAlign,
      tolerance: record.tolerance,
    }),
    melodyDuration: melody.duration,
  }
}

function dateShort(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function dateTimeShort(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function percent(rate: number | null): number | null {
  return rate == null ? null : Math.round(rate * 100)
}

const COLORS = {
  a: '#5aa9f5',
  b: '#ffa45c',
  good: '#2ec4a0',
  sharp: '#e8a33d',
  flat: '#5aa9f5',
  neutral: '#7e879a',
  bar: 'rgba(143, 125, 255, 0.22)',
  barStroke: 'rgba(184, 173, 255, 0.5)',
} as const

interface CompareRollProps {
  recordA: PracticeRecord
  recordB: PracticeRecord
  highlight: { start: number; end: number } | null
  showA: boolean
  showB: boolean
}

/** 把一次练习的音高曲线还原到原调（并做八度对齐），方便两次叠加。 */
function normalizedCurve(record: PracticeRecord): { t: number; midi: number }[] {
  const melody = recordMelody(record)
  const points = record.points
    .filter((point) => point.clarity >= 0.8 && Number.isFinite(point.midi))
    .slice()
    .sort((a, b) => a.t - b.t)
  const curve: { t: number; midi: number }[] = []
  for (const point of points) {
    let midi = point.midi
    const target = referenceMidiAt(melody, point.t, record.transpose)
    if (target != null) {
      const comparison = compareToTarget(point.midi, target, record.octaveAlign, record.tolerance)
      midi += comparison.octaveShift * 12
    }
    curve.push({ t: point.t, midi: midi - record.transpose })
  }
  return curve
}

function quantileSorted(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = (sorted.length - 1) * ratio
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  if (lo === hi) return sorted[lo]
  const weight = index - lo
  return sorted[lo] * (1 - weight) + sorted[hi] * weight
}

function drawCurve(
  ctx: CanvasRenderingContext2D,
  curve: { t: number; midi: number }[],
  xFor: (time: number) => number,
  yFor: (midi: number) => number,
  color: string,
  lineWidth: number,
  glow: boolean,
  dash: number[] = [],
): void {
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = dash.length > 0 ? 'butt' : 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(dash)
  if (glow) {
    ctx.shadowColor = color
    ctx.shadowBlur = 8
  }
  let previous: { x: number; y: number; t: number } | null = null
  let drawn: { x: number; y: number } | null = null
  for (const point of curve) {
    const x = xFor(point.t)
    const y = yFor(point.midi)
    if (!previous || point.t - previous.t > 0.2 || point.t < previous.t) {
      drawn = { x, y }
    } else if (drawn && Math.abs(x - drawn.x) >= 0.4) {
      ctx.beginPath()
      ctx.moveTo(drawn.x, drawn.y)
      ctx.lineTo(x, y)
      ctx.stroke()
      drawn = { x, y }
    }
    previous = { x, y, t: point.t }
  }
  if (drawn && previous && (previous.x !== drawn.x || previous.y !== drawn.y)) {
    ctx.beginPath()
    ctx.moveTo(drawn.x, drawn.y)
    ctx.lineTo(previous.x, previous.y)
    ctx.stroke()
  }
  ctx.shadowBlur = 0
  ctx.setLineDash([])
}

function CompareRoll({ recordA, recordB, highlight, showA, showB }: CompareRollProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    let frame = 0

    const draw = () => {
      const rect = wrap.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(3, window.devicePixelRatio || 1)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const gutter = width < 480 ? 32 : 42
      const plotLeft = gutter
      const plotTop = 10
      const bandHeight = 18
      const plotBottom = Math.max(plotTop + 40, height - bandHeight)
      const plotWidth = Math.max(1, width - gutter)
      const plotHeight = plotBottom - plotTop

      const curveA = normalizedCurve(recordA)
      const curveB = normalizedCurve(recordB)
      const melodyNotes = recordB.melodyNotes.length > 0 ? recordB.melodyNotes : recordA.melodyNotes
      const duration = Math.max(
        1,
        recordA.melodyDuration,
        recordB.melodyDuration,
        ...curveA.map((point) => point.t),
        ...curveB.map((point) => point.t),
      )

      const values = [
        ...curveA.map((point) => point.midi),
        ...curveB.map((point) => point.midi),
        ...melodyNotes.map((note) => note.midi),
      ].sort((a, b) => a - b)
      let lo = Math.floor(quantileSorted(values, 0.02)) - 1
      let hi = Math.ceil(quantileSorted(values, 0.98)) + 1
      if (hi - lo < 12) {
        const center = (lo + hi) / 2
        lo = Math.floor(center - 6)
        hi = lo + 12
      }
      if (hi - lo > 32) {
        const center = (lo + hi) / 2
        lo = Math.floor(center - 16)
        hi = lo + 32
      }
      // 上下各留几个半音的边距，避免音头或下滑段贴着画布边缘被裁掉
      const pad = Math.max(2, Math.round((hi - lo) * 0.1))
      lo -= pad
      hi += pad
      const span = Math.max(6, hi - lo)
      const rowHeight = plotHeight / span
      const xFor = (time: number) => plotLeft + (time / duration) * plotWidth
      const yFor = (midi: number) => plotTop + ((hi - midi) / span) * plotHeight

      const background = ctx.createLinearGradient(0, 0, 0, height)
      background.addColorStop(0, '#12161f')
      background.addColorStop(1, '#0c1017')
      ctx.fillStyle = background
      ctx.fillRect(0, 0, width, height)

      ctx.fillStyle = '#0a0c12'
      ctx.fillRect(0, 0, plotLeft, plotBottom)
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.beginPath()
      ctx.moveTo(plotLeft + 0.5, 0)
      ctx.lineTo(plotLeft + 0.5, plotBottom)
      ctx.stroke()

      for (let midi = Math.ceil(lo); midi <= Math.floor(hi); midi++) {
        const y = yFor(midi)
        const pitchClass = ((midi % 12) + 12) % 12
        const isC = pitchClass === 0
        const isNatural = [2, 4, 5, 7, 9, 11].includes(pitchClass)
        ctx.strokeStyle = isC ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(plotLeft, Math.round(y) + 0.5)
        ctx.lineTo(width, Math.round(y) + 0.5)
        ctx.stroke()
        // 每个 C 都标注；空间够时补上其他自然音，读谱时不至于只看到孤零零一个音名
        if (isC || (isNatural && rowHeight >= 9)) {
          ctx.fillStyle = isC ? 'rgba(203,213,230,0.82)' : 'rgba(180,187,203,0.55)'
          ctx.font = `${isC ? 700 : 500} 10px system-ui, -apple-system, "PingFang SC", sans-serif`
          ctx.textAlign = 'right'
          ctx.textBaseline = 'middle'
          ctx.fillText(midiToNoteName(midi).label, plotLeft - 5, y)
        }
      }

      ctx.save()
      ctx.beginPath()
      ctx.rect(plotLeft, 0, plotWidth, plotBottom)
      ctx.clip()

      if (highlight) {
        ctx.fillStyle = 'rgba(143,125,255,0.1)'
        ctx.fillRect(
          xFor(highlight.start),
          plotTop,
          Math.max(2, xFor(highlight.end) - xFor(highlight.start)),
          plotHeight,
        )
      }

      for (const note of melodyNotes) {
        const y = yFor(note.midi)
        const x1 = xFor(note.start + 0.01)
        const x2 = xFor(note.end - 0.01)
        const barHeight = Math.max(4, Math.min(10, rowHeight * 0.5))
        const barWidth = Math.max(2, x2 - x1)
        // 很短的音符宽度可能不到 2px，圆角必须跟着收，否则两端圆弧会叠成“∞”
        const radius = Math.min(3, barWidth / 2, barHeight / 2)
        ctx.fillStyle = COLORS.bar
        ctx.strokeStyle = COLORS.barStroke
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(x1, y - barHeight / 2, barWidth, barHeight, radius)
        ctx.fill()
        ctx.stroke()
      }

      const visibleA = showA ? curveA : []
      const visibleB = showB ? curveB : []
      if (visibleA.length === 0 && visibleB.length === 0) {
        ctx.fillStyle = 'rgba(200,211,231,0.5)'
        ctx.font = '13px system-ui, -apple-system, "PingFang SC", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('这两次练习都没有可绘制的有效音高', plotLeft + plotWidth / 2, plotTop + plotHeight / 2)
      }

      drawCurve(ctx, visibleA, xFor, yFor, COLORS.a, 2, false)
      drawCurve(ctx, visibleB, xFor, yFor, COLORS.b, 2.4, false, [7, 5])
      ctx.restore()

      // 时间刻度：根据可用宽度挑选不重叠的间隔
      const stepChoices = [1, 2, 5, 10, 15, 30, 60, 120, 300]
      const idealStep = duration / Math.max(1, Math.floor(plotWidth / 70))
      const step = stepChoices.find((value) => value >= idealStep) ?? stepChoices[stepChoices.length - 1]
      ctx.fillStyle = 'rgba(8,10,15,0.94)'
      ctx.fillRect(0, plotBottom, width, bandHeight)
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'
      ctx.beginPath()
      ctx.moveTo(0, plotBottom + 0.5)
      ctx.lineTo(width, plotBottom + 0.5)
      ctx.stroke()
      ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let time = 0; time <= duration + 0.01; time += step) {
        const x = xFor(time)
        if (x < plotLeft + 12 || x > width - 12) continue
        const m = Math.floor(time / 60)
        const s = Math.floor(time % 60)
        ctx.fillStyle = 'rgba(203,213,230,0.68)'
        ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, x, plotBottom + bandHeight / 2 + 1)
      }
    }

    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [recordA, recordB, highlight, showA, showB])

  return (
    <div className="compare-roll" ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label="两次练习的音高曲线叠加对比" />
    </div>
  )
}

export function SongProgressView({
  records,
  songName,
  onBack,
  onOpenRecord,
}: SongProgressViewProps) {
  const attempts = useMemo(
    () => records.slice().sort((a, b) => a.createdAt - b.createdAt),
    [records],
  )
  const [aId, setAId] = useState(() => attempts[0]?.id ?? '')
  const [bId, setBId] = useState(() => attempts[attempts.length - 1]?.id ?? '')
  const [loaded, setLoaded] = useState<Record<string, PracticeRecord>>({})
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null)
  const [failed, setFailed] = useState<Record<string, true>>({})
  const [showA, setShowA] = useState(true)
  const [showB, setShowB] = useState(true)

  useEffect(() => {
    if (attempts.length === 0) return
    if (!attempts.some((attempt) => attempt.id === aId)) setAId(attempts[0].id)
    if (!attempts.some((attempt) => attempt.id === bId)) setBId(attempts[attempts.length - 1].id)
  }, [attempts, aId, bId])

  useEffect(() => {
    const ids = [aId, bId].filter((id, index, list) => id && list.indexOf(id) === index)
    const missing = ids.filter((id) => !loaded[id] && !failed[id])
    if (missing.length === 0) {
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setLoadError(false)
    Promise.all(missing.map((id) => loadRecord(id)))
      .then((list) => {
        if (!active) return
        const next: Record<string, PracticeRecord> = {}
        const failedIds: Record<string, true> = {}
        list.forEach((record, index) => {
          if (record) next[record.id] = record
          else failedIds[missing[index]] = true
        })
        if (Object.keys(next).length > 0) {
          setLoaded((current) => ({ ...current, ...next }))
        }
        if (Object.keys(failedIds).length > 0) {
          setFailed((current) => ({ ...current, ...failedIds }))
          setLoadError(true)
        }
      })
      .catch((error: unknown) => {
        console.warn('[voice-pro] 读取歌曲对比记录失败', error)
        if (active) {
          setFailed((current) => {
            const next = { ...current }
            for (const id of missing) next[id] = true
            return next
          })
          setLoadError(true)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [aId, bId, loaded, failed])

  const recordA = loaded[aId] ?? null
  const recordB = loaded[bId] ?? null
  const analysisA = useMemo(() => (recordA ? analyzeRecord(recordA) : null), [recordA])
  const analysisB = useMemo(() => (recordB ? analyzeRecord(recordB) : null), [recordB])

  const scoredAttempts = attempts.filter((attempt) => attempt.score != null)
  const bestScore = scoredAttempts.reduce<number | null>(
    (best, attempt) => (attempt.score == null ? best : Math.max(best ?? 0, attempt.score)),
    null,
  )
  const latest = attempts[attempts.length - 1] ?? null
  const firstScored = scoredAttempts[0] ?? null
  const latestScored = scoredAttempts[scoredAttempts.length - 1] ?? null
  const overallDelta =
    firstScored?.score != null && latestScored?.score != null && scoredAttempts.length >= 2
      ? latestScored.score - firstScored.score
      : null

  const loadFailed = Boolean(failed[aId] || failed[bId])
  const aMeta = attempts.find((attempt) => attempt.id === aId) ?? null
  const bMeta = attempts.find((attempt) => attempt.id === bId) ?? null
  const canCompare = attempts.length >= 2 && aId !== bId && recordA != null && recordB != null

  const phraseRows = useMemo(() => {
    if (!analysisA || !analysisB) return []
    const mapA = new Map(analysisA.report.phrases.map((phrase) => [phrase.index, phrase]))
    const mapB = new Map(analysisB.report.phrases.map((phrase) => [phrase.index, phrase]))
    const indexes = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((a, b) => a - b)
    return indexes
      .map((index) => {
        const phraseA = mapA.get(index) ?? null
        const phraseB = mapB.get(index) ?? null
        const rateA = phraseA ? percent(phraseA.hitRate) : null
        const rateB = phraseB ? percent(phraseB.hitRate) : null
        const samplesA = phraseA?.samples ?? 0
        const samplesB = phraseB?.samples ?? 0
        const usable = samplesA >= 5 && samplesB >= 5 && rateA != null && rateB != null
        const delta = usable ? (rateB ?? 0) - (rateA ?? 0) : null
        const tone =
          delta == null
            ? 'none'
            : delta >= 5
              ? 'good'
              : delta <= -5
                ? 'warn'
                : 'flat'
        const start = phraseA?.start ?? phraseB?.start ?? 0
        const end = phraseA?.end ?? phraseB?.end ?? start
        return {
          index,
          start,
          end,
          rateA,
          rateB,
          samplesA,
          samplesB,
          usable,
          delta,
          tone,
          noteLabels: (phraseB?.noteLabels ?? phraseA?.noteLabels ?? []).slice(0, 4),
        }
      })
      .filter((row) => row.samplesA > 0 || row.samplesB > 0)
  }, [analysisA, analysisB])

  const highlightPhrase = highlight
    ? phraseRows.find((row) => row.start === highlight.start && row.end === highlight.end) ?? null
    : null
  const improved = phraseRows.filter((row) => row.delta != null && row.delta >= 5).length
  const regressed = phraseRows.filter((row) => row.delta != null && row.delta <= -5).length
  const comparable = phraseRows.filter((row) => row.delta != null).length

  if (attempts.length === 0) {
    return (
      <div className="screen song-progress-screen">
        <TopBar title="歌曲进步" subtitle={songName} onBack={onBack} />
        <main className="page">
          <section className="card empty-card">
            <h1>还没有这首歌的练习记录</h1>
            <p>唱完一次之后，这里会记录得分折线，并支持两次练习的音高对比。</p>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="screen song-progress-screen">
      <TopBar title="歌曲进步" subtitle={songName} onBack={onBack} />

      <main className="page song-progress-page">
        <section className="card song-progress-hero">
          <div>
            <p className="eyebrow">同一首歌 · {attempts.length} 次练习</p>
            <h1>{songName}</h1>
            <p>
              {dateShort(attempts[0].createdAt)} – {dateShort(attempts[attempts.length - 1].createdAt)}
              {overallDelta != null && (
                <span className={overallDelta >= 0 ? 'good' : 'warn'}>
                  {' '}· 最近有分的一次较首次 {overallDelta >= 0 ? '+' : '−'}{Math.abs(overallDelta)} 分
                </span>
              )}
            </p>
          </div>
          <div className="song-progress-stats">
            <div>
              <span>最高分</span>
              <strong>{bestScore ?? '—'}</strong>
            </div>
            <div>
              <span>最近一次</span>
              <strong>{latest?.score ?? '—'}</strong>
            </div>
          </div>
        </section>

        <section className="card song-score-card">
          <div className="section-head">
            <div>
              <h2>历次得分</h2>
              <p>按练习时间排列；缺分的练习不画点，但仍保留在对比列表里</p>
            </div>
            <span className="count-badge">{scoredAttempts.length}/{attempts.length} 次有分</span>
          </div>
          {scoredAttempts.length > 0 ? (
            <>
              <TrendChart
                points={scoredAttempts.map((attempt) => ({
                  x:
                    attempts.length > 1
                      ? attempts.findIndex((item) => item.id === attempt.id)
                      : 1,
                  value: attempt.score ?? 0,
                  label: `第 ${attempts.findIndex((item) => item.id === attempt.id) + 1} 次 · ${dateTimeShort(attempt.createdAt)} · ${attempt.score} 分`,
                }))}
                xMax={attempts.length > 1 ? attempts.length - 1 : 2}
                xLabels={[dateShort(attempts[0].createdAt), dateShort(attempts[attempts.length - 1].createdAt)]}
                ariaLabel={`${songName} 历次得分折线`}
              />
              {attempts.length === 1 && (
                <p className="progress-foot">这是这首歌的第一次记录。再练一次，就能看到得分折线并做叠加对比。</p>
              )}
            </>
          ) : (
            <div className="mini-empty">
              <strong>还没有有效得分</strong>
              <span>这几次练习都没有检测到能和参考旋律对齐的音高。戴耳机、跟着伴奏完整唱一遍再试试。</span>
            </div>
          )}
        </section>

        <section className="card song-compare-card">
          <div className="section-head">
            <div>
              <h2>叠加对比</h2>
              <p>选两次练习，把音高曲线叠在一起；默认是第一次与最近一次</p>
            </div>
            {canCompare && (
              <div className="compare-legend" role="group" aria-label="切换显示的对比曲线">
                <button
                  type="button"
                  className={showA ? 'active' : 'off'}
                  aria-pressed={showA}
                  onClick={() => setShowA((current) => (current ? !showB : true))}
                >
                  <i className="legend-a" />
                  A 实线
                </button>
                <button
                  type="button"
                  className={showB ? 'active' : 'off'}
                  aria-pressed={showB}
                  onClick={() => setShowB((current) => (current ? !showA : true))}
                >
                  <i className="legend-b" />
                  B 虚线
                </button>
              </div>
            )}
          </div>

          {attempts.length >= 2 && (
          <div className="compare-pickers">
            <label>
              <span>练习 A</span>
              <select
                value={aId}
                onChange={(event) => {
                  setAId(event.target.value)
                  setHighlight(null)
                  setLoadError(false)
                }}
              >
                {attempts.map((attempt, index) => (
                  <option key={attempt.id} value={attempt.id} disabled={attempt.id === bId}>
                    第 {index + 1} 次 · {dateShort(attempt.createdAt)} · {attempt.score ?? '—'} 分
                  </option>
                ))}
              </select>
            </label>
            <span className="compare-vs">vs</span>
            <label>
              <span>练习 B</span>
              <select
                value={bId}
                onChange={(event) => {
                  setBId(event.target.value)
                  setHighlight(null)
                  setLoadError(false)
                }}
              >
                {attempts.map((attempt, index) => (
                  <option key={attempt.id} value={attempt.id} disabled={attempt.id === aId}>
                    第 {index + 1} 次 · {dateShort(attempt.createdAt)} · {attempt.score ?? '—'} 分
                  </option>
                ))}
              </select>
            </label>
          </div>
          )}

          {attempts.length < 2 ? (
            <div className="mini-empty">
              <strong>再唱一遍，就能对比</strong>
              <span>同一首歌有两次以上练习时，这里会自动画出叠加曲线，并逐句比较命中率。</span>
            </div>
          ) : loading && (!recordA || !recordB) ? (
            <div className="compare-loading"><i className="spinner" /><span>正在读取两次练习的音高轨迹…</span></div>
          ) : loadError || loadFailed || !recordA || !recordB ? (
            <div className="mini-empty">
              <span>对比记录读取失败。返回记录页重新打开，或确认这两次记录仍然存在。</span>
              <button
                type="button"
                className="btn small secondary"
                onClick={() => {
                  setLoadError(false)
                  setFailed((current) => {
                    const next = { ...current }
                    delete next[aId]
                    delete next[bId]
                    return next
                  })
                }}
              >
                重试读取
              </button>
            </div>
          ) : aId === bId ? (
            <div className="mini-empty"><span>两次选择是同一次练习，请换一个对比对象。</span></div>
          ) : (
            <>
              <div className="compare-cards">
                <div className="compare-card a">
                  <span className="compare-tag">A</span>
                  <div>
                    <strong>第 {attempts.findIndex((attempt) => attempt.id === aId) + 1} 次</strong>
                    <span>{aMeta ? dateTimeShort(aMeta.createdAt) : '—'}</span>
                  </div>
                  <div className="compare-card-stats">
                    <span>{aMeta?.score ?? '—'} 分</span>
                    <span>命中 {analysisA ? (percent(analysisA.report.hitRate) ?? '—') : '—'}%</span>
                    <span>{recordA.transpose ? `移调 ${recordA.transpose > 0 ? '+' : ''}${recordA.transpose}` : '原调'}</span>
                  </div>
                </div>
                <div className="compare-card b">
                  <span className="compare-tag">B</span>
                  <div>
                    <strong>第 {attempts.findIndex((attempt) => attempt.id === bId) + 1} 次</strong>
                    <span>{bMeta ? dateTimeShort(bMeta.createdAt) : '—'}</span>
                  </div>
                  <div className="compare-card-stats">
                    <span>{bMeta?.score ?? '—'} 分</span>
                    <span>命中 {analysisB ? (percent(analysisB.report.hitRate) ?? '—') : '—'}%</span>
                    <span>{recordB.transpose ? `移调 ${recordB.transpose > 0 ? '+' : ''}${recordB.transpose}` : '原调'}</span>
                  </div>
                </div>
              </div>

              <CompareRoll
                recordA={recordA}
                recordB={recordB}
                highlight={highlight}
                showA={showA}
                showB={showB}
              />

              <div className="compare-foot">
                <span className="tiny-note">
                  {highlightPhrase
                    ? `正在看第 ${highlightPhrase.index + 1} 句 · 点同一句可取消高亮`
                    : 'A 为蓝色实线、B 为橙色虚线；两条曲线都已还原到原调并做八度对齐。点图例可只看一条，点下方句子可高亮对应时间。'}
                </span>
                {aMeta && (
                  <button type="button" className="text-btn" onClick={() => onOpenRecord(aMeta.id)}>
                    回看 A <ChevronRightIcon />
                  </button>
                )}
                {bMeta && (
                  <button type="button" className="text-btn" onClick={() => onOpenRecord(bMeta.id)}>
                    回看 B <ChevronRightIcon />
                  </button>
                )}
              </div>
            </>
          )}
        </section>

        <section className="card song-phrase-compare">
          <div className="section-head">
            <div>
              <h2>逐句对比</h2>
              <p>命中率 B 相对 A 的变化；只比较两次都有足够音高数据的句子</p>
            </div>
            {attempts.length >= 2 && comparable > 0 && (
              <div className="phrase-compare-summary">
                <span className="good">进步 {improved} 句</span>
                <span className="warn">退步 {regressed} 句</span>
                <span>持平 {comparable - improved - regressed} 句</span>
              </div>
            )}
          </div>

          {attempts.length < 2 ? (
            <div className="mini-empty">
              <strong>再唱一遍，就能逐句看到变化</strong>
              <span>同一首歌有两次以上练习时，这里会列出每句命中率的提升或退步。</span>
            </div>
          ) : !analysisA || !analysisB ? (
            <div className="mini-empty"><span>两次练习读取完成后，才能逐句比较。</span></div>
          ) : phraseRows.length === 0 ? (
            <div className="mini-empty"><span>这两次练习没有可对齐的乐句。</span></div>
          ) : (
            <ul className="phrase-compare-list">
              {phraseRows.map((row) => (
                <li key={row.index}>
                  <button
                    type="button"
                    className={`phrase-compare-row tone-${row.tone} ${highlight?.start === row.start ? 'active' : ''}`}
                    onClick={() =>
                      setHighlight((current) =>
                        current?.start === row.start && current?.end === row.end
                          ? null
                          : { start: row.start, end: row.end },
                      )
                    }
                  >
                    <div className="phrase-compare-title">
                      <strong>第 {row.index + 1} 句</strong>
                      <span>{formatTime(row.start)} – {formatTime(row.end)}</span>
                      <span>{row.noteLabels.join(' · ') || '—'}</span>
                    </div>
                    <div className="phrase-compare-bars">
                      <div className="phrase-bar-line a">
                        <span>A</span>
                        <i><b style={{ width: `${row.rateA ?? 0}%` }} /></i>
                        <em>{row.rateA == null ? '无数据' : `${row.rateA}%`}</em>
                      </div>
                      <div className="phrase-bar-line b">
                        <span>B</span>
                        <i><b style={{ width: `${row.rateB ?? 0}%` }} /></i>
                        <em>{row.rateB == null ? '无数据' : `${row.rateB}%`}</em>
                      </div>
                    </div>
                    <span className={`phrase-delta ${row.tone}`}>
                      {!row.usable || row.delta == null
                        ? '数据不足'
                        : row.delta >= 5
                          ? `↑ ${row.delta}`
                          : row.delta <= -5
                            ? `↓ ${Math.abs(row.delta)}`
                            : '持平'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="progress-foot">
            命中率按各次自己的容忍度、移调与八度对齐设置计算；变化至少 5 个百分点才标为进步/退步，避免正常波动造成误判。
          </p>
        </section>

        <button type="button" className="btn ghost block" onClick={onBack}>
          返回记录
        </button>
      </main>
    </div>
  )
}
