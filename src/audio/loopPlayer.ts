import { clamp } from './pitch'

/**
 * 单句循环播放器：只播放一段已经裁好、变好调/速的缓冲区。
 * 位置按 AudioContext 时钟推进，循环接缝不依赖定时器。
 */
export class LoopPlayer {
  readonly ctx: AudioContext
  private buffer: AudioBuffer | null = null
  private master: GainNode
  private source: AudioBufferSourceNode | null = null
  private startedAt = 0
  private offset = 0
  private playing = false
  private volume = 0.8
  private disposed = false

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.ctx.destination)
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get position(): number {
    return this.positionAt(this.ctx.currentTime)
  }

  positionAt(ctxTime: number): number {
    if (!this.playing || !this.buffer) return this.offset
    const duration = this.buffer.duration
    if (duration <= 0) return 0
    const elapsed = this.offset + Math.max(0, ctxTime - this.startedAt)
    return elapsed % duration
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1)
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015)
  }

  /** 替换循环片段；如果正在播放，从片段开头重新开始。 */
  setBuffer(buffer: AudioBuffer, play = false): void {
    this.buffer = buffer
    if (this.playing) {
      this.play(0)
    } else if (play) {
      this.play(0)
    }
  }

  play(from = 0): void {
    this.stopSource()
    if (!this.buffer) return
    const duration = this.buffer.duration
    if (duration <= 0.05) return
    const start = clamp(from, 0, duration - 0.01)
    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.loop = true
    source.loopStart = 0
    source.loopEnd = duration
    source.connect(this.master)
    source.start(0, start)
    this.source = source
    this.offset = start
    this.startedAt = this.ctx.currentTime
    this.playing = true
  }

  pause(): void {
    if (!this.playing) return
    const position = this.position
    this.stopSource()
    this.playing = false
    this.offset = position
  }

  stop(): void {
    this.stopSource()
    this.playing = false
    this.offset = 0
  }

  private stopSource(): void {
    const source = this.source
    if (!source) return
    try {
      source.stop()
    } catch {
      // 已经结束
    }
    source.disconnect()
    this.source = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.master.disconnect()
    void this.ctx.close().catch(() => undefined)
  }
}
