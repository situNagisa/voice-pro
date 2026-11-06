import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { RawUserPoint } from '../audio/analysis'
import { PitchCapture, mediaErrorMessage } from '../audio/capture'
import {
  COACH_EXERCISES,
  buildCoachTargets,
  coachMelodyNotes,
  findCoachExercise,
  playCoachReference,
  scoreCoachAttempt,
} from '../audio/coach'
import type {
  CoachExercise,
  CoachExerciseId,
  CoachScoreResult,
  CoachToneHandle,
  CoachTargetNote,
} from '../audio/coach'
import { clamp, formatCents, formatTime, midiToFreq, midiToNoteName } from '../audio/pitch'
import type { ReferenceMelody } from '../core/types'
import type { PracticeRecord } from '../state/records'
import { saveRecord } from '../state/records'
import { TopBar } from '../ui/controls'
import {
  CheckIcon,
  HeadphonesIcon,
  MicIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
  TunerIcon,
} from '../ui/icons'
import { PitchRoll } from '../ui/PitchRoll'

interface VocalCoachViewProps {
  initialExercise?: CoachExerciseId | null
  onBack: () => void
  onSaved: () => void
  onOpenRecords: () => void
}

type CoachPhase = 'idle' | 'starting' | 'countdown' | 'listening' | 'result' | 'error'

interface LiveReading {
  midi: number
  f0: number
  cents: number | null
  targetMidi: number | null
}

const ROOT_MIN = 43
const ROOT_MAX = 74

function newRecordId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `coach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

function targetAt(targets: CoachTargetNote[], time: number): CoachTargetNote | null {
  return (
    targets.find((target) => time >= target.start - 0.03 && time <= target.end + 0.03) ?? null
  )
}

function coachGrade(score: number): { title: string; desc: string } {
  if (score >= 90) return { title: '非常稳', desc: '音准和稳定度都很好，可以试试更高或更低的起始音。' }
  if (score >= 75) return { title: '很稳了', desc: '大部分音都站住了。再听一遍参考音，把最弱的那个音单独多唱几次。' }
  if (score >= 60) return { title: '稳住感觉了', desc: '基本在调上，先放松肩膀和喉咙，让气息更均匀。' }
  if (score >= 40) return { title: '还需要再稳一点', desc: '不要追着指针调整，先在心里听住目标音，再平稳地送气。' }
  return { title: '先慢慢来', desc: '把速度放慢，先轻声哼准一个音，再逐渐加大气息。' }
}

function noteTone(rate: number | null): string {
  if (rate == null) return 'none'
  if (rate >= 0.75) return 'good'
  if (rate >= 0.5) return 'warn'
  return 'low'
}

export function VocalCoachView({
  initialExercise,
  onBack,
  onSaved,
  onOpenRecords,
}: VocalCoachViewProps) {
  const [exerciseId, setExerciseId] = useState<CoachExerciseId | null>(initialExercise ?? null)
  const [rootMidi, setRootMidi] = useState(60)
  const [phase, setPhase] = useState<CoachPhase>('idle')
  const [countdown, setCountdown] = useState(3)
  const [elapsed, setElapsed] = useState(0)
  const [current, setCurrent] = useState<LiveReading | null>(null)
  const [result, setResult] = useState<CoachScoreResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const ctxRef = useRef<AudioContext | null>(null)
  const captureRef = useRef<PitchCapture | null>(null)
  const targetsRef = useRef<CoachTargetNote[]>([])
  const activeExerciseRef = useRef<CoachExercise | null>(null)
  const activeRootRef = useRef(rootMidi)
  const pointsRef = useRef<RawUserPoint[]>([])
  const acceptingRef = useRef(false)
  const originRef = useRef(0)
  const elapsedRef = useRef(0)
  const tickRef = useRef<number | null>(null)
  const countdownRef = useRef<number | null>(null)
  const previewRef = useRef<CoachToneHandle | null>(null)
  const previewTimerRef = useRef<number | null>(null)
  const finishingRef = useRef(false)
  const mountedRef = useRef(true)
  const lastUiRef = useRef(0)
  const phaseRef = useRef<CoachPhase>('idle')
  const previewingRef = useRef(false)
  const finishRef = useRef<() => void>(() => undefined)
  phaseRef.current = phase
  previewingRef.current = previewing

  const exercise = exerciseId ? findCoachExercise(exerciseId) : null
  const targets = useMemo(
    () => (exercise ? buildCoachTargets(exercise, rootMidi) : []),
    [exercise, rootMidi],
  )
  const melody = useMemo<ReferenceMelody>(
    () => ({
      duration: exercise?.duration ?? 5,
      hop: 0.01,
      frames: [],
      notes: coachMelodyNotes(targets),
    }),
    [exercise, targets],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimers()
      stopPreview()
      captureRef.current?.stop()
      captureRef.current = null
      const ctx = ctxRef.current
      ctxRef.current = null
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    }
    // 只在离开练声页时彻底释放
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function clearTimers(): void {
    if (tickRef.current != null) {
      window.clearInterval(tickRef.current)
      tickRef.current = null
    }
    if (countdownRef.current != null) {
      window.clearInterval(countdownRef.current)
      countdownRef.current = null
    }
  }

  function stopPreview(): void {
    previewRef.current?.stop()
    previewRef.current = null
    if (previewTimerRef.current != null) {
      window.clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    if (mountedRef.current) setPreviewing(false)
  }

  async function ensureContext(): Promise<AudioContext> {
    let ctx = ctxRef.current
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext({ latencyHint: 'interactive' })
      ctxRef.current = ctx
    }
    await ctx.resume()
    return ctx
  }

  async function togglePreview(): Promise<void> {
    if (!exercise) return
    if (previewing) {
      stopPreview()
      return
    }
    try {
      const ctx = await ensureContext()
      const previewTargets = buildCoachTargets(exercise, rootMidi)
      previewRef.current?.stop()
      previewRef.current = playCoachReference(ctx, previewTargets, exercise.previewNoteSeconds)
      setPreviewing(true)
      const totalSeconds = previewTargets.length * exercise.previewNoteSeconds
      previewTimerRef.current = window.setTimeout(() => {
        previewRef.current = null
        previewTimerRef.current = null
        if (mountedRef.current) setPreviewing(false)
      }, totalSeconds * 1000 + 240)
    } catch {
      setError('参考音播放失败，请再点一次。')
    }
  }

  function beginListening(ctx: AudioContext, target: CoachExercise): void {
    if (!mountedRef.current) return
    const startedAt = ctx.currentTime
    originRef.current = startedAt
    elapsedRef.current = 0
    setElapsed(0)
    setCountdown(0)
    setPhase('listening')
    acceptingRef.current = true
    setCurrent(null)

    if (tickRef.current != null) window.clearInterval(tickRef.current)
    tickRef.current = window.setInterval(() => {
      const now = Math.max(0, ctx.currentTime - startedAt)
      elapsedRef.current = now
      setElapsed(Math.min(now, target.duration))
      if (now >= target.duration + 0.08) {
        finishRef.current()
      }
    }, 50)
  }

  async function startExercise(): Promise<void> {
    if (!exercise) return
    stopPreview()
    clearTimers()
    acceptingRef.current = false
    finishingRef.current = false
    captureRef.current?.stop()
    captureRef.current = null
    pointsRef.current = []
    elapsedRef.current = 0
    setElapsed(0)
    setCurrent(null)
    setResult(null)
    setSaved(false)
    setSaving(false)
    setError(null)
    setPhase('starting')
    activeExerciseRef.current = exercise
    activeRootRef.current = rootMidi
    targetsRef.current = targets

    let ctx: AudioContext
    try {
      ctx = await ensureContext()
    } catch {
      setPhase('error')
      setError('无法启动音频，请检查系统声音设置后重试。')
      return
    }
    let capture: PitchCapture | null = null
    try {
      capture = new PitchCapture(ctx)
      await capture.start(
        'mic',
        (frame) => {
          if (!mountedRef.current || !acceptingRef.current) return
          const activeExercise = activeExerciseRef.current
          if (!activeExercise) return
          const time = frame.t - originRef.current
          if (time < -0.05 || time > activeExercise.duration + 0.1) return
          if (frame.f0 == null || frame.midi == null) {
            if (performance.now() - lastUiRef.current > 200) {
              lastUiRef.current = performance.now()
              setCurrent(null)
            }
            return
          }
          pointsRef.current.push({
            t: time,
            f0: frame.f0,
            midi: frame.midi,
            clarity: frame.clarity,
          })
          if (performance.now() - lastUiRef.current >= 40) {
            lastUiRef.current = performance.now()
            const target = targetAt(targetsRef.current, time)
            setCurrent({
              midi: frame.midi,
              f0: frame.f0,
              cents: target ? (frame.midi - target.midi) * 100 : null,
              targetMidi: target?.midi ?? null,
            })
          }
        },
        () => {
          if (!mountedRef.current) return
          acceptingRef.current = false
          if (phaseRef.current === 'listening') {
            finishRef.current()
            return
          }
          clearTimers()
          captureRef.current?.stop()
          captureRef.current = null
          setError('麦克风输入已结束。检查设备后再试一次。')
          setPhase('error')
        },
      )
      if (!mountedRef.current) {
        capture.stop()
        return
      }
      captureRef.current = capture
      setPhase('countdown')
      setCountdown(3)
      let remaining = 3
      countdownRef.current = window.setInterval(() => {
        remaining -= 1
        if (remaining <= 0) {
          if (countdownRef.current != null) {
            window.clearInterval(countdownRef.current)
            countdownRef.current = null
          }
          beginListening(ctx, exercise)
        } else {
          setCountdown(remaining)
        }
      }, 1000)
    } catch (err) {
      capture?.stop()
      captureRef.current = null
      clearTimers()
      setPhase('error')
      setError(mediaErrorMessage(err, 'mic'))
    }
  }

  async function finishAttempt(): Promise<void> {
    if (finishingRef.current) return
    finishingRef.current = true
    acceptingRef.current = false
    clearTimers()
    captureRef.current?.stop()
    captureRef.current = null
    const activeExercise = activeExerciseRef.current
    const scoredTargets = targetsRef.current
    const points = pointsRef.current.slice()
    setCurrent(null)

    if (!activeExercise) {
      setPhase('idle')
      finishingRef.current = false
      return
    }

    const scored = scoreCoachAttempt(
      points,
      scoredTargets,
      activeExercise.tolerance,
      activeExercise.id,
    )
    setResult(scored)
    setPhase('result')
    finishingRef.current = false

    if (scored.score == null) {
      setSaving(false)
      setSaved(false)
      return
    }

    setSaving(true)
    const record: PracticeRecord = {
      id: newRecordId(),
      createdAt: Date.now(),
      songId: `coach-${activeExercise.id}`,
      songName: `练声 · ${activeExercise.title} ${midiToNoteName(activeRootRef.current).label}`,
      songKind: 'exercise',
      duration: activeExercise.duration,
      score: scored.score,
      hitRate: scored.hitRate,
      tolerance: activeExercise.tolerance,
      transpose: 0,
      octaveAlign: false,
      points,
      melodyNotes: coachMelodyNotes(scoredTargets),
      melodyDuration: activeExercise.duration,
      voice: null,
      voiceMime: null,
      segments: [
        {
          songStart: 0,
          voiceStart: 0,
          duration: Math.min(
            activeExercise.duration,
            Math.max(0.1, elapsedRef.current),
          ),
        },
      ],
      loop: null,
    }
    try {
      await saveRecord(record)
      onSaved()
      if (mountedRef.current) {
        setSaved(true)
        setSaving(false)
      }
    } catch (err) {
      console.warn('[voice-pro] 练声记录保存失败', err)
      if (mountedRef.current) {
        setSaving(false)
        setError('练声结果保存失败，本次不会出现在记录里。')
      }
    }
  }
  finishRef.current = () => {
    void finishAttempt()
  }

  function cleanupSession(): void {
    acceptingRef.current = false
    clearTimers()
    captureRef.current?.stop()
    captureRef.current = null
    pointsRef.current = []
    elapsedRef.current = 0
    setCurrent(null)
    setElapsed(0)
    setCountdown(3)
  }

  function abortToSetup(clearExercise = false): void {
    cleanupSession()
    stopPreview()
    setResult(null)
    setSaved(false)
    setSaving(false)
    setError(null)
    setPhase('idle')
    if (clearExercise) setExerciseId(null)
  }

  function handleBack(): void {
    if (phase === 'starting' || phase === 'countdown' || phase === 'listening') {
      if (!window.confirm('结束本次练声？这次还没有完成，不会保存。')) return
      cleanupSession()
      stopPreview()
      onBack()
      return
    }
    stopPreview()
    onBack()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.settings-sheet')) return
      event.preventDefault()
      handleBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const liveTarget = targetAt(targets, elapsed)
  const liveNote = current ? midiToNoteName(current.midi) : null
  const targetNote = liveTarget ? midiToNoteName(liveTarget.midi) : null
  const liveCents = current?.cents ?? null
  const liveSeverity =
    liveCents == null
      ? 'neutral'
      : Math.abs(liveCents) <= (exercise?.tolerance ?? 40)
        ? 'good'
        : liveCents > 0
          ? 'sharp'
          : 'flat'
  const progress = exercise ? clamp(elapsed / exercise.duration, 0, 1) : 0
  const activeNoteIndex = liveTarget
    ? targets.findIndex((target) => target === liveTarget)
    : -1

  return (
    <div className="screen coach-screen">
      <TopBar
        title="练声小课"
        subtitle={exercise ? exercise.title : '音准仪'}
        onBack={handleBack}
        right={
          exercise && phase !== 'idle' ? (
            <span className="coach-progress-chip">
              {formatTime(phase === 'result' ? (activeExerciseRef.current?.duration ?? 0) : elapsed)}
              {' / '}
              {formatTime(exercise.duration)}
            </span>
          ) : undefined
        }
      />

      <main className="page coach-page">
        {phase === 'idle' && !exercise && (
          <>
            <section className="card coach-intro">
              <span className="empty-icon"><TunerIcon /></span>
              <div>
                <p className="eyebrow">练声小课</p>
                <h1>把音唱稳，再去唱歌</h1>
                <p>
                  三个固定练习，目标音和评分标准都写在明面上。可以先试听参考音，
                  完成一次后自动记入“记录”，和歌曲练习一起看进步。
                </p>
              </div>
            </section>

            <div className="coach-list">
              {COACH_EXERCISES.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className="card coach-card"
                  onClick={() => setExerciseId(item.id)}
                >
                  <span className="coach-index">0{index + 1}</span>
                  <span className="coach-copy">
                    <strong>{item.title}</strong>
                    <small>{item.subtitle}</small>
                    <span className="coach-card-meta">
                      {Math.round(item.duration)} 秒 · ±{item.tolerance} 音分
                    </span>
                  </span>
                  <span className="coach-card-action"><PlayIcon /></span>
                </button>
              ))}
            </div>

            <aside className="headphone-note">
              <HeadphonesIcon />
              <div>
                <strong>建议戴耳机</strong>
                <span>参考音只用来看目标，不会在练习中播放；外放时仍可能被麦克风收进去，影响抖动判断。</span>
              </div>
            </aside>
          </>
        )}

        {phase === 'idle' && exercise && (
          <>
            <button type="button" className="text-btn align-left" onClick={() => setExerciseId(null)}>
              ← 全部练习
            </button>
            <section className="card coach-setup">
              <div className="coach-setup-head">
                <div>
                  <p className="eyebrow">{exercise.subtitle}</p>
                  <h1>{exercise.title}</h1>
                  <p>{exercise.description}</p>
                </div>
                <span className="coach-duration">{Math.round(exercise.duration)} 秒</span>
              </div>

              <div className="coach-targets">
                <span className="field-label">目标音序列</span>
                <div className="coach-target-chips">
                  {targets.map((target, index) => (
                    <span key={`${target.midi}-${index}`} className="coach-target-chip">
                      {midiToNoteName(target.midi).label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="coach-root">
                <div className="field-label">起始音</div>
                <div className="coach-root-control">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="降低起始音半音"
                    disabled={rootMidi <= ROOT_MIN}
                    onClick={() => {
                      stopPreview()
                      setRootMidi((value) => clamp(value - 1, ROOT_MIN, ROOT_MAX))
                    }}
                  >
                    −
                  </button>
                  <div className="coach-root-readout">
                    <strong>{midiToNoteName(rootMidi).label}</strong>
                    <span>{midiToFreq(rootMidi).toFixed(1)} Hz</span>
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="升高起始音半音"
                    disabled={rootMidi >= ROOT_MAX}
                    onClick={() => {
                      stopPreview()
                      setRootMidi((value) => clamp(value + 1, ROOT_MIN, ROOT_MAX))
                    }}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className={`btn small secondary ${previewing ? 'active' : ''}`}
                    aria-pressed={previewing}
                    onClick={() => void togglePreview()}
                  >
                    {previewing ? <StopIcon /> : <PlayIcon />}
                    {previewing ? '停止试听' : '试听参考音'}
                  </button>
                </div>
                <p className="tiny-note">
                  觉得太低或太高时，可以按半音调整；所有练习目标都会跟着移动。
                </p>
              </div>

              <div className="coach-criteria">
                <strong>评分标准</strong>
                <p>{exercise.criteria}</p>
                <ul>
                  <li>命中：音高落在目标音 ±{exercise.tolerance} 音分以内。</li>
                  <li>
                    {exercise.id === 'long-tone'
                      ? '稳定段：起音后 0.7 秒开始计分，到 4.6 秒结束，避开起音与收尾。'
                      : '每个音只取站稳后的片段（避开起音和换音瞬间）。'}
                  </li>
                  <li>有效音高不足 20 帧时不给分，也不会写入记录。</li>
                </ul>
              </div>

              <div className="coach-tips">
                {exercise.tips.map((tip) => (
                  <span key={tip}>{tip}</span>
                ))}
              </div>

              {error && <div className="notice warn">{error}</div>}

              <button type="button" className="btn primary block coach-start" onClick={() => void startExercise()}>
                <MicIcon />
                开始练习
              </button>
            </section>
          </>
        )}

        {(phase === 'starting' || phase === 'countdown') && exercise && (
          <section className="card coach-countdown">
            <p className="eyebrow">准备</p>
            {phase === 'starting' ? (
              <>
                <div className="spinner large" />
                <h1>正在打开麦克风…</h1>
                <p>允许麦克风后，会有 3 秒准备时间。</p>
              </>
            ) : (
              <>
                <div className="coach-countdown-number">{countdown}</div>
                <h1>听住目标音</h1>
                <p>
                  第一个目标 <strong>{midiToNoteName(targets[0]?.midi ?? rootMidi).label}</strong>
                  {exercise.id === 'long-tone' ? '，保持 5 秒' : '，跟着时间线依次唱下去'}。
                </p>
                <div className="coach-target-chips">
                  {targets.map((target, index) => (
                    <span key={`${target.midi}-${index}`} className="coach-target-chip">
                      {midiToNoteName(target.midi).label}
                    </span>
                  ))}
                </div>
              </>
            )}
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                cleanupSession()
                setPhase('idle')
              }}
            >
              取消
            </button>
          </section>
        )}

        {phase === 'listening' && exercise && (
          <>
            <section className={`card coach-live severity-${liveSeverity}`}>
              <div className="coach-live-head">
                <div>
                  <p className="eyebrow">
                    {exercise.id === 'long-tone'
                      ? '保持住'
                      : `第 ${Math.max(1, activeNoteIndex + 1)} / ${targets.length} 个音`}
                  </p>
                  <h1>目标 {targetNote?.label ?? '—'}</h1>
                </div>
                <span className="coach-live-time">{formatTime(Math.max(0, exercise.duration - elapsed))}</span>
              </div>
              <div className="coach-live-main">
                <div className="coach-live-note">
                  <span>{liveNote?.label ?? '—'}</span>
                  <small>{current ? `${current.f0.toFixed(1)} Hz` : '等待声音'}</small>
                </div>
                <div className="coach-live-cents">
                  <strong className={liveSeverity}>
                    {liveCents == null ? '—' : `${formatCents(liveCents)} 音分`}
                  </strong>
                  <span className={liveSeverity}>
                    {liveCents == null
                      ? '换气或等待目标'
                      : Math.abs(liveCents) <= exercise.tolerance
                        ? '准'
                        : liveCents > 0
                          ? '↑ 偏高'
                          : '↓ 偏低'}
                  </span>
                </div>
              </div>
              <div className="coach-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="coach-live-foot">
                <span>{formatTime(elapsed)} / {formatTime(exercise.duration)}</span>
                <span className="tiny-note">
                  {exercise.id === 'long-tone'
                    ? '看住目标音，别追着指针上下调整'
                    : '每个音都先站稳，再换下一个'}
                </span>
              </div>
            </section>

            <section className="card coach-roll-card">
              <PitchRoll
                melody={melody}
                pointsRef={pointsRef}
                duration={exercise.duration}
                transpose={0}
                octaveAlign={false}
                tolerance={exercise.tolerance}
                mode="practice"
                active
                interactive={false}
                getPlayhead={() => elapsedRef.current}
                getCenter={() => Math.min(exercise.duration, Math.max(2, elapsedRef.current + 1.4))}
                ariaLabel="练声音高曲线"
                playheadLabel="现在"
              />
              <div className="roll-legend">
                <span><i className="dot good" />准 (±{exercise.tolerance})</span>
                <span><i className="dot sharp" />偏高 ↑</span>
                <span><i className="dot flat" />偏低 ↓</span>
                <span className="legend-spacer" />
                <span>紫色条为目标音</span>
              </div>
            </section>

            <div className="coach-live-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  if (window.confirm('提前结束这次练习？未完成的片段仍会按已有数据评分。')) {
                    finishRef.current()
                  }
                }}
              >
                提前结束并评分
              </button>
            </div>
          </>
        )}

        {phase === 'result' && exercise && result && (
          <CoachResult
            exercise={exercise}
            result={result}
            saving={saving}
            saved={saved}
            error={error}
            onRetry={() => void startExercise()}
            onChangeExercise={() => abortToSetup(true)}
            onOpenRecords={() => {
              stopPreview()
              onOpenRecords()
            }}
          />
        )}

        {phase === 'error' && (
          <section className="card empty-card">
            <div className="empty-icon"><MicIcon /></div>
            <h1>没能继续练声</h1>
            <p>{error ?? '音频输入出现问题，请重试。'}</p>
            <div className="row-actions">
              <button type="button" className="btn primary" onClick={() => void startExercise()}>
                <RefreshIcon />
                重试
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => abortToSetup()}
              >
                回到准备页
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

interface CoachResultProps {
  exercise: CoachExercise
  result: CoachScoreResult
  saving: boolean
  saved: boolean
  error: string | null
  onRetry: () => void
  onChangeExercise: () => void
  onOpenRecords: () => void
}

function CoachResult({
  exercise,
  result,
  saving,
  saved,
  error,
  onRetry,
  onChangeExercise,
  onOpenRecords,
}: CoachResultProps) {
  const score = result.score
  const grade = score == null ? null : coachGrade(score)
  const scoreStyle = { '--score': score ?? 0 } as CSSProperties

  return (
    <>
      <section className="card coach-result-hero">
        <div className="score-ring" style={scoreStyle}>
          <div className="score-ring-inner">
            <strong>{score ?? '—'}</strong>
            <span>本次得分</span>
          </div>
        </div>
        <div className="coach-result-copy">
          <p className="eyebrow">{exercise.title}</p>
          <h1>{grade?.title ?? '没有有效声音'}</h1>
          <p>
            {grade?.desc ??
              `只录到 ${result.samples} 个有效音高帧，不足 20 帧不评分。确认麦克风在收音、环境安静后，再试一次。`}
          </p>
          <div className="coach-save-state">
            {saving ? (
              <><i className="spinner" /> 正在保存到记录…</>
            ) : saved ? (
              <><CheckIcon /> 已保存到记录</>
            ) : score == null ? (
              <span className="warn">本次未写入记录</span>
            ) : error ? (
              <span className="warn">{error}</span>
            ) : null}
          </div>
        </div>
      </section>

      <section className="coach-result-stats">
        <div className="stat-card">
          <span>音准命中</span>
          <strong>{result.hitRate == null ? '—' : `${Math.round(result.hitRate * 100)}%`}</strong>
          <small>落在 ±{exercise.tolerance} 音分内</small>
        </div>
        <div className="stat-card">
          <span>平均偏差</span>
          <strong className={result.avgCents == null ? '' : result.avgCents > 0 ? 'sharp' : 'flat'}>
            {result.avgCents == null ? '—' : `${formatCents(result.avgCents)} 音分`}
          </strong>
          <small>正数偏高 · 负数偏低</small>
        </div>
        <div className="stat-card">
          <span>{exercise.id === 'long-tone' ? '音高抖动' : '稳定度'}</span>
          <strong>
            {exercise.id === 'long-tone'
              ? result.jitterCents == null
                ? '—'
                : `±${result.jitterCents.toFixed(0)} 音分`
              : result.stability == null
                ? '—'
                : `${Math.round(result.stability * 100)}%`}
          </strong>
          <small>{exercise.id === 'long-tone' ? '越小越稳' : '平均偏差越小越高'}</small>
        </div>
        <div className="stat-card">
          <span>有效音高</span>
          <strong>{result.samples}</strong>
          <small>{result.hits} 个命中</small>
        </div>
      </section>

      <section className="card coach-note-results">
        <div className="section-head">
          <div>
            <h2>每个音的表现</h2>
            <p>目标音与命中率；未唱到的音不强行算 0，单独标出</p>
          </div>
        </div>
        <ul className="coach-note-grid">
          {result.notes.map((note, index) => (
            <li key={`${note.midi}-${index}`} className={`tone-${noteTone(note.hitRate)}`}>
              <strong>{note.label}</strong>
              <span>{note.hitRate == null ? '未唱到' : `${Math.round(note.hitRate * 100)}%`}</span>
              <small>
                {note.avgCents == null ? '—' : `${formatCents(note.avgCents)} 音分`}
              </small>
            </li>
          ))}
        </ul>
        <p className="progress-foot">
          总分 = 音准命中率 70% + 稳定度 30%。{exercise.criteria}
        </p>
      </section>

      <div className="report-actions coach-result-actions">
        <button type="button" className="btn primary" onClick={onRetry}>
          <RefreshIcon />
          再练一次
        </button>
        <button type="button" className="btn secondary" onClick={onChangeExercise}>
          换个练习
        </button>
        <button type="button" className="btn ghost" onClick={onOpenRecords}>
          查看记录
        </button>
      </div>
    </>
  )
}
