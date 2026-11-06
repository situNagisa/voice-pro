import { clamp } from './pitch'
import { RealtimeStretcher, createRealtimeStretcher } from './stretch'
import { processBuffer } from './transform'

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
  /** 只作用于歌曲音轨；录音人声保持原样 */
  semitones?: number
}

/**
 * 回放“我的声音 / 原曲 / 伴奏 / 原唱人声 / 叠加”。
 * 有 AudioWorklet 时，歌曲音轨走实时变调；录音人声通过一个等长 DelayNode
 * 和它对齐，叠加播放不会出现几十毫秒的错位。没有 Worklet 时退回
 * transform.processBuffer 的离线变调。位置统一按 AudioContext 时钟推进。
 */
export class ClipPlayer {
  readonly ctx: AudioContext
  private readonly ownsContext: boolean
  private readonly master: GainNode
  private sources: AudioBufferSourceNode[] = []
  private extraNodes: AudioNode[] = []
  private stretcher: RealtimeStretcher | null = null
  private stretcherTried = false
  private startedAt = 0
  private startSong = 0
  private endSong = 0
  private latency = 0
  private volume = 0.9
  private playToken = 0
  private endTimer: number | null = null
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
    const token = ++this.playToken
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
    const semitones = clamp(Math.round(options.semitones ?? 0), -12, 12)

    let routeLatency = 0
    let route: AudioNode = this.master
    if (chosen && semitones !== 0) {
      if (!this.stretcherTried) {
        this.stretcherTried = true
        this.stretcher = await createRealtimeStretcher(this.ctx)
        if (this.stretcher) this.stretcher.node.connect(this.master)
      }
      if (this.stretcher) {
        this.stretcher.reset()
        this.stretcher.setParams(semitones, 1)
        route = this.stretcher.node
        routeLatency = this.stretcher.latency
      } else {
        try {
          chosen = await processBuffer(chosen, { semitones })
        } catch (error) {
          console.warn('[voice-pro] 回放离线变调失败，按原调播放', error)
        }
      }
    }
    if (token !== this.playToken) return
    this.latency = routeLatency

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
    const extraNodes: AudioNode[] = []

    if (chosen) {
      const offset = clamp(songTime, 0, Math.max(0, chosen.duration - 0.01))
      const available = chosen.duration - offset
      if (available > 0.02) {
        const source = this.ctx.createBufferSource()
        source.buffer = chosen
        source.connect(route)
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
        let voiceRoute: AudioNode = this.master
        if (routeLatency > 0) {
          const delay = this.ctx.createDelay(1)
          delay.delayTime.value = routeLatency
          delay.connect(this.master)
          voiceRoute = delay
          extraNodes.push(delay)
        }
        source.connect(voiceRoute)
        source.start(startAt, offset, available)
        sources.push(source)
        duration = Math.max(duration, available)
      }
    }

    if (token !== this.playToken) {
      for (const source of sources) {
        try {
          source.stop()
        } catch {
          // 已结束
        }
        source.disconnect()
      }
      for (const node of extraNodes) node.disconnect()
      return
    }
    if (sources.length === 0 || duration <= 0.02) return

    this.sources = sources
    this.extraNodes = extraNodes
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
        const finish = () => {
          if (this.sources !== sources) return
          this.playing = false
          this.sources = []
          this.endTimer = null
          this.onEnded?.()
        }
        if (this.latency > 0) {
          this.endTimer = window.setTimeout(finish, this.latency * 1000)
        } else {
          finish()
        }
      }
    }
  }

  get position(): number {
    if (!this.playing) return this.startSong
    const elapsed = Math.max(0, this.ctx.currentTime - this.startedAt)
    const played = Math.max(0, elapsed - this.latency)
    return Math.min(this.endSong, this.startSong + played)
  }

  stop(): void {
    this.playToken += 1
    if (this.endTimer != null) {
      window.clearTimeout(this.endTimer)
      this.endTimer = null
    }
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
    for (const node of this.extraNodes) node.disconnect()
    this.extraNodes = []
  }

  dispose(): void {
    this.stop()
    this.stretcher?.dispose()
    this.stretcher = null
    this.onEnded = null
    this.master.disconnect()
    if (this.ownsContext) void this.ctx.close().catch(() => undefined)
  }
}
