import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  compareToTarget,
  directionForCents,
  referenceMidiAt,
  severityForCents,
} from '../audio/analysis'
import type { RawUserPoint } from '../audio/analysis'
import {
  mediaErrorMessage,
  PitchCapture,
} from '../audio/capture'
import type { CaptureMode, InputSource } from '../audio/capture'
import { formatCents, formatTime, midiToNoteName } from '../audio/pitch'
import { SongPlayer } from '../audio/player'
import type { LoopRange } from '../audio/player'
import type { LoadedSong, PracticeSession } from '../state/session'
import type { Settings } from '../state/settings'
import { Segmented, Slider, SourcePicker, Stepper, Toggle, TopBar, Notice } from '../ui/controls'
import {
  HeadphonesIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
} from '../ui/icons'
import { PitchRoll } from '../ui/PitchRoll'

interface PracticeViewProps {
  song: LoadedSong
  settings: Settings
  onPatchSettings: (patch: Partial<Settings>) => void
  initialLoop: LoopRange | null
  initialLoopLabel: string | null
  onEnd: (session: PracticeSession) => void
  onHome: () => void
}

interface CurrentReading {
  midi: number
  f0: number
  cents: number | null
  targetMidi: number | null
  octaveShift: number
  t: number
}

type Phase = 'ready' | 'starting' | 'active'

function SettingsDrawer({
  settings,
  onPatchSettings,
  autoLatency,
  effectiveLatency,
  disabled,
}: {
  settings: Settings
  onPatchSettings: (patch: Partial<Settings>) => void
  autoLatency: number | null
  effectiveLatency: number
  disabled?: boolean
}) {
  return (
    <details className="settings-drawer">
      <summary>高级设置</summary>
      <div className="drawer-body">
        <Segmented
          label="偏差容忍度"
          value={settings.tolerance}
          onChange={(value) => onPatchSettings({ tolerance: value })}
          options={[
            { value: 25, label: '±25', sub: '严格' },
            { value: 50, label: '±50', sub: '标准' },
            { value: 75, label: '±75', sub: '宽松' },
          ]}
          disabled={disabled}
        />
        <Toggle
          label="八度自动对齐"
          checked={settings.octaveAlign}
          onChange={(checked) => onPatchSettings({ octaveAlign: checked })}
          hint="男声唱女歌等情况整体低八度时，按最近的八度比较。"
          disabled={disabled}
        />
        <Stepper
          label="参考旋律移调"
          value={settings.transpose}
          min={-6}
          max={6}
          onChange={(value) => onPatchSettings({ transpose: value })}
          format={(value) => `${value > 0 ? '+' : ''}${value} 半音`}
          hint="只平移参考旋律的显示与评分。v0.1 无法实时变调，原曲播放保持原调。"
        />
        {settings.transpose !== 0 && (
          <Notice tone="warn">
            已移调 {settings.transpose > 0 ? '+' : ''}
            {settings.transpose} 半音：参考条块和评分都按新调显示，但原曲不会升/降 key。
            跟着原曲唱时，请把移调调回 0，或把原曲音量调小后按新调清唱。
          </Notice>
        )}
        <Slider
          label="输入延迟补偿"
          value={effectiveLatency}
          min={0}
          max={300}
          step={5}
          onChange={(value) => onPatchSettings({ latencyMs: value })}
          format={(value) => `${value} ms`}
          disabled={disabled}
          hint={
            settings.latencyMs == null
              ? `自动估算值${autoLatency == null ? '' : `：${autoLatency} ms`}；拖动滑块后会保存为手动值。`
              : '手动值。调大它会把曲线整体向左移；如果曲线总比参考条块“提前”，就调大。'
          }
        />
        <div className="field-hint">
          估算来自 AudioContext 的 outputLatency + baseLatency。实际演唱时可根据曲线是否比参考块“提前”再微调。
        </div>
      </div>
    </details>
  )
}

export function PracticeView({
  song,
  settings,
  onPatchSettings,
  initialLoop,
  initialLoopLabel,
  onEnd,
  onHome,
}: PracticeViewProps) {
  const [phase, setPhase] = useState<Phase>('ready')
  const [source, setSource] = useState<InputSource>('mic')
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [inputLost, setInputLost] = useState(false)
  const [current, setCurrent] = useState<CurrentReading | null>(null)
  const [now, setNow] = useState(0)
  const [autoLatency, setAutoLatency] = useState<number | null>(null)
  const [captureMode, setCaptureMode] = useState<CaptureMode>('worklet')
  const [loop, setLoop] = useState<LoopRange | null>(initialLoop)

  const playerRef = useRef<SongPlayer | null>(null)
  const captureRef = useRef<PitchCapture | null>(null)
  const pointsRef = useRef<RawUserPoint[]>([])
  const settingsRef = useRef(settings)
  const loopRef = useRef<LoopRange | null>(initialLoop)
  const latencyRef = useRef(40)
  const finishingRef = useRef(false)
  const mountedRef = useRef(true)
  const lastUiRef = useRef(0)

  useLayoutEffect(() => {
    settingsRef.current = settings
  }, [settings])
  useLayoutEffect(() => {
    loopRef.current = loop
  }, [loop])

  const effectiveLatency = Math.round(settings.latencyMs ?? autoLatency ?? 60)
  useEffect(() => {
    latencyRef.current = settings.latencyMs ?? autoLatency ?? 40
  }, [settings.latencyMs, autoLatency])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      captureRef.current?.stop()
      captureRef.current = null
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (phase !== 'active') return
    const timer = window.setInterval(() => {
      setNow(playerRef.current?.position ?? 0)
    }, 120)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => {
    playerRef.current?.setVolume(settings.volume)
  }, [settings.volume])

  const actualNote = current ? midiToNoteName(current.midi) : null
  const targetNote =
    current?.targetMidi != null ? midiToNoteName(current.targetMidi) : null
  const cents = current?.cents ?? null
  const severity = cents == null ? 'neutral' : severityForCents(cents, settings.tolerance)
  const direction = cents == null ? 0 : directionForCents(cents, settings.tolerance)
  const statusText =
    current == null
      ? '等待声音'
      : cents == null
        ? '暂无参考'
        : Math.abs(cents) <= settings.tolerance
          ? '准'
          : cents > 0
            ? '偏高'
            : '偏低'
  const octaveHint =
    current && current.octaveShift !== 0
      ? `你${current.octaveShift > 0 ? '低' : '高'} ${Math.abs(current.octaveShift)} 个八度，已对齐`
      : null

  function finishSession(): void {
    if (finishingRef.current) return
    finishingRef.current = true
    const points = pointsRef.current.slice()
    captureRef.current?.stop()
    captureRef.current = null
    playerRef.current?.stop()
    playerRef.current?.dispose()
    playerRef.current = null
    onEnd({
      song,
      points,
      loop: loopRef.current,
      loopLabel: initialLoopLabel,
      settings: settingsRef.current,
    })
  }

  async function startSession(): Promise<void> {
    if (phase === 'starting' || phase === 'active') return
    setPhase('starting')
    setError(null)
    setEnded(false)
    setInputLost(false)
    finishingRef.current = false
    pointsRef.current = []
    lastUiRef.current = 0

    let player: SongPlayer | null = null
    let capture: PitchCapture | null = null
    try {
      player = new SongPlayer(song.buffer)
      playerRef.current = player
      player.setVolume(settingsRef.current.volume)
      await player.resume()

      capture = new PitchCapture(player.ctx)
      await capture.start(
        source,
        (frame) => {
          const activePlayer = playerRef.current
          if (!activePlayer || !activePlayer.isPlaying) return
          if (frame.f0 == null || frame.midi == null) {
            if (performance.now() - lastUiRef.current > 260) {
              lastUiRef.current = performance.now()
              setCurrent(null)
            }
            return
          }
          const t = activePlayer.positionAt(frame.t) - latencyRef.current / 1000
          if (!Number.isFinite(t) || t < 0) return
          const point: RawUserPoint = {
            t,
            f0: frame.f0,
            midi: frame.midi,
            clarity: frame.clarity,
          }
          pointsRef.current.push(point)
          if (performance.now() - lastUiRef.current >= 40) {
            lastUiRef.current = performance.now()
            const target = referenceMidiAt(song.melody, t, settingsRef.current.transpose)
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
              t,
            })
          }
        },
        () => {
          if (!mountedRef.current || finishingRef.current) return
          captureRef.current?.stop()
          captureRef.current = null
          playerRef.current?.pause()
          setPlaying(false)
          setInputLost(true)
          setError('音频输入已结束，本次练唱已停止。可以结束本次练习查看报告，再点“再练一次”重试。')
        },
      )

      if (!mountedRef.current) {
        capture.stop()
        player.dispose()
        return
      }

      playerRef.current = player
      captureRef.current = capture
      setCaptureMode(capture.captureMode)
      const estimated = Math.max(0, Math.round(capture.latencyMs))
      setAutoLatency(estimated)
      if (settingsRef.current.latencyMs == null) latencyRef.current = estimated

      player.onEnded = () => {
        if (!mountedRef.current) return
        captureRef.current?.stop()
        captureRef.current = null
        setPlaying(false)
        setEnded(true)
        setCurrent(null)
      }

      const startAt = loopRef.current ? loopRef.current.start : 0
      player.play(startAt, loopRef.current)
      setNow(startAt)
      setPlaying(true)
      setPhase('active')
    } catch (err) {
      capture?.stop()
      player?.dispose()
      playerRef.current = null
      captureRef.current = null
      setPhase('ready')
      setPlaying(false)
      setError(mediaErrorMessage(err, source))
    }
  }

  async function togglePlay(): Promise<void> {
    const player = playerRef.current
    if (!player || ended || inputLost || finishingRef.current) return
    if (player.isPlaying) {
      player.pause()
      setPlaying(false)
      setCurrent(null)
      return
    }
    await player.resume()
    const position =
      player.position >= player.duration - 0.06
        ? (loopRef.current?.start ?? 0)
        : player.position
    player.play(position, loopRef.current)
    setNow(position)
    setPlaying(true)
  }

  function closeLoop(): void {
    setLoop(null)
    loopRef.current = null
    setEnded(false)
    playerRef.current?.setLoop(null)
    setNow(playerRef.current?.position ?? 0)
  }

  const loopLabel = loop ? initialLoopLabel ?? 'A-B 循环' : null

  return (
    <div className="screen practice">
      <TopBar
        title={song.name}
        subtitle="练唱"
        onBack={onHome}
        right={
          song.temporary || settings.transpose !== 0 ? (
            <div className="topbar-tags">
              {song.temporary && <span className="mini-tag">临时旋律</span>}
              {settings.transpose !== 0 && (
                <span className="mini-tag">
                  移调 {settings.transpose > 0 ? '+' : ''}
                  {settings.transpose}
                </span>
              )}
            </div>
          ) : undefined
        }
      />

      {phase !== 'active' ? (
        <main className="practice-ready">
          <section className="song-banner card">
            <div className="song-art">
              <MusicIcon />
            </div>
            <div className="song-banner-copy">
              <div className="eyebrow">准备练唱</div>
              <h2>{song.name}</h2>
              <p>
                {formatTime(song.buffer.duration)} · {song.melody.notes.length} 个参考音符
                {song.temporary ? ' · 临时检测结果' : ''}
              </p>
            </div>
          </section>

          {song.temporary && (
            <Notice tone="warn">
              {song.warning ??
                '参考旋律来自开发用的简易检测，可能会把伴奏或低音误当成旋律，准确度有限。'}
            </Notice>
          )}

          {settings.transpose !== 0 && (
            <Notice tone="warn">
              参考旋律已移调 {settings.transpose > 0 ? '+' : ''}
              {settings.transpose} 半音，条块和评分按新调显示；原曲播放仍保持原调（v0.1
              不做实时变调）。
            </Notice>
          )}

          <section className="card setup-card">
            <SourcePicker value={source} onChange={setSource} disabled={phase !== 'ready'} />
            {source === 'display' && (
              <Notice tone="warn">
                当前会把共享到的声音当作“你的输入”分析（例如其他软件播放的歌），不会分析你的嗓音。
                要练唱请切回麦克风。
              </Notice>
            )}

            <div className="setup-tips">
              <HeadphonesIcon />
              <span>
                建议戴耳机，否则原曲从扬声器出来会被麦克风收进去，音高检测会跟着伴奏跑。
                v0.1 不做伴奏分离，原曲就是伴奏。
              </span>
            </div>

            {loop && (
              <div className="loop-setup">
                <span className="loop-chip">
                  {initialLoopLabel ?? 'A-B 循环'} · {formatTime(loop.start)} –{' '}
                  {formatTime(loop.end)}
                </span>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    setLoop(null)
                    loopRef.current = null
                  }}
                >
                  取消锁定
                </button>
              </div>
            )}

            <button
              type="button"
              className="btn primary xl"
              onClick={() => void startSession()}
              disabled={phase === 'starting'}
            >
              {phase === 'starting'
                ? '正在打开音频输入…'
                : loop
                  ? '开始循环练唱'
                  : '开始练唱'}
            </button>

            {error && <Notice tone="error">{error}</Notice>}

            <SettingsDrawer
              settings={settings}
              onPatchSettings={onPatchSettings}
              autoLatency={autoLatency}
              effectiveLatency={effectiveLatency}
            />
          </section>
        </main>
      ) : (
        <main className="practice-active">
          <div className={`readout card severity-${severity}`}>
            <div className="readout-main">
              <div className="note-name">{actualNote?.label ?? '—'}</div>
              <div className="cents-line">
                <span className="cents-value">
                  {cents == null ? '—' : `${formatCents(cents)} 音分`}
                </span>
                {direction !== 0 && (
                  <span className="direction">{direction === 1 ? '↑ 偏高' : '↓ 偏低'}</span>
                )}
              </div>
            </div>
            <div className="readout-meta">
              <div className={`status-pill ${severity}`}>{statusText}</div>
              <div className="target-line">
                目标 <strong>{targetNote?.label ?? '—'}</strong>
                {settings.transpose !== 0 && (
                  <span className="mini-tag">移调 {settings.transpose > 0 ? '+' : ''}{settings.transpose}</span>
                )}
              </div>
              {octaveHint && <div className="octave-hint">{octaveHint}</div>}
              {current && (
                <div className="freq-hint">{current.f0.toFixed(1)} Hz</div>
              )}
            </div>
          </div>

          {song.temporary && (
            <Notice tone="warn">
              参考旋律为简易临时检测，条块可能包含伴奏误判。报告仅供参考。
            </Notice>
          )}

          <PitchRoll
            melody={song.melody}
            pointsRef={pointsRef}
            getNow={() => playerRef.current?.position ?? 0}
            duration={song.buffer.duration}
            transpose={settings.transpose}
            octaveAlign={settings.octaveAlign}
            tolerance={settings.tolerance}
            loop={loop}
            mode="practice"
            active={phase === 'active'}
          />

          <div className="roll-legend">
            <span><i className="dot good" />准</span>
            <span><i className="dot warn" />略偏</span>
            <span><i className="dot bad" />偏差大</span>
            <span><i className="dot neutral" />无参考</span>
            <span className="legend-spacer" />
            <span>目标居中 · 容忍度 ±{settings.tolerance} 音分</span>
          </div>

          {loopLabel && loop && (
            <div className="loop-chip-row">
              <span className="loop-chip">
                {loopLabel} · {formatTime(loop.start)} – {formatTime(loop.end)}
              </span>
              <button type="button" className="text-btn" onClick={closeLoop}>
                关闭循环
              </button>
            </div>
          )}

          {ended && (
            <Notice tone="success">
              歌曲播放结束。点击“结束并查看报告”看看这次唱得怎么样。
            </Notice>
          )}

          {error && <Notice tone="error">{error}</Notice>}

          <div className="transport card">
            <button
              type="button"
              className="play-btn"
              onClick={() => void togglePlay()}
              disabled={ended || inputLost}
              aria-label={playing ? '暂停原曲' : '继续播放原曲'}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <div className="transport-info">
              <div className="clock">
                {formatTime(now)} <span>/ {formatTime(song.buffer.duration)}</span>
              </div>
              <div className="transport-sub">
                {captureMode === 'worklet' ? '实时检测 · 约 10ms' : '兼容模式 · 更新稍慢'}
                {' · '}
                {source === 'mic' ? '麦克风' : '共享声音'}
              </div>
            </div>
            <button
              type="button"
              className="btn primary end-btn"
              onClick={finishSession}
            >
              结束并查看报告
            </button>
          </div>

          <div className="volume-card card">
            <Slider
              label="原曲音量"
              value={Math.round(settings.volume * 100)}
              min={0}
              max={100}
              step={1}
              onChange={(value) => onPatchSettings({ volume: value / 100 })}
              format={(value) => `${value}%`}
              hint="没有伴奏分离，原曲就是伴奏。建议戴耳机并使用较小的监听音量。"
            />
          </div>

          <SettingsDrawer
            settings={settings}
            onPatchSettings={onPatchSettings}
            autoLatency={autoLatency}
            effectiveLatency={effectiveLatency}
          />
        </main>
      )}
    </div>
  )
}
