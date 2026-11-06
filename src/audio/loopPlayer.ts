import { clamp } from './pitch'
import { RealtimeStretcher, createRealtimeStretcher } from './stretch'

/**
 * 单句循环播放器。
 * 支持 Worklet 时，循环片段保持原始缓冲区，实时变调/变速由 Worklet 完成；
 * 不支持时仍可播放页面预先处理好（或裁好）的缓冲区。位置按 AudioContext
 * 时钟推进并扣掉算法延迟，循环接缝不依赖定时器。
 */
export class LoopPlayer {
  readonly ctx: AudioContext
  private buffer: AudioBuffer | null = null
  private master: GainNode
  private source: AudioBufferSourceNode | null = null
  private stretcher: RealtimeStretcher | null = null
  private realtimeRequest: Promise<boolean> | null = null
  private startedAt = 0
  private offset = 0
  private playing = false
  private volume = 0.8
  private speed = 1
  private transpose = 0
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

  async enableRealtime(): Promise<boolean> {
    if (this.realtimeRequest) return this.realtimeRequest
    this.realtimeRequest = (async () => {
      const stretcher = await createRealtimeStretcher(this.ctx)
      if (!stretcher) return false
      if (this.disposed) {
        stretcher.dispose()
        return false
      }
      this.stretcher = stretcher
      stretcher.node.connect(this.master)
      stretcher.setParams(this.transpose, this.speed)
      if (this.playing) this.play(this.position)
      return true
    })()
    return this.realtimeRequest
  }

  get usesRealtime(): boolean {
    return this.stretcher != null
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
    const elapsed = Math.max(0, ctxTime - this.startedAt)
    if (this.stretcher && elapsed < this.stretcher.latency) {
      return this.offset % duration
    }
    let pos = this.offset + elapsed * this.speed
    if (this.stretcher) pos -= this.stretcher.latency * this.speed
    if (pos < 0) return 0
    return pos % duration
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1)
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015)
  }

  setTranspose(semitones: number): void {
    this.transpose = clamp(Math.round(semitones), -12, 12)
    this.stretcher?.setParams(this.transpose, this.speed)
  }

  setSpeed(speed: number): void {
    const next = clamp(speed, 0.5, 2)
    if (Math.abs(next - this.speed) < 1e-6) return
    if (this.playing && this.buffer) {
      const duration = this.buffer.duration
      if (duration > 0) {
        this.offset =
          (this.offset + Math.max(0, this.ctx.currentTime - this.startedAt) * this.speed) %
          duration
        this.startedAt = this.ctx.currentTime
      }
    }
    this.speed = next
    if (this.source) {
      this.source.playbackRate.setValueAtTime(next, this.ctx.currentTime)
    }
    this.stretcher?.setParams(this.transpose, this.speed)
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
    this.stretcher?.reset()
    this.stretcher?.setParams(this.transpose, this.speed)
    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.playbackRate.value = this.speed
    source.loop = true
    source.loopStart = 0
    source.loopEnd = duration
    source.connect(this.stretcher ? this.stretcher.node : this.master)
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
    this.stretcher?.reset()
    this.playing = false
    this.offset = position
  }

  stop(): void {
    this.stopSource()
    this.stretcher?.reset()
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
    this.stretcher?.dispose()
    this.stretcher = null
    this.master.disconnect()
    void this.ctx.close().catch(() => undefined)
  }
}
