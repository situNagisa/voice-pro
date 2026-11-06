import { clamp } from './pitch'

export interface LoopRange {
  start: number
  end: number
}

export type SongTrack = 'original' | 'accompaniment' | 'vocals'

/**
 * 原曲/分轨播放器。使用 AudioBufferSourceNode；A-B 循环交给原生 loopStart/loopEnd，
 * 播放位置按 AudioContext 时钟计算，避免 setTimeout 累积误差。
 * 原曲、伴奏、原唱人声共用同一条时间轴，切换音轨时从当前位置接着播。
 */
export class SongPlayer {
  readonly ctx: AudioContext
  private tracks: Partial<Record<SongTrack, AudioBuffer>> = {}
  private mode: SongTrack = 'original'
  private readonly mainDuration: number
  private gainNode: GainNode
  private source: AudioBufferSourceNode | null = null
  private offset = 0
  private startedAt = 0
  private playing = false
  private loopRange: LoopRange | null = null
  private volume = 0.75
  private disposed = false
  onEnded: (() => void) | null = null

  constructor(
    buffer: AudioBuffer,
    tracks?: Partial<Record<SongTrack, AudioBuffer | null>>,
  ) {
    this.tracks.original = buffer
    this.mainDuration = buffer.duration
    if (tracks?.accompaniment) this.tracks.accompaniment = tracks.accompaniment
    if (tracks?.vocals) this.tracks.vocals = tracks.vocals
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.gainNode = this.ctx.createGain()
    this.gainNode.gain.value = this.volume
    this.gainNode.connect(this.ctx.destination)
  }

  get duration(): number {
    return this.mainDuration
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get loop(): LoopRange | null {
    return this.loopRange
  }

  get track(): SongTrack {
    return this.mode
  }

  get availableTracks(): SongTrack[] {
    return (['original', 'accompaniment', 'vocals'] as SongTrack[]).filter(
      (track) => this.tracks[track] != null,
    )
  }

  get position(): number {
    return this.positionAt(this.ctx.currentTime)
  }

  positionAt(ctxTime: number): number {
    if (!this.playing) return this.offset
    let pos = this.offset + Math.max(0, ctxTime - this.startedAt)
    if (this.loopRange) {
      const length = this.loopRange.end - this.loopRange.start
      if (length > 0.05 && pos >= this.loopRange.end) {
        pos = this.loopRange.start + ((pos - this.loopRange.start) % length)
      }
    }
    return clamp(pos, 0, this.mainDuration)
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') {
      await this.ctx.resume()
    }
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1)
    this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015)
  }

  setTracks(tracks: Partial<Record<SongTrack, AudioBuffer | null>>): void {
    for (const track of ['accompaniment', 'vocals'] as const) {
      const buffer = tracks[track]
      if (buffer) this.tracks[track] = buffer
      else delete this.tracks[track]
    }
    if (!this.tracks[this.mode]) this.mode = 'original'
  }

  /** 切到已有音轨；播放中会在当前位置无缝重开一个 source。 */
  setMode(mode: SongTrack): void {
    if (!this.tracks[mode] || this.mode === mode) return
    const wasPlaying = this.playing
    const position = this.position
    this.mode = mode
    if (wasPlaying) {
      this.play(position, this.loopRange)
    } else {
      this.offset = position
    }
  }

  play(from: number = this.offset, loop: LoopRange | null = this.loopRange): void {
    this.stopSource()
    this.loopRange = this.normalizeLoop(loop)

    const buffer = this.tracks[this.mode] ?? this.tracks.original
    if (!buffer) return

    let startAt = clamp(from, 0, Math.max(0, this.mainDuration - 0.01))
    if (this.loopRange) {
      if (startAt < this.loopRange.start || startAt >= this.loopRange.end) {
        startAt = this.loopRange.start
      }
    }

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    if (this.loopRange) {
      source.loop = true
      source.loopStart = this.loopRange.start
      source.loopEnd = this.loopRange.end
    }
    source.connect(this.gainNode)
    source.start(0, startAt)

    this.source = source
    this.offset = startAt
    this.startedAt = this.ctx.currentTime
    this.playing = true

    source.onended = () => {
      if (this.source !== source) return
      if (this.loopRange) return
      this.playing = false
      this.offset = this.mainDuration
      this.source = null
      this.onEnded?.()
    }
  }

  pause(): void {
    if (!this.playing) return
    const pos = this.position
    this.stopSource()
    this.playing = false
    this.offset = pos
  }

  stop(): void {
    this.stopSource()
    this.playing = false
    this.offset = 0
  }

  seek(time: number): void {
    const target = clamp(time, 0, this.mainDuration)
    if (this.playing) {
      this.play(target, this.loopRange)
    } else {
      this.offset = target
    }
  }

  setLoop(loop: LoopRange | null): void {
    const normalized = this.normalizeLoop(loop)
    if (this.playing) {
      const pos = this.position
      this.play(pos, normalized)
    } else {
      this.loopRange = normalized
    }
  }

  private normalizeLoop(loop: LoopRange | null): LoopRange | null {
    if (!loop) return null
    const start = clamp(Math.min(loop.start, loop.end), 0, this.mainDuration)
    const end = clamp(Math.max(loop.start, loop.end), 0, this.mainDuration)
    if (end - start < 0.12) return null
    return { start, end }
  }

  private stopSource(): void {
    const source = this.source
    if (!source) return
    source.onended = null
    try {
      source.stop()
    } catch {
      // 已经结束的 source
    }
    source.disconnect()
    this.source = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopSource()
    this.playing = false
    this.onEnded = null
    this.gainNode.disconnect()
    void this.ctx.close().catch(() => undefined)
  }
}
