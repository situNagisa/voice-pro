import { useEffect, useRef, useState } from 'react'
import type { RawUserPoint } from '../audio/analysis'
import { severityForCents } from '../audio/analysis'
import { mediaErrorMessage, PitchCapture } from '../audio/capture'
import type { InputSource } from '../audio/capture'
import {
  centsFromNearestNote,
  clamp,
  formatCents,
  midiToNoteName,
} from '../audio/pitch'
import { Notice, SourcePicker, TopBar } from '../ui/controls'
import { HeadphonesIcon, MicIcon } from '../ui/icons'
import { PitchRoll } from '../ui/PitchRoll'

interface FreeTuneProps {
  onHome: () => void
}

interface FreeReading {
  midi: number
  f0: number
}

const TUNER_TOLERANCE = 15

export function FreeTune({ onHome }: FreeTuneProps) {
  const [phase, setPhase] = useState<'ready' | 'starting' | 'active'>('ready')
  const [source, setSource] = useState<InputSource>('mic')
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<FreeReading | null>(null)

  const ctxRef = useRef<AudioContext | null>(null)
  const captureRef = useRef<PitchCapture | null>(null)
  const pointsRef = useRef<RawUserPoint[]>([])
  const originRef = useRef(0)
  const mountedRef = useRef(true)
  const lastUiRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      captureRef.current?.stop()
      captureRef.current = null
      const ctx = ctxRef.current
      ctxRef.current = null
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    }
  }, [])

  async function start(): Promise<void> {
    if (phase !== 'ready') return
    setPhase('starting')
    setError(null)
    setCurrent(null)
    pointsRef.current = []
    lastUiRef.current = 0

    const ctx = new AudioContext({ latencyHint: 'interactive' })
    ctxRef.current = ctx
    let capture: PitchCapture | null = null
    try {
      await ctx.resume()
      originRef.current = ctx.currentTime
      capture = new PitchCapture(ctx)
      await capture.start(source, (frame) => {
        if (!mountedRef.current) return
        if (frame.f0 == null || frame.midi == null) {
          if (performance.now() - lastUiRef.current > 260) {
            lastUiRef.current = performance.now()
            setCurrent(null)
          }
          return
        }
        const point: RawUserPoint = {
          t: frame.t - originRef.current,
          f0: frame.f0,
          midi: frame.midi,
          clarity: frame.clarity,
        }
        pointsRef.current.push(point)
        if (performance.now() - lastUiRef.current >= 40) {
          lastUiRef.current = performance.now()
          setCurrent({ midi: frame.midi, f0: frame.f0 })
        }
      }, () => {
        if (!mountedRef.current) return
        captureRef.current?.stop()
        captureRef.current = null
        const activeCtx = ctxRef.current
        ctxRef.current = null
        if (activeCtx && activeCtx.state !== 'closed') void activeCtx.close().catch(() => undefined)
        setPhase('ready')
        setCurrent(null)
        setError('音频输入已结束。可以重新开始，或换一个输入来源。')
      })
      if (!mountedRef.current) {
        capture.stop()
        return
      }
      captureRef.current = capture
      setPhase('active')
    } catch (err) {
      capture?.stop()
      const activeCtx = ctxRef.current
      ctxRef.current = null
      if (activeCtx && activeCtx.state !== 'closed') void activeCtx.close().catch(() => undefined)
      setPhase('ready')
      setError(mediaErrorMessage(err, source))
    }
  }

  function stop(): void {
    captureRef.current?.stop()
    captureRef.current = null
    const ctx = ctxRef.current
    ctxRef.current = null
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    setPhase('ready')
    setCurrent(null)
    pointsRef.current = []
    setError(null)
  }

  const note = current ? midiToNoteName(current.midi) : null
  const cents = current ? centsFromNearestNote(current.midi) : null
  const severity =
    cents == null ? 'neutral' : severityForCents(cents, TUNER_TOLERANCE)
  const needlePosition = cents == null ? 50 : 50 + clamp(cents, -50, 50)
  const status =
    cents == null
      ? '等待声音'
      : Math.abs(cents) <= TUNER_TOLERANCE
        ? '准'
        : cents > 0
          ? '偏高 ↑'
          : '偏低 ↓'

  return (
    <div className="screen free-tune">
      <TopBar title="自由练习" subtitle="音高与音名 · 也可当调音器" onBack={onHome} />

      {phase !== 'active' ? (
        <main className="free-ready">
          <section className="card free-hero">
            <div className="free-hero-icon">
              <MicIcon />
            </div>
            <div className="eyebrow">无歌曲模式</div>
            <h2>唱一个音，看看它落在哪里</h2>
            <p className="lead">
              实时显示你唱出的音名、频率和相对十二平均律的音分偏差。不评分，只观察。
              也可以用来给吉他、钢琴等乐器调音。
            </p>

            <SourcePicker value={source} onChange={setSource} disabled={phase !== 'ready'} />

            <div className="setup-tips">
              <HeadphonesIcon />
              <span>
                用麦克风时请避免把外放伴奏收进来；跟着别的软件唱歌时，可以改用桌面端的
                “标签页 / 系统声音”来源，但那分析的是播放声音，不是你的嗓音。
              </span>
            </div>

            {error && <Notice tone="error">{error}</Notice>}

            <button
              type="button"
              className="btn primary xl"
              onClick={() => void start()}
              disabled={phase === 'starting'}
            >
              {phase === 'starting' ? '正在打开音频输入…' : '开始收音'}
            </button>
          </section>

          <section className="card free-help">
            <h3>怎么用</h3>
            <ol>
              <li>点“开始收音”，允许麦克风权限。</li>
              <li>唱一个稳定的长音，让音名和指针稳定下来。</li>
              <li>指针在中间变绿表示接近准音；偏左偏低，偏右偏高。</li>
              <li>绿色画布上是最近几秒的音高轨迹。</li>
            </ol>
          </section>
        </main>
      ) : (
        <main className="free-active">
          <section className={`tuner-card card severity-${severity}`}>
            <div className="tuner-top">
              <div>
                <div className="tuner-note">{note?.label ?? '—'}</div>
                <div className={`tuner-cents ${severity}`}>
                  {cents == null ? '—' : `${formatCents(cents)} 音分`}
                </div>
              </div>
              <div className="tuner-meta">
                <div className={`status-pill ${severity}`}>{status}</div>
                <div className="target-line">
                  目标 <strong>{note?.label ?? '—'}</strong>
                </div>
                <div className="freq-hint">{current ? `${current.f0.toFixed(1)} Hz` : '—'}</div>
              </div>
            </div>

            <div className="tuner-gauge">
              <div className="tuner-zones" />
              <div
                className={`tuner-needle ${severity}`}
                style={{ left: `${needlePosition}%` }}
              />
              <div className="tuner-center-mark" />
            </div>
            <div className="tuner-ticks">
              <span>−50</span>
              <span>0</span>
              <span>+50</span>
            </div>
          </section>

          <PitchRoll
            melody={null}
            pointsRef={pointsRef}
            getNow={() => {
              const ctx = ctxRef.current
              return ctx ? ctx.currentTime - originRef.current : 0
            }}
            duration={0}
            transpose={0}
            octaveAlign={false}
            tolerance={TUNER_TOLERANCE}
            loop={null}
            mode="free"
            active={phase === 'active'}
          />

          <div className="roll-legend">
            <span><i className="dot good" />很准 (±15)</span>
            <span><i className="dot warn" />略偏</span>
            <span><i className="dot bad" />偏差较大</span>
            <span className="legend-spacer" />
            <span>纵轴：音高 · 横轴：最近几秒</span>
          </div>

          <div className="free-controls card">
            <div className="transport-info">
              <div className="clock">实时监听</div>
              <div className="transport-sub">
                {source === 'mic' ? '麦克风输入' : '共享声音输入'}
              </div>
            </div>
            <button type="button" className="btn" onClick={stop}>
              停止收音
            </button>
          </div>
        </main>
      )}
    </div>
  )
}
