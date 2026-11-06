import { useEffect, useMemo, useRef, useState } from 'react'
import { evaluateSession, buildPhrases } from '../audio/analysis'
import { ClipPlayer } from '../audio/clipPlayer'
import type { ReplayMode } from '../audio/clipPlayer'
import { formatCents, formatTime, midiToNoteName } from '../audio/pitch'
import { readingAt, recordMelody, voiceOffsetAt } from '../audio/review'
import type { ReadingAt } from '../audio/review'
import { loadDemoSong } from '../state/demo'
import type { PracticeRecord } from '../state/records'
import { Notice, TopBar } from '../ui/controls'
import { PauseIcon, PlayIcon, RefreshIcon, StopIcon } from '../ui/icons'
import { PitchRoll } from '../ui/PitchRoll'
import { useIsDesktop } from '../ui/useMediaQuery'

interface ReviewViewProps {
  record: PracticeRecord
  /** 当前会话里还留着的原曲；从记录列表进来时通常为空 */
  original: AudioBuffer | null
  startAt: number
  onBack: () => void
}

const REPLAY_MODES: { value: ReplayMode; label: string }[] = [
  { value: 'voice', label: '我的声音' },
  { value: 'original', label: '原唱' },
  { value: 'mix', label: '叠加' },
]

function dateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function scoreTone(score: number | null): string {
  if (score == null) return 'none'
  if (score >= 80) return 'good'
  if (score >= 60) return 'warn'
  return 'low'
}

export function ReviewView({ record, original, startAt, onBack }: ReviewViewProps) {
  const isDesktop = useIsDesktop()
  const pointsRef = useRef(
    record.points.slice().sort((a, b) => a.t - b.t),
  )
  const melody = useMemo(() => recordMelody(record), [record])
  const report = useMemo(
    () =>
      evaluateSession(pointsRef.current, melody, {
        transpose: record.transpose,
        octaveAlign: record.octaveAlign,
        tolerance: record.tolerance,
      }),
    [melody, record],
  )
  const phrases = useMemo(
    () => buildPhrases(melody.notes).slice().sort((a, b) => a.start - b.start),
    [melody],
  )
  const hitPercent = report.hitRate == null ? null : Math.round(report.hitRate * 100)

  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(original)
  const [originalLoading, setOriginalLoading] = useState(false)
  const [originalError, setOriginalError] = useState<string | null>(null)
  const [voiceReady, setVoiceReady] = useState(false)
  const [voiceError, setVoiceError] = useState(false)
  const [mode, setMode] = useState<ReplayMode>('voice')
  const [playing, setPlaying] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)
  const [selected, setSelected] = useState<ReadingAt | null>(null)

  const centerRef = useRef(Math.max(0, startAt))
  const cursorRef = useRef<number | null>(Math.max(0, startAt))
  const clipRef = useRef<ClipPlayer | null>(null)
  const voiceBufferRef = useRef<AudioBuffer | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    setOriginalBuffer(original)
  }, [original])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clipRef.current?.dispose()
      clipRef.current = null
    }
  }, [])

  useEffect(() => {
    // 从记录列表进入示例歌时，现场重新合成原唱
    if (originalBuffer || record.songKind !== 'demo') return
    let active = true
    setOriginalLoading(true)
    loadDemoSong(record.songId)
      .then((song) => {
        if (!active) return
        setOriginalBuffer(song.buffer)
        setOriginalError(null)
      })
      .catch((err: unknown) => {
        if (!active) return
        setOriginalError(err instanceof Error ? err.message : '原唱加载失败，只能回看音高曲线。')
      })
      .finally(() => {
        if (active) setOriginalLoading(false)
      })
    return () => {
      active = false
    }
  }, [originalBuffer, record.songId, record.songKind])

  useEffect(() => {
    if (!record.voice) return
    let active = true
    const ctx = new AudioContext({ latencyHint: 'playback' })
    record.voice
      .arrayBuffer()
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        if (!active) return
        voiceBufferRef.current = buffer
        setVoiceReady(true)
      })
      .catch((err: unknown) => {
        console.warn('[voice-pro] 回看录音解码失败', err)
        if (active) setVoiceError(true)
      })
      .finally(() => {
        void ctx.close().catch(() => undefined)
      })
    return () => {
      active = false
      void ctx.close().catch(() => undefined)
    }
  }, [record])

  useEffect(() => {
    const duration = melody.duration || record.duration
    const initial = Math.max(0, Math.min(startAt, duration))
    cursorRef.current = initial
    // 桌面卷帘窗口更宽，起点在 0 时把视野右移，避免左半屏空着
    centerRef.current = isDesktop ? Math.min(duration, Math.max(7, initial)) : initial
    setCursor(initial)
    setSelected(
      readingAt(pointsRef.current, initial, melody, {
        transpose: record.transpose,
        octaveAlign: record.octaveAlign,
        tolerance: record.tolerance,
      }),
    )
    // 只在打开记录时定位一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      const position = clipRef.current?.position
      if (position == null) return
      cursorRef.current = position
      centerRef.current = position
      setCursor(position)
      setSelected(
        readingAt(pointsRef.current, position, melody, {
          transpose: record.transpose,
          octaveAlign: record.octaveAlign,
          tolerance: record.tolerance,
        }),
      )
      if (clipRef.current && !clipRef.current.playing) setPlaying(false)
    }, 80)
    return () => window.clearInterval(timer)
  }, [playing, melody, record])

  function stopPlayback(): void {
    clipRef.current?.stop()
    setPlaying(false)
  }

  async function togglePlayback(): Promise<void> {
    if (playing) {
      stopPlayback()
      return
    }
    const from = cursorRef.current ?? Math.max(0, startAt)
    if (!clipRef.current) clipRef.current = new ClipPlayer()
    const clip = clipRef.current
    clip.onEnded = () => {
      if (mountedRef.current) setPlaying(false)
    }
    const effectiveMode =
      !originalBuffer && (mode === 'original' || mode === 'mix') ? 'voice' : mode
    const voiceOffset = record.segments.length > 0
      ? voiceOffsetAt(record.segments, from)
      : from
    await clip.play({
      original: originalBuffer,
      voice: voiceBufferRef.current,
      songTime: from,
      voiceOffset,
      mode: effectiveMode,
      volume: 0.92,
    })
    if (mountedRef.current) setPlaying(clip.playing)
  }

  function pickTime(time: number): void {
    stopPlayback()
    const duration = originalBuffer?.duration ?? melody.duration ?? record.duration
    const next = Math.max(0, Math.min(duration, time))
    cursorRef.current = next
    centerRef.current = next
    setCursor(next)
    setSelected(
      readingAt(pointsRef.current, next, melody, {
        transpose: record.transpose,
        octaveAlign: record.octaveAlign,
        tolerance: record.tolerance,
      }),
    )
  }

  function panTime(delta: number): void {
    if (playing) stopPlayback()
    const duration = originalBuffer?.duration ?? melody.duration ?? record.duration
    centerRef.current = Math.max(0, Math.min(duration, centerRef.current + delta))
  }

  function jumpTo(time: number): void {
    pickTime(time + 0.02)
  }

  const selectedNote = selected ? midiToNoteName(selected.point.midi) : null
  const selectedTarget = selected?.targetMidi != null
    ? midiToNoteName(selected.targetMidi)
    : null
  const selectedCents = selected?.comparison?.cents ?? null
  const selectedSeverity =
    selectedCents == null
      ? 'neutral'
      : Math.abs(selectedCents) <= record.tolerance
        ? 'good'
        : selectedCents > 0
          ? 'sharp'
          : 'flat'
  const selectedDirection =
    selectedCents == null || Math.abs(selectedCents) <= record.tolerance
      ? 0
      : selectedCents > 0
        ? 1
        : -1

  const highlight = phrases.find(
    (phrase) =>
      cursor != null && cursor >= phrase.start - 0.05 && cursor <= phrase.end + 0.05,
  )

  const phraseStats = new Map(report.phrases.map((phrase) => [phrase.index, phrase]))
  const canPlay = mode === 'original'
    ? originalBuffer != null
    : mode === 'mix'
      ? voiceReady || originalBuffer != null
      : voiceReady

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (document.querySelector('.settings-sheet')) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        if (target?.closest('button')) return
        event.preventDefault()
        void togglePlayback()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const delta = (event.shiftKey ? 5 : 1) * (event.key === 'ArrowLeft' ? -1 : 1)
        const duration = originalBuffer?.duration ?? melody.duration ?? record.duration
        const base = cursorRef.current ?? startAt
        const next = Math.max(0, Math.min(duration, base + delta))
        centerRef.current = next
        pickTime(next)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        stopPlayback()
        onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 快捷键依赖当前回放状态与来源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, mode, voiceReady, originalBuffer, startAt])

  return (
    <div className="screen review-screen">
      <TopBar
        title="回看"
        subtitle={`${record.songName} · ${dateLabel(record.createdAt)}`}
        onBack={() => {
          stopPlayback()
          onBack()
        }}
        right={<span className={`score-chip ${scoreTone(record.score)}`}>{record.score ?? '—'} 分</span>}
      />

      <main className="page review-page">
        <section className="review-hero">
          <div>
            <p className="eyebrow">{record.songKind === 'demo' ? '示例歌' : '导入歌'} · {record.loop ? '循环练习' : '完整练习'}</p>
            <h1>{record.songName}</h1>
            <p className="muted">
              {dateLabel(record.createdAt)} · 命中率 {hitPercent == null ? '—' : `${hitPercent}%`} · ±{record.tolerance} 音分
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="回到开头" onClick={() => jumpTo(0)}>
            <RefreshIcon />
          </button>
        </section>

        {selected ? (
          <section className={`review-readout card severity-${selectedSeverity}`}>
            <div className="review-readout-main">
              <span className="review-note">{selectedNote?.label ?? '—'}</span>
              <span className={`review-cents ${selectedSeverity}`}>
                {selectedCents == null ? '暂无参考' : `${formatCents(selectedCents)} 音分`}
                {selectedDirection !== 0 && (selectedDirection === 1 ? ' ↑ 偏高' : ' ↓ 偏低')}
              </span>
            </div>
            <div className="review-readout-meta">
              <span>时刻 {formatTime(selected.time)}</span>
              <span>目标 {selectedTarget?.label ?? '—'}</span>
              <span>{selected.point.f0.toFixed(1)} Hz</span>
            </div>
          </section>
        ) : (
          <section className="review-readout card empty">
            <strong>{cursor == null ? '点曲线选择时刻' : `${formatTime(cursor)} 附近没有检测到人声`}</strong>
            <span>拖动查看历史，点按落下游标；也可以直接播放这一段的录音。</span>
          </section>
        )}

        <section className="roll-card card">
          <PitchRoll
            melody={melody}
            pointsRef={pointsRef}
            duration={originalBuffer?.duration ?? melody.duration ?? record.duration}
            transpose={record.transpose}
            octaveAlign={record.octaveAlign}
            tolerance={record.tolerance}
            mode="practice"
            interactive
            active={false}
            getPlayhead={() => cursorRef.current ?? startAt}
            getCenter={() => centerRef.current}
            getCursor={() => cursorRef.current}
            highlight={highlight ? { start: highlight.start, end: highlight.end } : null}
            onPan={panTime}
            onPick={pickTime}
            ariaLabel="回看音高卷帘"
            playheadLabel={playing ? '播放' : '回看'}
          />
          <div className="roll-legend">
            <span><i className="dot good" />准</span>
            <span><i className="dot sharp" />偏高 ↑</span>
            <span><i className="dot flat" />偏低 ↓</span>
            <span className="legend-spacer" />
            <span>拖动查看 · 点按定位</span>
          </div>
        </section>

        <section className="review-player card">
          <div className="replay-head">
            <span>回放</span>
            <span className="tiny-note">
              {originalLoading
                ? '正在准备原唱…'
                : originalBuffer
                  ? '原唱已就绪'
                  : '原唱不可用，仅能回放录音'}
            </span>
          </div>
          <div className="segmented compact" role="group" aria-label="回放内容">
            {REPLAY_MODES.map((item) => {
              const disabled =
                !voiceReady && item.value !== 'original'
                  ? true
                  : !originalBuffer && item.value !== 'voice'
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={mode === item.value}
                  disabled={disabled}
                  className={mode === item.value ? 'active' : ''}
                  onClick={() => {
                    stopPlayback()
                    setMode(item.value)
                  }}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
          <div className="review-player-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!canPlay}
              onClick={() => void togglePlayback()}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
              {playing ? '暂停回放' : '从游标播放'}
            </button>
            <button type="button" className="btn ghost" onClick={stopPlayback} disabled={!playing}>
              <StopIcon />
              停止
            </button>
            <span className="review-clock">{cursor == null ? '0:00' : formatTime(cursor)}</span>
            <span className="key-hints desktop-only">空格 播放/暂停 · ← → 移动游标 · Esc 返回</span>
          </div>
          {!voiceReady && record.voice && !voiceError && (
            <p className="tiny-note">正在解码录音…</p>
          )}
          {voiceError && <p className="tiny-note">录音解码失败，暂时只能回看音高轨迹。</p>}
          {originalError && <Notice tone="warn">{originalError}</Notice>}
          {!record.voice && <p className="tiny-note">这次练习没有保存到录音。</p>}
        </section>

        <section className="section-block">
          <div className="section-head">
            <div>
              <h2>逐句定位</h2>
              <p>点一句，画面与播放位置一起跳过去</p>
            </div>
          </div>
          {phrases.length === 0 ? (
            <p className="muted">这首歌没有可断句的参考音符。</p>
          ) : (
            <div className="phrase-strip">
              {phrases.map((phrase) => {
                const stat = phraseStats.get(phrase.index)
                const rate = stat?.hitRate == null ? null : Math.round(stat.hitRate * 100)
                return (
                  <button
                    key={`${phrase.index}-${phrase.start}`}
                    type="button"
                    className={`phrase-chip ${rate == null ? 'none' : rate >= 75 ? 'good' : rate >= 50 ? 'warn' : 'bad'}`}
                    onClick={() => jumpTo(phrase.start)}
                  >
                    <strong>第 {phrase.index + 1} 句</strong>
                    <span>{formatTime(phrase.start)} · {rate == null ? '无数据' : `${rate}%`}</span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <div className="row-actions review-actions">
          <button type="button" className="btn ghost" onClick={onBack}>
            返回
          </button>
          <button type="button" className="btn secondary" onClick={() => jumpTo(0)}>
            回到开头
          </button>
        </div>
      </main>
    </div>
  )
}
