import { clamp } from './pitch'

export interface LoopRange {
  start: number
  end: number
}

/**
 * 原曲播放器。使用 AudioBufferSourceNode；A-B 循环交给原生 loopStart/loopEnd，
 * 播放位置按 AudioContext 时钟计算，避免 setTimeout 累积误差。
 */
export class SongPlayer {
  readonly ctx: AudioContext
  private buffer: AudioBuffer
  private gainNode: GainNode
  private source: AudioBufferSourceNode | null = null
  private offset = 0
  private startedAt = 0
  private playing = false
  private loopRange: LoopRange | null = null
  private volume = 0.75
  private disposed = false
  onEnded: (() => void) | null = null

  constructor(buffer: AudioBuffer) {
    this.buffer = buffer
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.gainNode = this.ctx.createGain()
    this.gainNode.gain.value = this.volume
    this.gainNode.connect(this.ctx.destination)
  }

  get duration(): number {
    return this.buffer.duration
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get loop(): LoopRange | null {
    return this.loopRange
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
    return clamp(pos, 0, this.buffer.duration)
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

  play(from: number = this.offset, loop: LoopRange | null = this.loopRange): void {
    this.stopSource()
    this.loopRange = this.normalizeLoop(loop)

    let startAt = clamp(from, 0, Math.max(0, this.buffer.duration - 0.01))
    if (this.loopRange) {
      if (startAt < this.loopRange.start || startAt >= this.loopRange.end) {
        startAt = this.loopRange.start
      }
    }

    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
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
      this.offset = this.buffer.duration
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
    const target = clamp(time, 0, this.buffer.duration)
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
    const start = clamp(Math.min(loop.start, loop.end), 0, this.buffer.duration)
    const end = clamp(Math.max(loop.start, loop.end), 0, this.buffer.duration)
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
