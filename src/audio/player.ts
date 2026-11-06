import { clamp } from './pitch'
import { RealtimeStretcher, createRealtimeStretcher } from './stretch'

export interface LoopRange {
  start: number
  end: number
}

export type SongTrack = 'original' | 'accompaniment' | 'vocals'

/**
 * 原曲/分轨播放器。
 *
 * 支持 AudioWorklet 时走实时变调：AudioBufferSourceNode 负责按 speed 播放，
 * Worklet 里用 WSOLA + 重采样把音高补回来，切换半音/速度不需要重新处理整首歌。
 * 不支持时保持原来的用法：调用方先用 transform.processBuffer 生成副本，
 * 再通过 setTrack 换进来。positionAt 会扣掉 Worklet 的算法延迟，让卷帘、
 * 用户音高点和实际听到的声音保持同一时间轴。
 */
export class SongPlayer {
  readonly ctx: AudioContext
  private tracks: Partial<Record<SongTrack, AudioBuffer>> = {}
  private mode: SongTrack = 'original'
  private readonly mainDuration: number
  private gainNode: GainNode
  private source: AudioBufferSourceNode | null = null
  private stretcher: RealtimeStretcher | null = null
  private realtimeRequest: Promise<boolean> | null = null
  private offset = 0
  private startedAt = 0
  private playing = false
  private loopRange: LoopRange | null = null
  private volume = 0.75
  private speed = 1
  private transpose = 0
  private endTimer: number | null = null
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

  /** 实时变调是否可用；调用 enableRealtime 之后才有意义。 */
  get usesRealtime(): boolean {
    return this.stretcher != null
  }

  get playbackSpeed(): number {
    return this.speed
  }

  /** 实时变调算法本身引入的延迟（秒）；离线回退时为 0。 */
  get processingLatency(): number {
    return this.stretcher?.latency ?? 0
  }

  get position(): number {
    return this.positionAt(this.ctx.currentTime)
  }

  positionAt(ctxTime: number): number {
    if (!this.playing) return clamp(this.offset, 0, this.mainDuration)
    let pos = this.rawPositionAt(ctxTime)
    if (this.stretcher) pos -= this.stretcher.latency * this.speed
    if (this.loopRange) {
      pos = this.wrapLoop(pos)
    } else if (pos < this.offset) {
      // 播放刚开始、Worklet 还在预填时，不要把播放头显示到起点之前
      pos = this.offset
    }
    return clamp(pos, 0, this.mainDuration)
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') {
      await this.ctx.resume()
    }
  }

  /** 尝试加载实时变调 Worklet；失败时返回 false，调用方继续走离线方案。 */
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
      stretcher.node.connect(this.gainNode)
      stretcher.setParams(this.transpose, this.speed)
      if (this.playing) this.play(this.position, this.loopRange)
      return true
    })()
    return this.realtimeRequest
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1)
    this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015)
  }

  /** 半音；实时模式下立即生效，离线回退时由页面重新处理音轨。 */
  setTranspose(semitones: number): void {
    this.transpose = clamp(Math.round(semitones), -12, 12)
    this.stretcher?.setParams(this.transpose, this.speed)
  }

  /** 播放速度（保持音高）；实时模式下只改 source 的播放速率和 Worklet 参数。 */
  setSpeed(speed: number): void {
    const next = clamp(speed, 0.5, 2)
    if (Math.abs(next - this.speed) < 1e-6) return
    if (this.playing) {
      const raw = this.rawPositionAt(this.ctx.currentTime)
      this.offset = raw
      this.startedAt = this.ctx.currentTime
    }
    this.speed = next
    if (this.source) {
      this.source.playbackRate.setValueAtTime(next, this.ctx.currentTime)
    }
    this.stretcher?.setParams(this.transpose, this.speed)
  }

  setTracks(tracks: Partial<Record<SongTrack, AudioBuffer | null>>): void {
    for (const track of ['accompaniment', 'vocals'] as const) {
      const buffer = tracks[track]
      if (buffer) this.tracks[track] = buffer
      else delete this.tracks[track]
    }
    if (!this.tracks[this.mode]) this.mode = 'original'
  }

  /** 替换单条音轨（离线变调结果），时长必须与原曲一致。 */
  setTrack(track: SongTrack, buffer: AudioBuffer): void {
    this.tracks[track] = buffer
    if (this.mode === track && this.playing) {
      this.play(this.position, this.loopRange)
    }
  }

  /** 切到已有音轨；播放中会在当前位置重开一个 source。 */
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

    this.stretcher?.reset()
    this.stretcher?.setParams(this.transpose, this.speed)

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = this.speed
    if (this.loopRange) {
      source.loop = true
      source.loopStart = this.loopRange.start
      source.loopEnd = this.loopRange.end
    }
    source.connect(this.stretcher ? this.stretcher.node : this.gainNode)
    source.start(0, startAt)

    this.source = source
    this.offset = startAt
    this.startedAt = this.ctx.currentTime
    this.playing = true

    source.onended = () => {
      if (this.source !== source) return
      if (this.loopRange) return
      const finish = () => {
        if (this.source !== source) return
        this.playing = false
        this.offset = this.mainDuration
        this.source = null
        this.endTimer = null
        this.onEnded?.()
      }
      // Worklet 里还有约一个算法延迟的尾巴，等它放完再算播放结束
      if (this.stretcher) {
        this.endTimer = window.setTimeout(finish, this.stretcher.latency * 1000)
      } else {
        finish()
      }
    }
  }

  pause(): void {
    if (!this.playing) return
    const pos = this.position
    this.stopSource()
    this.stretcher?.reset()
    this.playing = false
    this.offset = pos
  }

  stop(): void {
    this.stopSource()
    this.stretcher?.reset()
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

  /** 当前 source 在歌曲时间轴上的位置（未扣算法延迟）。 */
  private rawPositionAt(ctxTime: number): number {
    let pos = this.offset + Math.max(0, ctxTime - this.startedAt) * this.speed
    if (this.loopRange) pos = this.wrapLoop(pos)
    return pos
  }

  private wrapLoop(pos: number): number {
    const loop = this.loopRange
    if (!loop) return pos
    const length = loop.end - loop.start
    if (length <= 0.05) return pos
    if (pos < loop.start) return loop.start
    return loop.start + ((pos - loop.start) % length)
  }

  private normalizeLoop(loop: LoopRange | null): LoopRange | null {
    if (!loop) return null
    const start = clamp(Math.min(loop.start, loop.end), 0, this.mainDuration)
    const end = clamp(Math.max(loop.start, loop.end), 0, this.mainDuration)
    if (end - start < 0.12) return null
    return { start, end }
  }

  private stopSource(): void {
    if (this.endTimer != null) {
      window.clearTimeout(this.endTimer)
      this.endTimer = null
    }
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
    this.stretcher?.dispose()
    this.stretcher = null
    this.playing = false
    this.onEnded = null
    this.gainNode.disconnect()
    void this.ctx.close().catch(() => undefined)
  }
}
