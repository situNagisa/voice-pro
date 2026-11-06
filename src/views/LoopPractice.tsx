import { useEffect, useMemo, useRef, useState } from 'react'
import { evalPass } from '../audio/loopScore'
import type { PassResult } from '../audio/loopScore'
import { mediaErrorMessage, PitchCapture } from '../audio/capture'
import { compareToTarget, referenceMidiAt } from '../audio/analysis'
import type { RawUserPoint } from '../audio/analysis'
import { LoopPlayer } from '../audio/loopPlayer'
import { formatCents, formatTime, midiToNoteName } from '../audio/pitch'
import { estimateBeatSeconds, processBuffer, sliceBuffer } from '../audio/transform'
import type { Note, ReferenceMelody } from '../core/types'
import type { LoopRange } from '../audio/player'
import type { LoadedSong, PracticeLoopTarget } from '../state/session'
import type { Settings } from '../state/settings'
import { Segmented, TopBar } from '../ui/controls'
import {
  HeadphonesIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
} from '../ui/icons'
import { PitchRoll } from '../ui/PitchRoll'

interface LoopPracticeProps {
  song: LoadedSong
  targets: PracticeLoopTarget[]
  label: string
  settings: Settings
  onPatchSettings: (patch: Partial<Settings>) => void
  onBack: () => void
}

type Phase = 'starting' | 'active' | 'paused' | 'preparing' | 'error'

interface RangePrepared {
  buffer: AudioBuffer
  melody: ReferenceMelody
  scoreStart: number
  scoreEnd: number
  duration: number
  beat: number
}

interface CurrentReading {
  midi: number
  f0: number
  cents: number | null
  targetMidi: number | null
  octaveShift: number
}

function newRangeMelody(
  notes: Note[],
  target: LoopRange,
  leadStart: number,
  padBefore: number,
  speed: number,
  transpose: number,
  duration: number,
): ReferenceMelody {
  const localNotes: Note[] = []
  for (const note of notes) {
    if (note.end < target.start - 0.05 || note.start > target.end + 0.05) continue
    const start = (padBefore + note.start - leadStart) / speed
    const end = (padBefore + note.end - leadStart) / speed
    if (end <= 0 || start >= duration) continue
    localNotes.push({
      start: Math.max(0, start),
      end: Math.min(duration, end),
      midi: note.midi + transpose,
    })
  }
  return { duration, hop: 0.01, frames: [], notes: localNotes }
}

function Sparkline({ results }: { results: PassResult[] }) {
  const data = results.slice(-8)
  const validCount = data.filter((item) => item.hitRate != null).length
  if (validCount < 2) {
    return <p className="loop-chart-empty">再完整唱一遍，这里会出现连续几遍的命中率折线。</p>
  }
  const width = 260
  const height = 64
  const padX = 10
  const padY = 10
  const step = data.length > 1 ? (width - padX * 2) / (data.length - 1) : 0
  const xFor = (index: number) => padX + index * step
  const yFor = (rate: number) => padY + (1 - rate / 100) * (height - padY * 2)
  let path = ''
  let segment = false
  for (let index = 0; index < data.length; index++) {
    const rate = data[index].hitRate
    if (rate == null) {
      segment = false
      continue
    }
    const value = `${xFor(index).toFixed(1)} ${yFor(rate * 100).toFixed(1)}`
    path += `${segment ? ' L ' : ' M '}${value}`
    segment = true
  }
  return (
    <div className="loop-chart-wrap">
      <svg
        className="loop-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="最近几遍的命中率折线"
      >
        {[0, 50, 100].map((line) => (
          <line
            key={line}
            x1={padX}
            x2={width - padX}
            y1={yFor(line)}
            y2={yFor(line)}
            className={line === 50 ? 'chart-mid' : 'chart-grid'}
          />
        ))}
        <path d={path} className="chart-line" />
        {data.map((item, index) =>
          item.hitRate == null ? null : (
            <circle
              key={`${item.pass}-${index}`}
              cx={xFor(index)}
              cy={yFor(item.hitRate * 100)}
              r={3.2}
              className={`chart-dot ${item.hitRate >= 0.75 ? 'good' : item.hitRate >= 0.5 ? 'warn' : 'bad'}`}
            />
          ),
        )}
      </svg>
      <div className="loop-chart-foot">
        {data.map((item) => (
          <span key={item.pass}>
            {item.hitRate == null ? '—' : `${Math.round(item.hitRate * 100)}%`}
          </span>
        ))}
      </div>
    </div>
  )
}

function PassHistory({ results }: { results: PassResult[] }) {
  if (results.length === 0) return null
  const valid = results.filter((item) => item.hitRate != null)
  const best = valid.reduce<PassResult | null>(
    (current, item) => (current == null || (item.hitRate ?? 0) > (current.hitRate ?? 0) ? item : current),
    null,
  )
  const last = results[results.length - 1]
  return (
    <div className="loop-history">
      <Sparkline results={results} />
      <div className="loop-history-copy">
        <span>最近 {results.length} 遍</span>
        {best && <strong>最好 {Math.round((best.hitRate ?? 0) * 100)}%</strong>}
        {last.hitRate == null && <span>最后一遍有效歌声不足</span>}
      </div>
    </div>
  )
}

export function LoopPracticeView({
  song,
  targets,
  label,
  settings,
  onPatchSettings,
  onBack,
}: LoopPracticeProps) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('正在打开麦克风…')
  const [targetIndex, setTargetIndex] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [transpose, setTranspose] = useState(settings.transpose)
  const [current, setCurrent] = useState<CurrentReading | null>(null)
  const [now, setNow] = useState(0)
  const [pass, setPass] = useState(1)
  const [history, setHistory] = useState<PassResult[]>([])
  const [lastResult, setLastResult] = useState<PassResult | null>(null)
  const [range, setRange] = useState<RangePrepared | null>(null)

  const playerRef = useRef<LoopPlayer | null>(null)
  const captureRef = useRef<PitchCapture | null>(null)
  const rangeRef = useRef<RangePrepared | null>(null)
  const pointsRef = useRef<RawUserPoint[]>([])
  const acceptingRef = useRef(false)
  const mountedRef = useRef(true)
  const settingsRef = useRef(settings)
  const speedRef = useRef(speed)
  const transposeRef = useRef(transpose)
  const targetIndexRef = useRef(targetIndex)
  const passRef = useRef(1)
  const lastPositionRef = useRef(0)
  const lastUiRef = useRef(0)
  const latencyRef = useRef(60)
  const rebuildTokenRef = useRef(0)
  const rangeCacheRef = useRef(new Map<string, Promise<RangePrepared>>())
  const historyRef = useRef<PassResult[]>([])

  settingsRef.current = settings
  speedRef.current = speed
  transposeRef.current = transpose
  targetIndexRef.current = targetIndex
  historyRef.current = history

  const currentTarget = targets[Math.min(targetIndex, targets.length - 1)] ?? null
  const scoreStart = range?.scoreStart ?? 0
  const scoreEnd = range?.scoreEnd ?? 0
  const duration = range?.duration ?? 0
  const preroll = phase === 'active' && now < scoreStart
  const tone =
    current?.cents == null
      ? 'neutral'
      : Math.abs(current.cents) <= settings.tolerance
        ? 'good'
        : current.cents > 0
          ? 'sharp'
          : 'flat'
  const direction =
    current?.cents == null || Math.abs(current.cents) <= settings.tolerance
      ? 0
      : current.cents > 0
        ? 1
        : -1
  const displayNote = current ? midiToNoteName(current.midi) : null
  const displayTarget = current?.targetMidi != null ? midiToNoteName(current.targetMidi) : null

  const rangeMelody = range?.melody ?? null

  useEffect(() => {
    mountedRef.current = true
    const timer = window.setTimeout(() => {
      void startSession()
    }, 80)
    return () => {
      mountedRef.current = false
      window.clearTimeout(timer)
      captureRef.current?.stop()
      captureRef.current = null
      playerRef.current?.dispose()
      playerRef.current = null
    }
    // 只在进入循环页时启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    playerRef.current?.setVolume(settings.volume)
  }, [settings.volume])

  useEffect(() => {
    if (settings.transpose === transposeRef.current) return
    transposeRef.current = settings.transpose
    setTranspose(settings.transpose)
    if (phase === 'active' || phase === 'paused' || phase === 'preparing') {
      void loadRange(speedRef.current, settings.transpose, targetIndexRef.current)
    }
    // 设置面板里改了移调时同步重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.transpose])

  useEffect(() => {
    if (phase !== 'active' || !playerRef.current) return
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (!player) return
      const position = player.position
      if (position + 0.25 < lastPositionRef.current) {
        completePass()
      }
      lastPositionRef.current = position
      setNow(position)
    }, 55)
    return () => window.clearInterval(timer)
    // 只在播放时跑计时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (document.querySelector('.settings-sheet')) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        if (target?.closest('button')) return
        event.preventDefault()
        if (phase === 'active') pauseSession()
        else if (phase === 'paused') void resumeSession()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        confirmBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 快捷键只依赖当前阶段；位置与成绩从 ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  async function prepareRange(
    index: number,
    nextSpeed: number,
    nextTranspose: number,
  ): Promise<RangePrepared> {
    const target = targets[index]
    if (!target) throw new Error('没有可练习的句子。')
    const beat = estimateBeatSeconds(song.melody.notes, song.bpm)
    const source = song.accompaniment ?? song.buffer
    const leadStart = Math.max(0, target.start - beat)
    const padBefore = Math.max(0, beat - (target.start - leadStart))
    const loopEnd = Math.min(source.duration, target.end + 0.2)
    const key = `${index}:${nextSpeed}:${nextTranspose}:${leadStart.toFixed(3)}:${loopEnd.toFixed(3)}`
    const cached = rangeCacheRef.current.get(key)
    if (cached) return cached

    const task = (async () => {
      const slice = sliceBuffer(source, leadStart, loopEnd, padBefore)
      const processed = await processBuffer(slice, {
        semitones: nextTranspose,
        speed: nextSpeed,
      })
      const localDuration = processed.duration
      const localScoreStart = Math.min(
        localDuration - 0.02,
        (padBefore + target.start - leadStart) / nextSpeed,
      )
      const localScoreEnd = Math.min(
        localDuration,
        (padBefore + target.end - leadStart) / nextSpeed,
      )
      const melody = newRangeMelody(
        song.melody.notes,
        target,
        leadStart,
        padBefore,
        nextSpeed,
        nextTranspose,
        localDuration,
      )
      const scoreStart = Math.max(0, Math.min(localScoreStart, localDuration - 0.05))
      return {
        buffer: processed,
        melody,
        scoreStart,
        scoreEnd: Math.min(localDuration, Math.max(scoreStart + 0.05, localScoreEnd)),
        duration: localDuration,
        beat,
      }
    })()
    rangeCacheRef.current.set(key, task)
    task.catch(() => rangeCacheRef.current.delete(key))
    if (rangeCacheRef.current.size > 12) {
      const oldest = rangeCacheRef.current.keys().next().value
      if (oldest) rangeCacheRef.current.delete(oldest)
    }
    return task
  }

  async function startSession(): Promise<void> {
    if (!mountedRef.current) return
    setPhase('starting')
    setError(null)
    setStatusText('正在打开麦克风…')
    captureRef.current?.stop()
    captureRef.current = null
    playerRef.current?.dispose()
    playerRef.current = null
    let player: LoopPlayer | null = null
    let capture: PitchCapture | null = null
    try {
      player = new LoopPlayer()
      playerRef.current = player
      player.setVolume(settingsRef.current.volume)
      await player.resume()
      if (!mountedRef.current) {
        player.dispose()
        return
      }

      setStatusText('正在校准输入…')
      capture = new PitchCapture(player.ctx)
      await capture.start(
        'mic',
        (frame) => {
          if (!mountedRef.current || !acceptingRef.current) return
          const active = playerRef.current
          if (!active?.isPlaying) return
          const activeRange = rangeRef.current
          if (!activeRange) return
          if (frame.f0 == null || frame.midi == null) {
            if (performance.now() - lastUiRef.current > 260) {
              lastUiRef.current = performance.now()
              setCurrent(null)
            }
            return
          }
          const t = active.positionAt(frame.t)
          const localT = ((t - latencyRef.current / 1000) % activeRange.duration + activeRange.duration) % activeRange.duration
          if (!Number.isFinite(localT)) return
          pointsRef.current.push({
            t: localT,
            f0: frame.f0,
            midi: frame.midi,
            clarity: frame.clarity,
          })
          if (performance.now() - lastUiRef.current >= 40) {
            lastUiRef.current = performance.now()
            const target = referenceMidiAt(activeRange.melody, localT)
            const comparison =
              target == null
                ? null
                : compareToTarget(
                    frame.midi,
                    target,
                    settingsRef.current.octaveAlign,
                    settingsRef.current.tolerance,
                  )
            setCurrent({
              midi: frame.midi,
              f0: frame.f0,
              cents: comparison?.cents ?? null,
              targetMidi: target,
              octaveShift: comparison?.octaveShift ?? 0,
            })
          }
        },
        () => {
          if (!mountedRef.current) return
          acceptingRef.current = false
          playerRef.current?.pause()
          setPhase('paused')
          setError('音频输入已结束。重新开始即可继续练这一句。')
        },
      )
      if (!mountedRef.current) {
        capture.stop()
        player.dispose()
        return
      }
      captureRef.current = capture
      latencyRef.current =
        settingsRef.current.latencyMs ?? Math.max(0, Math.round(capture.latencyMs))

      setPhase('preparing')
      setStatusText('正在准备这一句…')
      const ok = await loadRange(targetIndexRef.current, speedRef.current, transposeRef.current, true)
      if (!mountedRef.current || !ok) return
      setPhase('active')
      setStatusText('循环练习中')
    } catch (err) {
      capture?.stop()
      player?.dispose()
      playerRef.current = null
      captureRef.current = null
      if (!mountedRef.current) return
      setPhase('error')
      setError(mediaErrorMessage(err, 'mic'))
    }
  }

  async function loadRange(
    index: number,
    nextSpeed: number,
    nextTranspose: number,
    initial = false,
  ): Promise<boolean> {
    const player = playerRef.current
    if (!player) return false
    const token = ++rebuildTokenRef.current
    const target = targets[index]
    if (!target) return false
    if (!initial) {
      setPhase('preparing')
      setStatusText(`正在准备第 ${index + 1} 句…`)
      setError(null)
    }
    acceptingRef.current = false
    player.pause()
    try {
      const prepared = await prepareRange(index, nextSpeed, nextTranspose)
      if (!mountedRef.current || token !== rebuildTokenRef.current) return false
      rangeRef.current = prepared
      setRange(prepared)
      pointsRef.current = []
      passRef.current = 1
      setPass(1)
      setHistory([])
      setLastResult(null)
      setCurrent(null)
      setNow(0)
      lastPositionRef.current = 0
      player.setBuffer(prepared.buffer)
      player.play(0)
      acceptingRef.current = true
      setPhase('active')
      setStatusText('循环练习中')
      return true
    } catch (err) {
      if (!mountedRef.current || token !== rebuildTokenRef.current) return false
      setPhase('error')
      setError(
        err instanceof Error
          ? `这一句的准备失败：${err.message}`
          : '这一句的准备失败，请重试。',
      )
      return false
    }
  }

  function completePass(): void {
    const activeRange = rangeRef.current
    if (!activeRange) return
    const result = evalPass({
      points: pointsRef.current,
      melody: activeRange.melody,
      scoreStart: activeRange.scoreStart,
      scoreEnd: activeRange.scoreEnd,
      octaveAlign: settingsRef.current.octaveAlign,
      tolerance: settingsRef.current.tolerance,
      pass: passRef.current,
    })
    passRef.current += 1
    setPass(passRef.current)
    setLastResult(result)
    setHistory((previous) => [...previous, result].slice(-12))
    pointsRef.current = []
    setCurrent(null)
  }

  async function changeSpeed(next: number): Promise<void> {
    if (next === speedRef.current) return
    setSpeed(next)
    speedRef.current = next
    await loadRange(targetIndexRef.current, next, transposeRef.current)
  }

  async function changeTranspose(next: number): Promise<void> {
    if (next === transposeRef.current) return
    setTranspose(next)
    transposeRef.current = next
    onPatchSettings({ transpose: next })
    await loadRange(targetIndexRef.current, speedRef.current, next)
  }
  function switchTarget(index: number): void {
    if (index === targetIndexRef.current) return
    setTargetIndex(index)
    targetIndexRef.current = index
    void loadRange(index, speedRef.current, transposeRef.current)
  }

  function pauseSession(): void {
    if (phase !== 'active') return
    const player = playerRef.current
    acceptingRef.current = false
    if (player) {
      const position = player.position
      player.pause()
      setNow(position)
    }
    setPhase('paused')
    setCurrent(null)
  }

  async function resumeSession(): Promise<void> {
    const player = playerRef.current
    if (!player || phase !== 'paused') return
    await player.resume()
    const from = player.position
    player.play(from)
    lastPositionRef.current = from
    setNow(from)
    acceptingRef.current = true
    setPhase('active')
  }

  function confirmBack(): void {
    if (
      (phase === 'active' || phase === 'paused' || phase === 'preparing') &&
      historyRef.current.length > 0 &&
      !window.confirm('结束单句循环？循环练习的成绩不会写入报告。')
    ) {
      return
    }
    captureRef.current?.stop()
    captureRef.current = null
    playerRef.current?.dispose()
    playerRef.current = null
    onBack()
  }

  const targetNotes = useMemo(() => {
    if (!currentTarget) return []
    return song.melody.notes
      .filter((note) => note.end >= currentTarget.start && note.start <= currentTarget.end)
      .slice(0, 10)
  }, [song.melody.notes, currentTarget])

  if (targets.length === 0) {
    return (
      <div className="screen practice-screen">
        <TopBar title="单句循环" onBack={onBack} />
        <main className="page practice-error">
          <section className="card empty-card">
            <h1>没有可练习的句子</h1>
            <p>报告里没有可断句的参考音高，先完整跟唱一遍再回来。</p>
          </section>
        </main>
      </div>
    )
  }

  if (phase === 'starting' || phase === 'preparing') {
    return (
      <div className="screen practice-screen">
        <TopBar title="单句循环" subtitle={`${song.name} · ${label}`} onBack={confirmBack} />
        <main className="page practice-ending">
          <div className="spinner large" />
          <h2>{phase === 'preparing' ? statusText : '正在打开麦克风…'}</h2>
          <p className="muted">
            {phase === 'preparing'
              ? '正在把这一句裁出来并按当前速度和调性处理，通常只要几秒。'
              : '第一次使用需要允许麦克风权限；所有声音只在本机处理。'}
          </p>
        </main>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="screen practice-screen">
        <TopBar title="单句循环" subtitle={song.name} onBack={confirmBack} />
        <main className="page practice-error">
          <section className="card empty-card">
            <div className="empty-icon"><HeadphonesIcon /></div>
            <h1>没能开始这一句</h1>
            <p>{error}</p>
            <div className="row-actions">
              <button type="button" className="btn primary" onClick={() => void startSession()}>
                <RefreshIcon />
                重试
              </button>
              <button type="button" className="btn ghost" onClick={confirmBack}>
                返回
              </button>
            </div>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="screen practice-screen loop-screen">
      <TopBar
        title="单句循环"
        subtitle={`${song.name} · ${currentTarget?.label ?? label}`}
        onBack={confirmBack}
        right={
          <div className="topbar-tools">
            <span className="key-hints desktop-only">空格 暂停/继续 · Esc 返回</span>
            <span className="tag">{speed}×</span>
            <span className="tag warn">
              移调 {transpose > 0 ? '+' : ''}
              {transpose}
            </span>
          </div>
        }
      />

      <main className="page practice-page loop-page">
        <div className="practice-stage">
          <section className="loop-toolbar card">
            <div className="loop-toolbar-row">
              <div className="loop-targets">
                <span className="eyebrow">{label}</span>
                {targets.length > 1 ? (
                  <div className="loop-target-chips" role="group" aria-label="选择要练的句子">
                    {targets.map((target, index) => (
                      <button
                        key={`${target.label}-${index}`}
                        type="button"
                        className={index === targetIndex ? 'active' : ''}
                        aria-pressed={index === targetIndex}
                        onClick={() => switchTarget(index)}
                      >
                        {target.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <strong className="loop-target-single">{currentTarget?.label ?? label}</strong>
                )}
              </div>
              <div className="loop-controls">
                <Segmented
                  label="速度"
                  value={speed}
                  options={[
                    { value: 0.5, label: '0.5×' },
                    { value: 0.75, label: '0.75×' },
                    { value: 1, label: '1.0×' },
                  ]}
                  onChange={(value) => void changeSpeed(value)}
                  hint="保持音高，只放慢节奏"
                />
                <div className="loop-key">
                  <span className="field-label">移调</span>
                  <div className="stepper">
                    <button
                      type="button"
                      aria-label="降一个半音"
                      disabled={transpose <= -6}
                      onClick={() => void changeTranspose(transpose - 1)}
                    >
                      −
                    </button>
                    <output>
                      {transpose > 0 ? '+' : ''}
                      {transpose}
                    </output>
                    <button
                      type="button"
                      aria-label="升一个半音"
                      disabled={transpose >= 6}
                      onClick={() => void changeTranspose(transpose + 1)}
                    >
                      +
                    </button>
                  </div>
                  <span className="field-hint">伴奏与参考旋律一起变调，速度不变</span>
                </div>
              </div>
            </div>
            <div className="loop-tags">
              <span>句子 {formatTime(currentTarget?.start ?? 0)} – {formatTime(currentTarget?.end ?? 0)}</span>
              <span>句前预备 {(range?.beat ?? 0.55).toFixed(2)} 秒（1 拍）</span>
              <span>判定 ±{settings.tolerance} 音分</span>
              {targetNotes.length > 0 && (
                <span className="loop-note-tags">
                  {targetNotes.map((note, index) => (
                    <em key={`${note.start}-${index}`}>{midiToNoteName(note.midi + transpose).label}</em>
                  ))}
                </span>
              )}
            </div>
          </section>

          <section className="roll-card card">
            <PitchRoll
              melody={rangeMelody}
              pointsRef={pointsRef}
              duration={Math.max(0.1, duration)}
              transpose={0}
              octaveAlign={settings.octaveAlign}
              tolerance={settings.tolerance}
              mode="practice"
              active={phase === 'active'}
              interactive={false}
              getPlayhead={() => (phase === 'active' ? playerRef.current?.position ?? 0 : now)}
              getCenter={() => (phase === 'active' ? playerRef.current?.position ?? 0 : now)}
              loop={{ start: 0, end: Math.max(0.1, duration) }}
              highlight={{ start: scoreStart, end: scoreEnd }}
              ariaLabel="单句循环的音高卷帘"
              playheadLabel={phase === 'paused' ? '暂停' : preroll ? '预备' : '这一遍'}
            />
            <div className="roll-legend">
              <span><i className="dot good" />准</span>
              <span><i className="dot sharp" />偏高 ↑</span>
              <span><i className="dot flat" />偏低 ↓</span>
              <span className="legend-spacer" />
              <span className="mobile-only">{preroll ? '听预备拍，准备进句' : '绿色高亮是本句计分范围'}</span>
              <span className="desktop-only">句前 1 拍预备 · 计分只看高亮区</span>
            </div>
          </section>

          <div className="practice-transport card loop-transport">
            <button
              type="button"
              className="round-btn pause"
              aria-label={phase === 'paused' ? '继续循环' : '暂停循环'}
              onClick={() => {
                if (phase === 'paused') void resumeSession()
                else pauseSession()
              }}
            >
              {phase === 'paused' ? <PlayIcon /> : <PauseIcon />}
            </button>
            <div className="transport-copy">
              <strong>
                第 {pass} 遍 · {preroll ? '预备' : phase === 'paused' ? '已暂停' : '循环中'}
              </strong>
              <span>
                {preroll
                  ? `还有 ${Math.max(0, scoreStart - now).toFixed(1)} 秒进句`
                  : lastResult?.hitRate != null
                    ? `上一遍命中 ${Math.round(lastResult.hitRate * 100)}% · 第 ${pass} 遍进行中`
                    : `${formatTime(now)} / ${formatTime(duration)} · 每遍只统计高亮区`}
              </span>
            </div>
            <button type="button" className="btn ghost end-btn" onClick={confirmBack}>
              <StopIcon />
              结束
            </button>
          </div>
          {error && <div className="notice warn">{error}</div>}

          <div className="volume-inline">
            <label className="field">
              <span className="field-label slider-label">
                <span>伴奏音量</span>
                <output>{Math.round(settings.volume * 100)}%</output>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(settings.volume * 100)}
                onChange={(event) =>
                  onPatchSettings({ volume: Number(event.target.value) / 100 })
                }
              />
            </label>
          </div>
        </div>

        <aside className="practice-side">
          <section className={`live-readout severity-${tone}`}>
            <div className="live-note-line">
              <span className="live-note">{displayNote?.label ?? '—'}</span>
              <span className="live-freq">
                {current == null ? '—' : `${current.f0.toFixed(1)} Hz`}
              </span>
            </div>
            <div className="live-cents-line">
              <strong className={`live-cents ${tone}`}>
                {current?.cents == null ? '—' : `${formatCents(current.cents)} 音分`}
              </strong>
              {direction !== 0 ? (
                <span className={`live-direction ${tone}`}>
                  {direction === 1 ? '↑ 偏高' : '↓ 偏低'}
                </span>
              ) : (
                <span className={`status-pill ${tone}`}>
                  {current?.cents != null ? '准' : displayNote ? '暂无参考' : '等待声音'}
                </span>
              )}
            </div>
            <div className="live-target">
              目标 <strong>{displayTarget?.label ?? '—'}</strong>
              {current && current.octaveShift !== 0 && (
                <span>
                  {' '}
                  · 你{current.octaveShift > 0 ? '低' : '高'} {Math.abs(current.octaveShift)} 个八度，已对齐
                </span>
              )}
            </div>
            <div className="live-clock">
              {formatTime(now)} <span>/ {formatTime(duration)}</span>
              <em>第 {pass} 遍</em>
            </div>
          </section>

          <section className="card loop-score-card" aria-live="polite">
            <div className="loop-score-head">
              <div>
                <span className="eyebrow">每一遍</span>
                <h2>上一遍命中率</h2>
              </div>
              <strong className={`loop-big-rate ${lastResult?.hitRate == null ? 'none' : lastResult.hitRate >= 0.75 ? 'good' : lastResult.hitRate >= 0.5 ? 'warn' : 'bad'}`}>
                {lastResult?.hitRate == null ? '—' : `${Math.round(lastResult.hitRate * 100)}%`}
              </strong>
            </div>
            {lastResult == null ? (
              <p className="muted">唱完这一遍，这里会显示只属于本句的命中率。</p>
            ) : lastResult.hitRate == null ? (
              <p className="muted">这一遍有效歌声太少（{lastResult.samples} 个采样），先跟着预备拍开口。</p>
            ) : (
              <p className="muted">
                第 {lastResult.pass} 遍 · {lastResult.samples} 个有效采样
                {lastResult.avgCents != null && ` · 平均偏差 ${formatCents(lastResult.avgCents)} 音分`}
              </p>
            )}
            <PassHistory results={history} />
            <p className="tiny-note">
              循环练习的分数只用来对比每一遍，不写入练习记录；结束后可回到报告继续完整回看。
            </p>
          </section>

          <section className="loop-side-tips">
            <HeadphonesIcon />
            <div>
              <strong>戴耳机，跟住预备拍</strong>
              <span>
                每遍会先播放 1 拍伴奏再进入本句；你可以在句前换气，但不要抢拍。
                速度变慢时音高保持不变。
              </span>
            </div>
          </section>
        </aside>
      </main>
    </div>
  )
}
