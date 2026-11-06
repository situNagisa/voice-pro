import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveLatencyMs } from '../audio/calibration'
import type { InputSource } from '../audio/capture'
import { mediaErrorMessage, PitchCapture } from '../audio/capture'
import { ClipPlayer } from '../audio/clipPlayer'
import type { ReplayMode } from '../audio/clipPlayer'
import { evaluateSession, directionForCents, referenceMidiAt } from '../audio/analysis'
import type { ReadingAt } from '../audio/review'
import { readingAt, voiceOffsetAt } from '../audio/review'
import type { AudioSegment } from '../audio/recorder'
import { VoiceRecorder } from '../audio/recorder'
import type { RawUserPoint } from '../audio/analysis'
import { formatCents, formatTime, midiToNoteName } from '../audio/pitch'
import { SongPlayer } from '../audio/player'
import type { LoopRange, SongTrack } from '../audio/player'
import { processBuffer } from '../audio/transform'
import { useSongLyrics } from '../lyrics'
import type { PracticeRecord } from '../state/records'
import { saveRecord } from '../state/records'
import type { LoadedSong } from '../state/session'
import type { Settings } from '../state/settings'
import { Slider, TopBar } from '../ui/controls'
import {
  HeadphonesIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
} from '../ui/icons'
import { LyricSheet } from '../ui/LyricSheet'
import { LyricStrip } from '../ui/LyricStrip'
import { PitchRoll } from '../ui/PitchRoll'

export interface PracticeResult {
  record: PracticeRecord
  song: LoadedSong
}

interface PracticeViewProps {
  song: LoadedSong
  settings: Settings
  source: InputSource
  initialLoop: LoopRange | null
  loopLabel: string | null
  onPatchSettings: (patch: Partial<Settings>) => void
  onFinish: (result: PracticeResult) => void
  onBack: () => void
}

type Phase = 'starting' | 'active' | 'paused' | 'ending' | 'error'

interface CurrentReading {
  midi: number
  f0: number
  cents: number | null
  targetMidi: number | null
  octaveShift: number
  t: number
}

const REPLAY_LABELS: Record<ReplayMode, string> = {
  voice: '我的声音',
  original: '原曲',
  accompaniment: '伴奏',
  vocals: '原唱人声',
  mix: '叠加',
}

const PLAYBACK_TRACKS: { value: SongTrack; label: string }[] = [
  { value: 'original', label: '原曲' },
  { value: 'accompaniment', label: '伴奏' },
  { value: 'vocals', label: '原唱人声' },
]

function newRecordId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `take-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function PracticeView({
  song,
  settings,
  source,
  initialLoop,
  loopLabel,
  onPatchSettings,
  onFinish,
  onBack,
}: PracticeViewProps) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<CurrentReading | null>(null)
  const [now, setNow] = useState(0)
  const [loop] = useState<LoopRange | null>(initialLoop)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [selected, setSelected] = useState<ReadingAt | null>(null)
  const [voiceReady, setVoiceReady] = useState(false)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [replayMode, setReplayMode] = useState<ReplayMode>('voice')
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [statusText, setStatusText] = useState('正在打开麦克风…')
  const [playbackMode, setPlaybackMode] = useState<SongTrack>(
    song.accompaniment ? 'accompaniment' : 'original',
  )
  const [sessionTranspose, setSessionTranspose] = useState(settings.transpose)
  const [trackBusy, setTrackBusy] = useState<SongTrack | null>(null)
  const [transposeBusy, setTransposeBusy] = useState(false)
  const [replayBusy, setReplayBusy] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const { lyrics, setLyrics } = useSongLyrics(song)

  const playerRef = useRef<SongPlayer | null>(null)
  const captureRef = useRef<PitchCapture | null>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const replayRef = useRef<ClipPlayer | null>(null)
  const voiceBufferRef = useRef<AudioBuffer | null>(null)
  const segmentsRef = useRef<AudioSegment[]>([])
  const pointsRef = useRef<RawUserPoint[]>([])
  const settingsRef = useRef(settings)
  const acceptingRef = useRef(false)
  const pausedAtRef = useRef<number | null>(null)
  const centerRef = useRef(0)
  const cursorRef = useRef<number | null>(null)
  const finishingRef = useRef(false)
  const mountedRef = useRef(true)
  const lastUiRef = useRef(0)
  const currentRef = useRef<CurrentReading | null>(null)
  const latencyRef = useRef(60)
  const playbackModeRef = useRef(playbackMode)
  const sessionTransposeRef = useRef(sessionTranspose)
  const trackBusyRef = useRef<SongTrack | null>(null)

  settingsRef.current = settings
  playbackModeRef.current = playbackMode
  sessionTransposeRef.current = sessionTranspose
  trackBusyRef.current = trackBusy

  const hasAccompaniment = song.accompaniment != null
  const hasVocals = song.vocals != null
  const replayModes = useMemo(() => {
    const modes: { value: ReplayMode; label: string }[] = [
      { value: 'voice', label: REPLAY_LABELS.voice },
    ]
    if (hasAccompaniment) {
      modes.push({ value: 'accompaniment', label: REPLAY_LABELS.accompaniment })
    }
    if (hasVocals) {
      modes.push({ value: 'vocals', label: REPLAY_LABELS.vocals })
    }
    if (!hasAccompaniment) {
      modes.push({ value: 'original', label: REPLAY_LABELS.original })
    }
    modes.push({ value: 'mix', label: REPLAY_LABELS.mix })
    return modes
  }, [hasAccompaniment, hasVocals])

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
      replayRef.current?.dispose()
      replayRef.current = null
      void recorderRef.current?.stop()
      recorderRef.current = null
    }
    // 只在进入页面时启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'active') return
    const timer = window.setInterval(() => {
      setNow(playerRef.current?.position ?? 0)
    }, 100)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => {
    playerRef.current?.setVolume(settings.volume)
  }, [settings.volume])

  function closeOpenSegment(): void {
    const recorder = recorderRef.current
    const segments = segmentsRef.current
    const last = segments[segments.length - 1]
    if (recorder && last && last.duration === 0) {
      last.duration = Math.max(0, recorder.elapsed - last.voiceStart)
    }
  }

  function trackBuffer(track: SongTrack): AudioBuffer | null {
    if (track === 'accompaniment') return song.accompaniment ?? null
    if (track === 'vocals') return song.vocals ?? null
    return song.buffer
  }

  /** 离线回退：把当前音轨处理成目标调后换进播放器；transpose=0 时换回原轨。 */
  async function applyTransposedTrack(
    player: SongPlayer,
    track: SongTrack,
    transpose: number,
  ): Promise<void> {
    const source = trackBuffer(track)
    if (!source) return
    const processed =
      transpose === 0 ? source : await processBuffer(source, { semitones: transpose })
    if (!mountedRef.current || finishingRef.current) return
    player.setTrack(track, processed)
  }

  async function changeSessionTranspose(next: number): Promise<void> {
    const value = Math.max(-6, Math.min(6, Math.round(next)))
    if (value === sessionTransposeRef.current || transposeBusy) return
    sessionTransposeRef.current = value
    setSessionTranspose(value)
    onPatchSettings({ transpose: value })
    const player = playerRef.current
    if (!player) return
    if (player.usesRealtime) {
      player.setTranspose(value)
      return
    }
    setTransposeBusy(true)
    try {
      await applyTransposedTrack(player, playbackModeRef.current, value)
    } catch (err) {
      console.warn('[voice-pro] 音轨变调失败', err)
      if (mountedRef.current) setError('这条音轨变调失败，请重试或换回原调。')
    } finally {
      if (mountedRef.current) setTransposeBusy(false)
    }
  }

  async function startSession(): Promise<void> {
    if (!mountedRef.current || finishingRef.current) return
    setPhase('starting')
    setError(null)
    setStatusText('正在打开麦克风…')
    let player: SongPlayer | null = null
    let capture: PitchCapture | null = null
    try {
      const transpose = settingsRef.current.transpose
      sessionTransposeRef.current = transpose
      setSessionTranspose(transpose)
      player = new SongPlayer(song.buffer, {
        accompaniment: song.accompaniment ?? null,
        vocals: song.vocals ?? null,
      })
      const mode = playbackModeRef.current
      const availableMode =
        (mode === 'accompaniment' && !song.accompaniment) ||
        (mode === 'vocals' && !song.vocals)
          ? 'original'
          : mode
      player.setMode(availableMode)
      playerRef.current = player
      player.setVolume(settingsRef.current.volume)
      player.setTranspose(transpose)
      await player.resume()
      if (!mountedRef.current) {
        player.dispose()
        return
      }

      const realtime = await player.enableRealtime()
      if (!mountedRef.current) {
        player.dispose()
        return
      }
      if (!realtime && transpose !== 0) {
        setStatusText('正在准备变调伴奏…')
        await applyTransposedTrack(player, availableMode, transpose)
        if (!mountedRef.current) {
          player.dispose()
          return
        }
        setStatusText('变调伴奏已就绪')
      }

      setStatusText('正在校准输入…')
      capture = new PitchCapture(player.ctx)
      await capture.start(
        source,
        (frame) => {
          if (!mountedRef.current || !acceptingRef.current) return
          const activePlayer = playerRef.current
          if (!activePlayer?.isPlaying) return
          if (frame.f0 == null || frame.midi == null) {
            if (performance.now() - lastUiRef.current > 260) {
              lastUiRef.current = performance.now()
              currentRef.current = null
              setCurrent(null)
            }
            return
          }
          const latency = latencyRef.current
          const t = activePlayer.positionAt(frame.t) - latency / 1000
          if (!Number.isFinite(t) || t < 0) return
          pointsRef.current.push({
            t,
            f0: frame.f0,
            midi: frame.midi,
            clarity: frame.clarity,
            shift: sessionTransposeRef.current,
          })
          if (performance.now() - lastUiRef.current >= 40) {
            lastUiRef.current = performance.now()
            const target = referenceMidiAt(song.melody, t, sessionTransposeRef.current)
            const comparison =
              target == null
                ? null
                : {
                    cents:
                      (frame.midi +
                        (settingsRef.current.octaveAlign
                          ? Math.round((target - frame.midi) / 12) * 12
                          : 0) -
                        target) *
                      100,
                    octaveShift: settingsRef.current.octaveAlign
                      ? Math.round((target - frame.midi) / 12)
                      : 0,
                  }
            const reading: CurrentReading = {
              midi: frame.midi,
              f0: frame.f0,
              cents: comparison?.cents ?? null,
              targetMidi: target,
              octaveShift: comparison?.octaveShift ?? 0,
              t,
            }
            currentRef.current = reading
            setCurrent(reading)
          }
        },
        () => {
          if (!mountedRef.current || finishingRef.current) return
          acceptingRef.current = false
          captureRef.current?.stop()
          captureRef.current = null
          playerRef.current?.pause()
          const position = playerRef.current?.position ?? 0
          pausedAtRef.current = position
          centerRef.current = position
          setPausedAt(position)
          setPhase('paused')
          setError('音频输入已结束。本次已唱部分仍然可以结束并保存。')
        },
      )
      if (!mountedRef.current) {
        capture.stop()
        player.dispose()
        return
      }
      captureRef.current = capture
      latencyRef.current = await resolveLatencyMs(
        settingsRef.current.latencyMs,
        settingsRef.current.latencyProfiles,
        settingsRef.current.lastOutputKind,
        Math.max(0, Math.round(capture.latencyMs)),
      )

      const stream = capture.mediaStream
      let recorder: VoiceRecorder | null = null
      if (stream) {
        recorder = new VoiceRecorder(stream, player.ctx)
        recorder.start()
        recorderRef.current = recorder
      }

      const startAt = loop ? loop.start : 0
      // 录音先开始、伴奏在 Worklet 预填后才出声，分段要留出这段算法延迟
      segmentsRef.current = [
        {
          songStart: startAt,
          voiceStart: (recorder?.elapsed ?? 0) + player.processingLatency,
          duration: 0,
        },
      ]
      pointsRef.current = []
      currentRef.current = null
      pausedAtRef.current = null
      cursorRef.current = null
      centerRef.current = startAt
      voiceBufferRef.current = null
      setVoiceReady(false)
      setCursor(null)
      setSelected(null)
      acceptingRef.current = true

      player.onEnded = () => {
        if (!mountedRef.current || finishingRef.current) return
        acceptingRef.current = false
        void finishSession(false)
      }

      player.play(startAt, loop)
      setNow(startAt)
      setPhase('active')
      setStatusText('录音与实时检测')
    } catch (err) {
      capture?.stop()
      player?.dispose()
      playerRef.current = null
      captureRef.current = null
      recorderRef.current?.stop()
      recorderRef.current = null
      setPhase('error')
      setError(mediaErrorMessage(err, source))
    }
  }

  function stopReplay(): void {
    replayRef.current?.stop()
    setReplayPlaying(false)
  }

  async function changePlaybackMode(mode: SongTrack): Promise<void> {
    if (trackBusyRef.current != null) return
    const player = playerRef.current
    const transpose = sessionTransposeRef.current
    if (
      player &&
      transpose !== 0 &&
      mode !== playbackModeRef.current &&
      !player.usesRealtime
    ) {
      const source = trackBuffer(mode)
      if (!source) return
      setTrackBusy(mode)
      trackBusyRef.current = mode
      setStatusText('正在准备变调音轨…')
      try {
        await applyTransposedTrack(player, mode, transpose)
      } catch (err) {
        console.warn('[voice-pro] 音轨变调失败', err)
        setError('这条音轨变调失败，请重试或换回原调。')
        setTrackBusy(null)
        trackBusyRef.current = null
        return
      }
      setTrackBusy(null)
      trackBusyRef.current = null
      if (!mountedRef.current || finishingRef.current) return
      if (phase === 'active') setStatusText('录音与实时检测')
    }
    setPlaybackMode(mode)
    playbackModeRef.current = mode
    playerRef.current?.setMode(mode)
  }

  function modePlayable(mode: ReplayMode): boolean {
    if (mode === 'voice' || mode === 'mix') return voiceReady
    if (mode === 'accompaniment') return hasAccompaniment
    if (mode === 'vocals') return hasVocals
    return true
  }

  async function pauseSession(): Promise<void> {
    const player = playerRef.current
    if (!player || finishingRef.current) return
    stopReplay()
    const position = player.position
    player.pause()
    acceptingRef.current = false
    closeOpenSegment()
    recorderRef.current?.pause()
    pausedAtRef.current = position
    centerRef.current = position
    cursorRef.current = null
    setPausedAt(position)
    setCursor(null)
    setSelected(null)
    setNow(position)
    setPhase('paused')
    setSnapshotLoading(true)
    try {
      const wav = recorderRef.current?.snapshotWav()
      if (wav) {
        const buffer = await player.ctx.decodeAudioData(await wav.arrayBuffer())
        if (!mountedRef.current) return
        voiceBufferRef.current = buffer
        setVoiceReady(true)
      } else {
        voiceBufferRef.current = null
        setVoiceReady(false)
      }
    } catch (err) {
      console.warn('[voice-pro] 暂停回放音频准备失败', err)
      voiceBufferRef.current = null
      setVoiceReady(false)
    } finally {
      setSnapshotLoading(false)
    }
  }

  function openLyricsEditor(): void {
    if (phase === 'active') {
      void pauseSession().then(() => {
        if (mountedRef.current) setLyricsOpen(true)
      })
      return
    }
    setLyricsOpen(true)
  }

  async function resumeSession(): Promise<void> {
    const player = playerRef.current
    const recorder = recorderRef.current
    if (!player || !recorder || finishingRef.current) return
    stopReplay()
    const from = pausedAtRef.current ?? player.position
    recorder.resume()
    const last = segmentsRef.current[segmentsRef.current.length - 1]
    segmentsRef.current = [
      ...segmentsRef.current.filter((segment) => segment !== last || segment.duration > 0),
      {
        songStart: from,
        voiceStart: recorder.elapsed + player.processingLatency,
        duration: 0,
      },
    ]
    cursorRef.current = null
    setCursor(null)
    setSelected(null)
    pausedAtRef.current = null
    setPausedAt(null)
    player.play(from, loop)
    setNow(from)
    acceptingRef.current = true
    setPhase('active')
  }

  async function playReplay(): Promise<void> {
    const player = playerRef.current
    if (!player || replayBusy) return
    if (replayPlaying) {
      stopReplay()
      return
    }
    let from = cursorRef.current ?? pausedAtRef.current ?? 0
    // 刚暂停时游标就在录音末尾，直接播放会没有声音；回退 3 秒让用户听到刚唱的内容
    if (
      cursorRef.current == null &&
      (replayMode === 'voice' || replayMode === 'mix') &&
      voiceBufferRef.current
    ) {
      const offset = voiceOffsetAt(segmentsRef.current, from)
      if (offset != null && voiceBufferRef.current.duration - offset < 0.6) {
        from = Math.max(0, from - 3)
      }
      cursorRef.current = from
      setCursor(from)
      setSelected(
        readingAt(pointsRef.current, from, song.melody, {
          transpose: sessionTransposeRef.current,
          octaveAlign: settingsRef.current.octaveAlign,
          tolerance: settingsRef.current.tolerance,
        }),
      )
    }
    if (!replayRef.current) {
      replayRef.current = new ClipPlayer(player.ctx)
    }
    const clip = replayRef.current
    clip.onEnded = () => {
      if (mountedRef.current) setReplayPlaying(false)
    }

    setReplayBusy(true)
    try {
      await clip.play({
        original: song.buffer,
        accompaniment: song.accompaniment ?? null,
        vocals: song.vocals ?? null,
        voice: voiceBufferRef.current,
        songTime: from,
        voiceOffset: voiceOffsetAt(segmentsRef.current, from),
        mode: replayMode,
        volume: replayMode === 'original' ? settingsRef.current.volume : 0.92,
        semitones: sessionTransposeRef.current,
      })
      if (mountedRef.current) setReplayPlaying(clip.playing)
    } catch (err) {
      console.warn('[voice-pro] 回放失败', err)
      if (mountedRef.current) setError('回放失败，请重试。')
    } finally {
      if (mountedRef.current) setReplayBusy(false)
    }
  }

  function pickTime(time: number): void {
    if (replayPlaying) stopReplay()
    const duration = song.buffer.duration
    const next = Math.max(0, Math.min(duration, time))
    cursorRef.current = next
    setCursor(next)
    setSelected(
      readingAt(pointsRef.current, next, song.melody, {
        transpose: sessionTransposeRef.current,
        octaveAlign: settingsRef.current.octaveAlign,
        tolerance: settingsRef.current.tolerance,
      }),
    )
  }

  function panTime(delta: number): void {
    const duration = song.buffer.duration
    centerRef.current = Math.max(0, Math.min(duration, centerRef.current + delta))
  }

  function scrubTo(time: number): void {
    const duration = song.buffer.duration
    const next = Math.max(0, Math.min(duration, time))
    if (phase === 'active') {
      playerRef.current?.seek(next)
      centerRef.current = next
      setNow(next)
    } else if (phase === 'paused') {
      centerRef.current = next
      pickTime(next)
    }
  }

  async function finishSession(auto: boolean): Promise<void> {
    if (finishingRef.current) return
    finishingRef.current = true
    acceptingRef.current = false
    stopReplay()
    const player = playerRef.current
    const recorder = recorderRef.current
    player?.pause()
    closeOpenSegment()
    const voicePromise = recorder ? recorder.stop() : Promise.resolve(null)
    captureRef.current?.stop()
    captureRef.current = null
    setPhase('ending')
    setStatusText(auto ? '歌曲结束，正在生成报告…' : '正在保存本次练习…')

    let voiceBlob: Blob | null = null
    try {
      voiceBlob = await voicePromise
    } catch (err) {
      console.warn('[voice-pro] 录音收尾失败', err)
    }
    recorderRef.current = null

    const points = pointsRef.current.slice()
    const report = evaluateSession(points, song.melody, {
      transpose: sessionTransposeRef.current,
      octaveAlign: settingsRef.current.octaveAlign,
      tolerance: settingsRef.current.tolerance,
    })
    const finalSegments = segmentsRef.current
      .map((segment) => ({ ...segment }))
      .filter((segment) => segment.duration > 0)
    // 报告与记录列表统一按实际唱过的秒数展示，而不是整首歌的长度
    const recordedSeconds = finalSegments.reduce(
      (total, segment) => total + (Number.isFinite(segment.duration) ? Math.max(0, segment.duration) : 0),
      0,
    )
    const practicedSeconds =
      recordedSeconds > 0
        ? Math.min(song.buffer.duration || recordedSeconds, recordedSeconds)
        : undefined
    const record: PracticeRecord = {
      id: newRecordId(),
      createdAt: Date.now(),
      songId: song.demoId ?? song.id,
      songName: song.name,
      songKind: song.demoId ? 'demo' : 'imported',
      duration: song.buffer.duration,
      practicedSeconds,
      score: report.score,
      hitRate: report.hitRate,
      tolerance: settingsRef.current.tolerance,
      transpose: sessionTransposeRef.current,
      octaveAlign: settingsRef.current.octaveAlign,
      points,
      melodyNotes: song.melody.notes,
      melodyDuration: song.melody.duration,
      voice: voiceBlob,
      voiceMime: voiceBlob?.type ?? null,
      segments: finalSegments,
      loop,
    }

    try {
      await saveRecord(record)
    } catch (err) {
      console.warn('[voice-pro] 练习记录保存失败', err)
    }

    if (!mountedRef.current) return
    playerRef.current?.dispose()
    playerRef.current = null
    replayRef.current?.dispose()
    replayRef.current = null
    onFinish({ record, song })
  }

  function confirmBack(): void {
    if (phase === 'active' || phase === 'paused') {
      if (!window.confirm('结束本次练习并返回？已唱内容还没有保存。')) return
    }
    captureRef.current?.stop()
    playerRef.current?.dispose()
    replayRef.current?.dispose()
    void recorderRef.current?.stop()
    onBack()
  }

  const effectiveSettings = settings
  const volumeLabel =
    playbackMode === 'accompaniment'
      ? '伴奏音量'
      : playbackMode === 'vocals'
        ? '人声音量'
        : '原曲音量'
  const cents = current?.cents ?? null
  const tone =
    cents == null
      ? 'neutral'
      : Math.abs(cents) <= effectiveSettings.tolerance
        ? 'good'
        : cents > 0
          ? 'sharp'
          : 'flat'
  const direction = cents == null ? 0 : directionForCents(cents, effectiveSettings.tolerance)
  const actualNote = current ? midiToNoteName(current.midi) : null
  const targetNote = current?.targetMidi != null ? midiToNoteName(current.targetMidi) : null
  const octaveHint =
    current && current.octaveShift !== 0
      ? `你${current.octaveShift > 0 ? '低' : '高'} ${Math.abs(current.octaveShift)} 个八度，已对齐`
      : null

  const selectedNote = selected ? midiToNoteName(selected.point.midi) : null
  const selectedTarget = selected?.targetMidi != null ? midiToNoteName(selected.targetMidi) : null
  const selectedCents = selected?.comparison?.cents ?? null
  const selectedSeverity =
    selectedCents == null
      ? 'neutral'
      : Math.abs(selectedCents) <= effectiveSettings.tolerance
        ? 'good'
        : selectedCents > 0
          ? 'sharp'
          : 'flat'
  const selectedDirection =
    selectedCents == null ? 0 : directionForCents(selectedCents, effectiveSettings.tolerance)
  const showPaused = phase === 'paused' || phase === 'ending'

  const pausedSelection = phase === 'paused' && selected != null
  const displayNote = pausedSelection ? selectedNote : actualNote
  const displayTarget = pausedSelection ? selectedTarget : targetNote
  const displayCents = pausedSelection ? selectedCents : cents
  const displayTone = pausedSelection ? selectedSeverity : tone
  const displayDirection = pausedSelection ? selectedDirection : direction
  const displayF0 = pausedSelection ? selected?.point.f0 ?? null : current?.f0 ?? null
  const displayOctaveHint = pausedSelection ? null : octaveHint

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (document.querySelector('.settings-sheet, .lyrics-layer')) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        // 焦点在按钮上时交给按钮自己处理空格
        if (target?.closest('button')) return
        if (phase === 'active') {
          event.preventDefault()
          void pauseSession()
        } else if (phase === 'paused') {
          event.preventDefault()
          void resumeSession()
        }
      } else if (event.key === 'Escape') {
        if (phase === 'ending') return
        event.preventDefault()
        confirmBack()
      } else if (phase === 'paused' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        const delta = (event.shiftKey ? 5 : 1) * (event.key === 'ArrowLeft' ? -1 : 1)
        const base = cursorRef.current ?? pausedAtRef.current ?? 0
        const next = Math.max(0, Math.min(song.buffer.duration, base + delta))
        centerRef.current = next
        pickTime(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 快捷键只依赖当前阶段；处理函数内部使用 ref 读取最新位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  return (
    <div className="screen practice-screen">
      <TopBar
        title={song.name}
        subtitle={showPaused ? '已暂停 · 可回看' : '实时练唱'}
        onBack={confirmBack}
        right={
          <div className="topbar-tools">
            <span className="key-hints desktop-only">空格 暂停/继续 · Esc 返回</span>
            {sessionTranspose !== 0 && (
              <span className="tag warn">
                移调 {sessionTranspose > 0 ? '+' : ''}
                {sessionTranspose}
              </span>
            )}
            <span className="tag">±{effectiveSettings.tolerance}</span>
          </div>
        }
      />

      {phase === 'error' ? (
        <main className="page practice-error">
          <section className="card empty-card">
            <div className="empty-icon"><HeadphonesIcon /></div>
            <h1>没能打开音频输入</h1>
            <p>{error}</p>
            <div className="row-actions">
              <button type="button" className="btn primary" onClick={() => void startSession()}>
                <RefreshIcon />
                重试
              </button>
              <button type="button" className="btn ghost" onClick={onBack}>
                返回
              </button>
            </div>
          </section>
        </main>
      ) : phase === 'starting' ? (
        <main className="page practice-ending">
          <div className="spinner large" />
          <h2>{statusText}</h2>
          <p className="muted">正在准备麦克风与伴奏…</p>
        </main>
      ) : phase === 'ending' ? (
        <main className="page practice-ending">
          <div className="spinner large" />
          <h2>{statusText}</h2>
          <p className="muted">正在把音高轨迹、录音与得分存到本机。</p>
        </main>
      ) : (
        <main className={`page practice-page ${phase === 'paused' ? 'is-paused' : ''}`}>
          <div className="practice-stage">
            <section className="roll-card card">
              <div className="roll-toolbar">
                <span className="roll-toolbar-label">跟唱音轨</span>
                <div className="segmented compact roll-track-switch" role="group" aria-label="跟唱音轨">
                  {PLAYBACK_TRACKS.map((track) => {
                    const available =
                      track.value === 'original' ||
                      (track.value === 'accompaniment' ? hasAccompaniment : hasVocals)
                    return (
                      <button
                        key={track.value}
                        type="button"
                        aria-pressed={playbackMode === track.value}
                        className={playbackMode === track.value ? 'active' : ''}
                        disabled={!available || trackBusy != null}
                        onClick={() => void changePlaybackMode(track.value)}
                      >
                        {trackBusy === track.value ? '准备…' : track.label}
                      </button>
                    )
                  })}
                </div>
                <div className="practice-key" role="group" aria-label="实时移调">
                  <span className="field-label">移调</span>
                  <div className="stepper">
                    <button
                      type="button"
                      aria-label="降一个半音"
                      disabled={sessionTranspose <= -6 || transposeBusy}
                      onClick={() => void changeSessionTranspose(sessionTranspose - 1)}
                    >
                      −
                    </button>
                    <output>
                      {transposeBusy ? '…' : `${sessionTranspose > 0 ? '+' : ''}${sessionTranspose}`}
                    </output>
                    <button
                      type="button"
                      aria-label="升一个半音"
                      disabled={sessionTranspose >= 6 || transposeBusy}
                      onClick={() => void changeSessionTranspose(sessionTranspose + 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
                {trackBusy != null ? (
                  <span className="roll-track-note">正在准备变调音轨…</span>
                ) : transposeBusy ? (
                  <span className="roll-track-note">正在准备新调…</span>
                ) : !hasAccompaniment ? (
                  <span className="roll-track-note">这首歌没有人声分离结果</span>
                ) : null}
              </div>
              <PitchRoll
                melody={song.melody}
                pointsRef={pointsRef}
                duration={song.buffer.duration}
                transpose={sessionTranspose}
                octaveAlign={effectiveSettings.octaveAlign}
                tolerance={effectiveSettings.tolerance}
                mode="practice"
                active={phase === 'active'}
                interactive={phase === 'paused'}
                getPlayhead={() => pausedAtRef.current ?? playerRef.current?.position ?? 0}
                getCenter={() => (pausedAtRef.current != null ? centerRef.current : playerRef.current?.position ?? 0)}
                getCursor={() => cursorRef.current}
                loop={loop}
                onPan={panTime}
                onPick={pickTime}
                ariaLabel="练唱音高卷帘：白色圆点为点选位置"
                playheadLabel={phase === 'paused' ? '暂停' : '现在'}
              />
              <LyricStrip
                lyrics={lyrics}
                time={phase === 'paused' ? cursor ?? pausedAt ?? now : now}
                label="歌词"
                onImport={song.demoId ? undefined : openLyricsEditor}
                onSeek={phase === 'paused' ? pickTime : undefined}
              />
              <div className="roll-legend">
                <span><i className="dot good" />准</span>
                <span><i className="dot sharp" />偏高 ↑</span>
                <span><i className="dot flat" />偏低 ↓</span>
                <span className="legend-spacer" />
                <span className="desktop-only">横轴时间 · 纵轴音高</span>
                <span className="mobile-only">{phase === 'active' ? '实时跟随' : '拖动查看 · 点按定位'}</span>
              </div>
            </section>
            {phase === 'active' && (
              <>
                {error && <div className="notice warn">{error}</div>}
                <div className="practice-transport card">
                  <button
                    type="button"
                    className="round-btn pause"
                    aria-label="暂停并回看"
                    onClick={() => void pauseSession()}
                  >
                    <PauseIcon />
                  </button>
                  <div className="transport-copy">
                    <strong>正在跟唱</strong>
                    <span>{statusText} · 暂停可回看</span>
                  </div>
                  <button type="button" className="btn ghost end-btn" onClick={() => void finishSession(false)}>
                    结束
                  </button>
                </div>
                <div className="volume-inline">
                  <Slider
                    label={volumeLabel}
                    value={Math.round(settings.volume * 100)}
                    min={0}
                    max={100}
                    onChange={(value) => onPatchSettings({ volume: value / 100 })}
                    format={(value) => `${value}%`}
                  />
                </div>
              </>
            )}
          </div>

          <aside className="practice-side">
            <section className={`live-readout severity-${displayTone}`}>
              <div className="live-note-line">
                <span className="live-note">{displayNote?.label ?? '—'}</span>
                <span className="live-freq">{displayF0 == null ? '—' : `${displayF0.toFixed(1)} Hz`}</span>
              </div>
              <div className="live-cents-line">
                <strong className={`live-cents ${displayTone}`}>
                  {displayCents == null ? '—' : `${formatCents(displayCents)} 音分`}
                </strong>
                {displayDirection !== 0 ? (
                  <span className={`live-direction ${displayTone}`}>
                    {displayDirection === 1 ? '↑ 偏高' : '↓ 偏低'}
                  </span>
                ) : (
                  <span className={`status-pill ${displayTone}`}>
                    {displayCents != null ? '准' : displayNote ? '暂无参考' : '等待声音'}
                  </span>
                )}
              </div>
              <div className="live-target">
                目标 <strong>{displayTarget?.label ?? '—'}</strong>
                {displayOctaveHint && <span> · {displayOctaveHint}</span>}
              </div>
              <div className="live-clock">
                {formatTime(now)} <span>/ {formatTime(song.buffer.duration)}</span>
                {loop && <em>循环中</em>}
              </div>
            </section>
            {phase !== 'active' && (
              <section className="pause-panel card">
                <div className="pause-head">
                  <div>
                    <span className="eyebrow">回看</span>
                    <h2>停下，看看刚才唱到哪</h2>
                  </div>
                  <span className="pause-time">{formatTime(pausedAt ?? now)}</span>
                </div>
                <p className="pause-hint">左右拖动卷帘查看历史；点按曲线显示那一刻的音名与偏差。</p>

                {cursor != null ? (
                  selected ? (
                    <div className={`selection-card severity-${selectedSeverity}`}>
                      <div className="selection-main">
                        <strong>{selectedNote?.label ?? '—'}</strong>
                        <span className={`selection-cents ${selectedSeverity}`}>
                          {selectedCents == null ? '暂无参考' : `${formatCents(selectedCents)} 音分`}
                          {selectedDirection !== 0 && (selectedDirection === 1 ? ' ↑ 偏高' : ' ↓ 偏低')}
                        </span>
                      </div>
                      <div className="selection-meta">
                        <span>{formatTime(cursor)}</span>
                        <span>目标 {selectedTarget?.label ?? '—'}</span>
                        <span>{selected.point.f0.toFixed(1)} Hz</span>
                      </div>
                    </div>
                  ) : (
                    <div className="selection-card empty">
                      <strong>{formatTime(cursor)} 附近没有检测到人声</strong>
                      <span>可以再点曲线上的白色圆点，或直接从这里播放原唱。</span>
                    </div>
                  )
                ) : (
                  <div className="selection-card empty">
                    <strong>点一下曲线，定位到某一刻</strong>
                    <span>拖动只移动视野；点按会落下白色游标。</span>
                  </div>
                )}

                <div className="replay-block">
                  <div className="replay-head">
                    <span>从这里回放</span>
                    <span className="tiny-note">
                      {replayBusy
                        ? '正在准备变调回放…'
                        : snapshotLoading
                          ? '正在准备录音…'
                          : voiceReady
                            ? '可回放你自己的声音'
                            : '这次还没录到可回放的音频'}
                    </span>
                  </div>
                  <div className="segmented compact" role="group" aria-label="回放内容">
                    {replayModes.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        aria-pressed={replayMode === item.value}
                        className={replayMode === item.value ? 'active' : ''}
                        disabled={!modePlayable(item.value)}
                        onClick={() => {
                          setReplayMode(item.value)
                          if (replayPlaying) stopReplay()
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="replay-actions">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!modePlayable(replayMode)}
                      onClick={() => void playReplay()}
                    >
                      {replayPlaying ? <StopIcon /> : <PlayIcon />}
                      {replayPlaying ? '停止回放' : `播放${REPLAY_LABELS[replayMode]}`}
                    </button>
                    <button type="button" className="btn primary" onClick={() => void resumeSession()}>
                      <PlayIcon />
                      继续唱
                    </button>
                  </div>
                </div>

                <button type="button" className="btn ghost block end-btn" onClick={() => void finishSession(false)}>
                  结束并保存报告
                </button>
                {error && <div className="notice warn">{error}</div>}
              </section>
            )}
          </aside>

          <section className="desktop-transport practice-dock" aria-label="练唱控制">
            <div className="dock-main">
              <button
                type="button"
                className="round-btn dock-primary"
                aria-label={phase === 'active' ? '暂停并回看' : '继续唱'}
                onClick={() => {
                  if (phase === 'active') void pauseSession()
                  else if (phase === 'paused') void resumeSession()
                }}
              >
                {phase === 'active' ? <PauseIcon /> : <PlayIcon />}
              </button>
              <span className="dock-time">
                {formatTime(phase === 'active' ? now : cursor ?? pausedAt ?? 0)}
              </span>
              <input
                type="range"
                className="dock-scrubber"
                aria-label="时间轴"
                min={0}
                max={Math.max(0.1, song.buffer.duration)}
                step={0.1}
                value={phase === 'active' ? now : cursor ?? pausedAt ?? 0}
                onChange={(event) => scrubTo(Number(event.target.value))}
              />
              <span className="dock-time dim">{formatTime(song.buffer.duration)}</span>

              <div className="segmented compact dock-modes" role="group" aria-label="回放内容">
                {replayModes.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={replayMode === item.value}
                    className={replayMode === item.value ? 'active' : ''}
                    disabled={phase !== 'paused' || !modePlayable(item.value)}
                    onClick={() => {
                      setReplayMode(item.value)
                      if (replayPlaying) stopReplay()
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                className="btn secondary dock-replay"
                disabled={phase !== 'paused' || !modePlayable(replayMode)}
                onClick={() => void playReplay()}
              >
                {replayPlaying ? <StopIcon /> : <PlayIcon />}
                {replayPlaying ? '停止' : '回放'}
              </button>

              <button
                type="button"
                className="btn primary dock-end"
                onClick={() => void finishSession(false)}
              >
                结束
              </button>
            </div>

            <div className="dock-sub">
              <span className={`dock-selection severity-${displayTone}`}>
                {cursor != null
                  ? selected
                    ? `${selectedNote?.label ?? '—'} · ${selectedCents == null ? '暂无参考' : `${formatCents(selectedCents)} 音分`} · ${formatTime(cursor)}`
                    : `${formatTime(cursor)} 附近没有检测到人声`
                  : showPaused
                    ? '拖动时间轴或点选卷帘回看'
                    : '正在跟唱 · 暂停后可回看'}
              </span>
              <label className="dock-volume">
                <span>{volumeLabel}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings.volume * 100)}
                  onChange={(event) => onPatchSettings({ volume: Number(event.target.value) / 100 })}
                />
                <span>{Math.round(settings.volume * 100)}%</span>
              </label>
              {error && <span className="dock-error">{error}</span>}
              <span className="key-hints">
                空格 暂停/继续 · ← → 移动游标 · Esc 返回 · 滚轮缩放
              </span>
            </div>
          </section>

          {loop && (
            <div className="loop-note">
              <span>{loopLabel ?? '循环练唱'} · {formatTime(loop.start)} – {formatTime(loop.end)}</span>
            </div>
          )}
        </main>
      )}

      {lyricsOpen && (
        <LyricSheet
          song={song}
          initialLyrics={lyrics ?? undefined}
          onClose={() => setLyricsOpen(false)}
          onSaved={(next) => {
            setLyrics(next)
            setLyricsOpen(false)
          }}
          onDeleted={() => setLyrics(null)}
        />
      )}
    </div>
  )
}
