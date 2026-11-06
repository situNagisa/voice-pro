import { clamp } from './pitch'

export type ReplayMode =
  | 'voice'
  | 'original'
  | 'accompaniment'
  | 'vocals'
  | 'mix'

export interface PlayClipOptions {
  original: AudioBuffer | null
  accompaniment?: AudioBuffer | null
  vocals?: AudioBuffer | null
  voice: AudioBuffer | null
  /** 歌曲时间轴上的起点（秒） */
  songTime: number
  /** 录音文件里的起点（秒） */
  voiceOffset: number | null
  mode: ReplayMode
  volume?: number
}

/**
 * 回放“我的声音 / 原曲 / 伴奏 / 原唱人声 / 叠加”。
 * 原曲与录音各自从指定偏移开始，位置统一按 AudioContext 时钟推进。
 * 叠加优先用伴奏垫底，没有分轨时回退到原曲。
 */
export class ClipPlayer {
  readonly ctx: AudioContext
  private readonly ownsContext: boolean
  private readonly master: GainNode
  private sources: AudioBufferSourceNode[] = []
  private startedAt = 0
  private startSong = 0
  private endSong = 0
  private volume = 0.9
  playing = false
  onEnded: (() => void) | null = null

  constructor(ctx?: AudioContext) {
    this.ownsContext = !ctx
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'playback' })
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.ctx.destination)
  }

  async play(options: PlayClipOptions): Promise<void> {
    this.stop()
    if (this.ctx.state !== 'running') {
      await this.ctx.resume().catch(() => undefined)
    }
    this.volume = clamp(options.volume ?? 0.9, 0, 1)
    this.master.gain.setValueAtTime(this.volume, this.ctx.currentTime)

    const backing = options.accompaniment ?? options.original
    let chosen: AudioBuffer | null = null
    if (options.mode === 'original') chosen = options.original
    else if (options.mode === 'accompaniment') chosen = options.accompaniment ?? null
    else if (options.mode === 'vocals') chosen = options.vocals ?? null
    else if (options.mode === 'mix') chosen = backing

    const wantVoice =
      (options.mode === 'voice' || options.mode === 'mix') &&
      options.voice != null &&
      options.voiceOffset != null

    const timelineDuration =
      options.original?.duration ??
      options.accompaniment?.duration ??
      options.vocals?.duration ??
      options.voice?.duration ??
      0
    const songTime = clamp(options.songTime, 0, Math.max(0, timelineDuration - 0.01))
    let duration = 0

    const startAt = this.ctx.currentTime + 0.04
    const sources: AudioBufferSourceNode[] = []

    if (chosen) {
      const offset = clamp(songTime, 0, Math.max(0, chosen.duration - 0.01))
      const available = chosen.duration - offset
      if (available > 0.02) {
        const source = this.ctx.createBufferSource()
        source.buffer = chosen
        source.connect(this.master)
        source.start(startAt, offset, available)
        sources.push(source)
        duration = Math.max(duration, available)
      }
    }

    if (wantVoice && options.voice && options.voiceOffset != null) {
      const offset = clamp(options.voiceOffset, 0, Math.max(0, options.voice.duration - 0.01))
      const available = options.voice.duration - offset
      if (available > 0.02) {
        const source = this.ctx.createBufferSource()
        source.buffer = options.voice
        source.connect(this.master)
        source.start(startAt, offset, available)
        sources.push(source)
        duration = Math.max(duration, available)
      }
    }

    if (sources.length === 0 || duration <= 0.02) return

    this.sources = sources
    this.startedAt = startAt
    this.startSong = songTime
    this.endSong = songTime + duration
    this.playing = true

    let remaining = sources.length
    for (const source of sources) {
      source.onended = () => {
        remaining -= 1
        if (remaining > 0) return
        if (this.sources !== sources) return
        this.playing = false
        this.sources = []
        this.onEnded?.()
      }
    }
  }

  get position(): number {
    if (!this.playing) return this.startSong
    const elapsed = Math.max(0, this.ctx.currentTime - this.startedAt)
    return Math.min(this.endSong, this.startSong + elapsed)
  }

  stop(): void {
    const sources = this.sources
    this.sources = []
    this.playing = false
    for (const source of sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // 已结束
      }
      source.disconnect()
    }
  }

  dispose(): void {
    this.stop()
    this.onEnded = null
    this.master.disconnect()
    if (this.ownsContext) void this.ctx.close().catch(() => undefined)
  }
}
