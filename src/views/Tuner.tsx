import { useEffect, useRef, useState } from 'react'
import {
  centsFromNearestNote,
  clamp,
  formatCents,
  formatTime,
  midiToNoteName,
} from '../audio/pitch'
import { PitchCapture } from '../audio/capture'
import { COACH_EXERCISES } from '../audio/coach'
import type { CoachExerciseId } from '../audio/coach'
import { mediaErrorMessage } from '../audio/capture'
import { ClipPlayer } from '../audio/clipPlayer'
import type { RawUserPoint } from '../audio/analysis'
import type { AudioSegment } from '../audio/recorder'
import { VoiceRecorder } from '../audio/recorder'
import { nearestPoint, voiceOffsetAt } from '../audio/review'
import {
  ChevronRightIcon,
  SettingsIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
} from '../ui/icons'
import { PitchRoll } from '../ui/PitchRoll'

interface TunerViewProps {
  onOpenSettings: () => void
  onStartCoach: (exerciseId?: CoachExerciseId) => void
}

type Phase = 'starting' | 'listening' | 'paused' | 'error'

interface TunerReading {
  midi: number
  f0: number
  t: number
}

const TOLERANCE = 15

function noteCents(midi: number): number {
  return centsFromNearestNote(midi)
}

export function TunerView({ onOpenSettings, onStartCoach }: TunerViewProps) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<TunerReading | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [pausedAt, setPausedAt] = useState(0)
  const [cursor, setCursor] = useState<number | null>(null)
  const [selected, setSelected] = useState<RawUserPoint | null>(null)
  const [voiceReady, setVoiceReady] = useState(false)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [replayPlaying, setReplayPlaying] = useState(false)

  const ctxRef = useRef<AudioContext | null>(null)
  const captureRef = useRef<PitchCapture | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const replayRef = useRef<ClipPlayer | null>(null)
  const voiceBufferRef = useRef<AudioBuffer | null>(null)
  const originRef = useRef(0)
  const pointsRef = useRef<RawUserPoint[]>([])
  const segmentsRef = useRef<AudioSegment[]>([])
  const acceptingRef = useRef(false)
  const pausedAtRef = useRef(0)
  const centerRef = useRef(0)
  const cursorRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const lastUiRef = useRef(0)
  const phaseRef = useRef<Phase>('starting')
  phaseRef.current = phase

  useEffect(() => {
    mountedRef.current = true
    const timer = window.setTimeout(() => {
      void start()
    }, 80)
    return () => {
      mountedRef.current = false
      window.clearTimeout(timer)
      captureRef.current?.stop()
      captureRef.current = null
      void recorderRef.current?.stop()
      recorderRef.current = null
      replayRef.current?.dispose()
      replayRef.current = null
      const ctx = ctxRef.current
      ctxRef.current = null
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    }
    // 进入音准仪即自动开始
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'listening') return
    const timer = window.setInterval(() => {
      setElapsed(getElapsed())
    }, 100)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => {
    if (!replayPlaying) return
    const timer = window.setInterval(() => {
      const clip = replayRef.current
      if (!clip?.playing) return
      const position = clip.position
      cursorRef.current = position
      setCursor(position)
      setSelected(nearestPoint(pointsRef.current, position))
    }, 80)
    return () => window.clearInterval(timer)
  }, [replayPlaying])

  function getElapsed(): number {
    const ctx = ctxRef.current
    return ctx ? Math.max(0, ctx.currentTime - originRef.current) : 0
  }

  async function start(): Promise<void> {
    if (!mountedRef.current) return
    setPhase('starting')
    setError(null)
    setCurrent(null)
    setCursor(null)
    setSelected(null)
    setVoiceReady(false)
    pointsRef.current = []
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    ctxRef.current = ctx
    let capture: PitchCapture | null = null
    try {
      await ctx.resume()
      originRef.current = ctx.currentTime
      segmentsRef.current = [{ songStart: 0, voiceStart: 0, duration: 0 }]
      capture = new PitchCapture(ctx)
      await capture.start(
        'mic',
        (frame) => {
          if (!mountedRef.current || !acceptingRef.current) return
          if (frame.f0 == null || frame.midi == null) {
            if (performance.now() - lastUiRef.current > 280) {
              lastUiRef.current = performance.now()
              setCurrent(null)
            }
            return
          }
          const t = frame.t - originRef.current
          pointsRef.current.push({ t, f0: frame.f0, midi: frame.midi, clarity: frame.clarity })
          if (performance.now() - lastUiRef.current >= 40) {
            lastUiRef.current = performance.now()
            setCurrent({ midi: frame.midi, f0: frame.f0, t })
          }
        },
        () => {
          if (!mountedRef.current) return
          acceptingRef.current = false
          captureRef.current?.stop()
          captureRef.current = null
          const position = getElapsed()
          pausedAtRef.current = position
          setPausedAt(position)
          setPhase('paused')
          setError('麦克风输入已结束。可以继续回看已录内容，或重新开始。')
        },
      )
      if (!mountedRef.current) {
        capture.stop()
        return
      }
      captureRef.current = capture
      const stream = capture.mediaStream
      if (stream) {
        const recorder = new VoiceRecorder(stream, ctx)
        recorder.start()
        recorderRef.current = recorder
      }
      acceptingRef.current = true
      setPhase('listening')
      setElapsed(0)
    } catch (err) {
      capture?.stop()
      const activeCtx = ctxRef.current
      ctxRef.current = null
      if (activeCtx && activeCtx.state !== 'closed') void activeCtx.close().catch(() => undefined)
      setPhase('error')
      setError(mediaErrorMessage(err, 'mic'))
    }
  }

  function stopAll(): void {
    acceptingRef.current = false
    captureRef.current?.stop()
    captureRef.current = null
    void recorderRef.current?.stop()
    recorderRef.current = null
    replayRef.current?.dispose()
    replayRef.current = null
    const ctx = ctxRef.current
    ctxRef.current = null
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    setCurrent(null)
    setCursor(null)
    setSelected(null)
    setReplayPlaying(false)
    setSnapshotLoading(false)
    // 停止后给用户一个明确的重开入口
    setError('已停止收音。点“重新开始”继续。')
    setPhase('error')
  }

  function closeOpenSegment(): void {
    const recorder = recorderRef.current
    const last = segmentsRef.current[segmentsRef.current.length - 1]
    if (recorder && last && last.duration === 0) {
      last.duration = Math.max(0, recorder.elapsed - last.voiceStart)
    }
  }

  async function pause(): Promise<void> {
    if (phase !== 'listening') return
    acceptingRef.current = false
    closeOpenSegment()
    recorderRef.current?.pause()
    const position = getElapsed()
    pausedAtRef.current = position
    centerRef.current = Math.max(0, position - 1)
    cursorRef.current = null
    setPausedAt(position)
    setCursor(null)
    setSelected(null)
    setPhase('paused')
    setSnapshotLoading(true)
    try {
      const wav = recorderRef.current?.snapshotWav()
      const ctx = ctxRef.current
      if (wav && ctx) {
        const buffer = await ctx.decodeAudioData(await wav.arrayBuffer())
        if (!mountedRef.current) return
        voiceBufferRef.current = buffer
        setVoiceReady(true)
      } else {
        setVoiceReady(false)
      }
    } catch (err) {
      console.warn('[voice-pro] 音准仪录音回放准备失败', err)
      setVoiceReady(false)
    } finally {
      setSnapshotLoading(false)
    }
  }

  function resume(): void {
    const recorder = recorderRef.current
    if (!recorder) return
    replayRef.current?.stop()
    setReplayPlaying(false)
    cursorRef.current = null
    setCursor(null)
    setSelected(null)
    // 恢复后时间轴从当前时刻继续，回放映射由分段表处理
    const resumePosition = getElapsed()
    recorder.resume()
    segmentsRef.current.push({
      songStart: resumePosition,
      voiceStart: recorder.elapsed,
      duration: 0,
    })
    pausedAtRef.current = 0
    centerRef.current = 0
    acceptingRef.current = true
    setPhase('listening')
  }

  function pickTime(time: number): void {
    if (phase !== 'paused') return
    if (replayPlaying) {
      replayRef.current?.stop()
      setReplayPlaying(false)
    }
    const next = clamp(time, 0, Math.max(0.1, pausedAtRef.current))
    cursorRef.current = next
    setCursor(next)
    setSelected(nearestPoint(pointsRef.current, next))
  }

  function panTime(delta: number): void {
    if (phase !== 'paused') return
    if (replayPlaying) {
      replayRef.current?.stop()
      setReplayPlaying(false)
    }
    centerRef.current = clamp(centerRef.current + delta, 0, Math.max(0.5, pausedAtRef.current))
  }

  async function playVoice(): Promise<void> {
    if (replayPlaying) {
      replayRef.current?.stop()
      setReplayPlaying(false)
      return
    }
    const ctx = ctxRef.current
    if (!ctx) return
    let from = cursorRef.current ?? pausedAtRef.current
    // 暂停点上通常已经没有录音，回退一点让人听到刚唱的内容
    if (cursorRef.current == null && voiceBufferRef.current) {
      const offset = voiceOffsetAt(segmentsRef.current, from)
      if (offset != null && voiceBufferRef.current.duration - offset < 0.6) {
        from = Math.max(0, from - 3)
      }
      cursorRef.current = from
      setCursor(from)
      setSelected(nearestPoint(pointsRef.current, from))
    }
    if (!replayRef.current) replayRef.current = new ClipPlayer(ctx)
    const clip = replayRef.current
    clip.onEnded = () => {
      if (mountedRef.current) setReplayPlaying(false)
    }
    await clip.play({
      original: null,
      voice: voiceBufferRef.current,
      songTime: from,
      voiceOffset: voiceOffsetAt(segmentsRef.current, from),
      mode: 'voice',
      volume: 1,
    })
    setReplayPlaying(clip.playing)
  }

  // 暂停并选中某一点时，大字直接显示那一刻；麦克风偶尔断帧时保留最近的音高。
  const latestPoint =
    pointsRef.current.length > 0 ? pointsRef.current[pointsRef.current.length - 1] : null
  const recentPoint =
    latestPoint && Math.abs((phase === 'paused' ? pausedAt : elapsed) - latestPoint.t) < 2.2
      ? latestPoint
      : null
  const display = phase === 'paused'
    ? selected ?? recentPoint ?? current
    : current ?? recentPoint
  const note = display ? midiToNoteName(display.midi) : null
  const cents = display ? noteCents(display.midi) : null
  const liveSeverity =
    cents == null
      ? 'neutral'
      : Math.abs(cents) <= TOLERANCE
        ? 'good'
        : cents > 0
          ? 'sharp'
          : 'flat'
  const liveDirection = cents == null || Math.abs(cents) <= TOLERANCE ? 0 : cents > 0 ? 1 : -1
  const needle = cents == null ? 50 : 50 + clamp(cents, -50, 50)

  const selectedIndex = selected ? selected.midi : null
  const selectedCents = selectedIndex != null ? noteCents(selectedIndex) : null
  const selectedNote = selectedIndex != null ? midiToNoteName(selectedIndex) : null
  const selectedSeverity =
    selectedCents == null
      ? 'neutral'
      : Math.abs(selectedCents) <= TOLERANCE
        ? 'good'
        : selectedCents > 0
          ? 'sharp'
          : 'flat'
  const selectedDirection =
    selectedCents == null || Math.abs(selectedCents) <= TOLERANCE
      ? 0
      : selectedCents > 0
        ? 1
        : -1

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (document.querySelector('.settings-sheet')) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        if (target?.closest('button')) return
        if (phase === 'listening') {
          event.preventDefault()
          void pause()
        } else if (phase === 'paused') {
          event.preventDefault()
          resume()
        }
      } else if (phase === 'paused' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        const delta = (event.shiftKey ? 5 : 1) * (event.key === 'ArrowLeft' ? -1 : 1)
        const base = cursorRef.current ?? pausedAtRef.current
        const next = clamp(base + delta, 0, Math.max(0.1, pausedAtRef.current))
        centerRef.current = clamp(next, 0, Math.max(0.5, pausedAtRef.current))
        pickTime(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  return (
    <div className="screen tuner-screen">
      <header className="tab-header">
        <div>
          <p className="eyebrow">实时</p>
          <h1 className="tab-title">音准仪</h1>
        </div>
        <div className="tab-header-tools">
          <span className="key-hints desktop-only">空格 暂停/继续 · 悬停查看音名</span>
          <button
            type="button"
            className="btn small secondary coach-header-btn"
            onClick={() => onStartCoach()}
          >
            练声小课
          </button>
          <button type="button" className="icon-btn" aria-label="打开设置" onClick={onOpenSettings}>
            <SettingsIcon />
          </button>
        </div>
      </header>

      <main className="page tuner-page">
        {phase === 'error' && !current ? (
          <section className="card empty-card">
            <div className="empty-icon"><MicIcon /></div>
            <h1>需要麦克风</h1>
            <p>{error}</p>
            <button type="button" className="btn primary" onClick={() => void start()}>
              <RefreshIcon />
              重新开始
            </button>
          </section>
        ) : (
          <>
            <div className="tuner-stage">
              <section className="roll-card card">
                <div className="roll-card-head">
                  <strong>{phase === 'paused' ? '历史音高 · 可拖动' : '最近音高'}</strong>
                  <span className="tiny-note">
                    {phase === 'paused'
                      ? '点按曲线查看那一刻；白色游标为选中'
                      : `已录 ${formatTime(elapsed)}`}
                  </span>
                </div>
                <PitchRoll
                  melody={null}
                  pointsRef={pointsRef}
                  duration={phase === 'paused' ? pausedAt : 0}
                  transpose={0}
                  octaveAlign={false}
                  tolerance={TOLERANCE}
                  mode="free"
                  active={phase === 'listening'}
                  interactive={phase === 'paused'}
                  getPlayhead={() => (phase === 'paused' ? pausedAtRef.current : getElapsed())}
                  getCenter={() => (phase === 'paused' ? centerRef.current : Math.max(0, getElapsed() - 1))}
                  getCursor={() => cursorRef.current}
                  onPan={panTime}
                  onPick={pickTime}
                  ariaLabel="音准仪音高曲线"
                  playheadLabel={phase === 'paused' ? '暂停' : '现在'}
                />
                <div className="roll-legend">
                  <span><i className="dot good" />准 (±15)</span>
                  <span><i className="dot sharp" />偏高 ↑</span>
                  <span><i className="dot flat" />偏低 ↓</span>
                  <span className="legend-spacer" />
                  <span>{phase === 'paused' ? '拖动查看历史' : '横轴：最近几秒'}</span>
                </div>
              </section>
              {phase !== 'paused' && (
                <div className="tuner-controls">
                  <button
                    type="button"
                    className="round-btn pause big"
                    aria-label="暂停并回看"
                    onClick={() => void pause()}
                    disabled={phase !== 'listening'}
                  >
                    <PauseIcon />
                  </button>
                  <div className="transport-copy">
                    <strong>{phase === 'starting' ? '正在准备…' : '正在聆听'}</strong>
                    <span>暂停后可以拖动时间轴回看</span>
                  </div>
                  <button type="button" className="text-btn" onClick={stopAll}>
                    停止
                  </button>
                </div>
              )}
            </div>

            <aside className="tuner-side">
              <section className={`tuner-card card severity-${liveSeverity}`}>
                <div className="tuner-topline">
                  <span className="status-pill ghost">{phase === 'starting' ? '正在打开麦克风' : phase === 'paused' ? '已暂停' : '实时监听'}</span>
                  <span className="tiny-note">{phase === 'paused' ? '回看已录声音' : '小声哼一个长音试试'}</span>
                </div>
                <div className="tuner-main">
                  <div className="tuner-note-block">
                    <span className="tuner-note">{note?.label ?? '—'}</span>
                    <span className="tuner-octave">
                      {note && <span className="octave-name">{note.name} · </span>}
                      {note ? `第 ${note.octave} 八度` : '等待声音'}
                    </span>
                  </div>
                  <div className="tuner-cents-block">
                    <strong className={`tuner-cents ${liveSeverity}`}>
                      {cents == null ? '—' : `${formatCents(cents)} 音分`}
                    </strong>
                    <span className={`tuner-status ${liveSeverity}`}>
                      {cents == null
                        ? '—'
                        : Math.abs(cents) <= TOLERANCE
                          ? '准'
                          : liveDirection === 1
                            ? '↑ 偏高'
                            : '↓ 偏低'}
                    </span>
                    <span className="tuner-hz">{display ? `${display.f0.toFixed(1)} Hz` : '—'}</span>
                  </div>
                </div>

                <div className="tuner-gauge">
                  <div className="gauge-track">
                    <span className="gauge-zone good" />
                    <span className="gauge-zone warn left" />
                    <span className="gauge-zone warn right" />
                  </div>
                  <div className={`gauge-needle ${liveSeverity}`} style={{ left: `${needle}%` }} />
                  <div className="gauge-center" />
                </div>
                <div className="gauge-ticks">
                  <span>−50</span>
                  <span>−25</span>
                  <span>0</span>
                  <span>+25</span>
                  <span>+50</span>
                </div>
              </section>
              {phase === 'paused' && (
                <section className="pause-panel card">
                  <div className="pause-head">
                    <div>
                      <span className="eyebrow">回看</span>
                      <h2>停在这一刻</h2>
                    </div>
                    <span className="pause-time">{formatTime(pausedAt)}</span>
                  </div>
                  {cursor != null ? (
                    selected && selectedNote ? (
                      <div className={`selection-card severity-${selectedSeverity}`}>
                        <div className="selection-main">
                          <strong>{selectedNote.label}</strong>
                          <span className={`selection-cents ${selectedSeverity}`}>
                            {selectedCents == null ? '—' : `${formatCents(selectedCents)} 音分`}
                            {selectedDirection !== 0 && (selectedDirection === 1 ? ' ↑ 偏高' : ' ↓ 偏低')}
                          </span>
                        </div>
                        <div className="selection-meta">
                          <span>{formatTime(cursor)}</span>
                          <span>{selected.f0.toFixed(1)} Hz</span>
                        </div>
                      </div>
                    ) : (
                      <div className="selection-card empty">
                        <strong>{formatTime(cursor)} 附近没有检测到人声</strong>
                        <span>拖动卷帘查看其他位置，或点曲线上的点。</span>
                      </div>
                    )
                  ) : (
                    <div className="selection-card empty">
                      <strong>点一下曲线，查看那一秒</strong>
                      <span>左右拖动只移动视野；点按会落下白色游标。</span>
                    </div>
                  )}

                  <div className="replay-actions">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={snapshotLoading || !voiceReady}
                      onClick={() => void playVoice()}
                    >
                      {replayPlaying ? <StopIcon /> : <PlayIcon />}
                      {replayPlaying ? '停止回放' : snapshotLoading ? '准备录音…' : '回放我的声音'}
                    </button>
                    <button type="button" className="btn primary" onClick={resume}>
                      <PlayIcon />
                      继续
                    </button>
                  </div>
                  {!voiceReady && !snapshotLoading && (
                    <p className="tiny-note">这次没有录到可回放的音频，仍然可以查看音高曲线。</p>
                  )}
                </section>
              )}
            </aside>

            <section className="desktop-transport tuner-dock" aria-label="音准仪控制">
              <div className="dock-main">
                <button
                  type="button"
                  className="round-btn dock-primary"
                  aria-label={phase === 'listening' ? '暂停并回看' : '继续监听'}
                  disabled={phase !== 'listening' && phase !== 'paused'}
                  onClick={() => {
                    if (phase === 'listening') void pause()
                    else if (phase === 'paused') resume()
                  }}
                >
                  {phase === 'listening' ? <PauseIcon /> : <PlayIcon />}
                </button>
                <span className="dock-time">
                  {formatTime(phase === 'paused' ? pausedAt : elapsed)}
                </span>
                <div className="dock-status-copy">
                  <strong>
                    {phase === 'starting' ? '正在准备麦克风' : phase === 'paused' ? '已暂停 · 可回看' : '正在聆听'}
                  </strong>
                  <span>
                    {phase === 'paused'
                      ? '拖动卷帘查看历史，点按落下游标'
                      : '小声哼一个长音，观察指针与曲线'}
                  </span>
                </div>
                <span className={`dock-selection severity-${phase === 'paused' ? selectedSeverity : liveSeverity}`}>
                  {phase === 'paused'
                    ? cursor != null
                      ? selected && selectedNote
                        ? `${selectedNote.label} · ${selectedCents == null ? '—' : `${formatCents(selectedCents)} 音分`} · ${formatTime(cursor)}`
                        : `${formatTime(cursor)} 附近没有检测到人声`
                      : '点选卷帘定位到某一刻'
                    : cents == null
                      ? '等待声音'
                      : `${note?.label ?? '—'} · ${formatCents(cents)} 音分`}
                </span>
                <button
                  type="button"
                  className="btn secondary dock-replay"
                  disabled={phase !== 'paused' || snapshotLoading || !voiceReady}
                  onClick={() => void playVoice()}
                >
                  {replayPlaying ? <StopIcon /> : <PlayIcon />}
                  {replayPlaying ? '停止回放' : snapshotLoading ? '准备录音…' : '回放录音'}
                </button>
                <button type="button" className="btn ghost dock-end" onClick={stopAll}>
                  停止
                </button>
              </div>
              <div className="dock-sub">
                <span>
                  已录 {formatTime(phase === 'paused' ? pausedAt : elapsed)}
                  {phase === 'paused' && selectedCents != null && ` · 选中 ${formatCents(selectedCents)} 音分`}
                </span>
                {error && <span className="dock-error">{error}</span>}
                <span className="key-hints">空格 暂停/继续 · ← → 移动游标 · 悬停查看音名与偏差 · 滚轮缩放</span>
              </div>
            </section>

            {error && <div className="notice warn">{error}</div>}
            <p className="tiny-note center">
              只是观察，不评分。麦克风与录音仅在本机处理，离开页面即丢弃。
            </p>
          </>
        )}
      </main>

      <section className="coach-strip" aria-label="练声小课">
        <div className="section-head">
          <div>
            <h2>练声小课</h2>
            <p>三个短练习，先把音唱稳；完成会记入记录</p>
          </div>
          <span className="count-badge">3 个</span>
        </div>
        <div className="coach-strip-list">
          {COACH_EXERCISES.map((exercise) => (
            <button
              key={exercise.id}
              type="button"
              className="coach-strip-card"
              onClick={() => onStartCoach(exercise.id)}
            >
              <span className="coach-strip-copy">
                <strong>{exercise.title}</strong>
                <small>{exercise.subtitle} · {Math.round(exercise.duration)} 秒</small>
              </span>
              <span className="coach-strip-action"><ChevronRightIcon /></span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
