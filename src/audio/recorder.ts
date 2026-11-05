/**
 * 人声录音：
 * - 优先用 MediaRecorder 得到压缩音频（体积小，适合存 IndexedDB）；
 * - 同时维护一份降采样 PCM，用于暂停时立刻回放“刚才唱的”和 MediaRecorder 不可用时的 WAV 兜底。
 * 暂停不会把暂停期间的声音录进去，时间轴由外部记录的分段表负责换算。
 */

export interface AudioSegment {
  /** 本段在歌曲/时间轴上的起点（秒） */
  songStart: number
  /** 本段在录音文件里的起点（秒） */
  voiceStart: number
  /** 本段时长（秒） */
  duration: number
}

const TARGET_RATE = 22050
const PCM_BUFFER = 4096

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ]
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type
    } catch {
      // 某些浏览器没有 isTypeSupported
    }
  }
  return ''
}

function mergeChunks(chunks: Float32Array[], total: number): Float32Array {
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/** 16-bit 单声道 WAV，给回放和兜底存储用。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(bytes)
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    offset += 2
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

export class VoiceRecorder {
  private readonly stream: MediaStream
  private readonly ctx: AudioContext
  private mediaRecorder: MediaRecorder | null = null
  private mediaChunks: Blob[] = []
  private mediaMime = ''

  private pcmSource: MediaStreamAudioSourceNode | null = null
  private pcmNode: ScriptProcessorNode | null = null
  private pcmSink: GainNode | null = null
  private pcmChunks: Float32Array[] = []
  private pcmSamples = 0
  private factor = 1
  private sampleRate = TARGET_RATE

  private paused = false
  private started = false
  private stopped = false
  private stopPromise: Promise<Blob | null> | null = null

  constructor(stream: MediaStream, ctx: AudioContext) {
    this.stream = stream
    this.ctx = ctx
    this.factor = Math.max(1, Math.round(ctx.sampleRate / TARGET_RATE))
    this.sampleRate = Math.round(ctx.sampleRate / this.factor)
  }

  /** 已录制的有效时长（不含暂停）。 */
  get elapsed(): number {
    return this.pcmSamples / this.sampleRate
  }

  get isPaused(): boolean {
    return this.paused
  }

  get hasMediaRecorder(): boolean {
    return this.mediaRecorder != null
  }

  start(): void {
    if (this.started) return
    this.started = true

    const mime = pickMimeType()
    if (mime && typeof MediaRecorder !== 'undefined') {
      try {
        const recorder = new MediaRecorder(this.stream, {
          mimeType: mime,
          audioBitsPerSecond: 64000,
        })
        this.mediaMime = recorder.mimeType || mime
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) this.mediaChunks.push(event.data)
        }
        recorder.start(1000)
        this.mediaRecorder = recorder
      } catch (error) {
        console.warn('[voice-pro] MediaRecorder 不可用，改用 PCM 录音', error)
        this.mediaRecorder = null
      }
    }

    // 立即回放需要 PCM 副本；脚本处理器也作为 MediaRecorder 的兜底。
    try {
      this.pcmSource = this.ctx.createMediaStreamSource(this.stream)
      this.pcmNode = this.ctx.createScriptProcessor(PCM_BUFFER, 1, 1)
      this.pcmSink = this.ctx.createGain()
      this.pcmSink.gain.value = 0
      this.pcmNode.onaudioprocess = (event) => {
        if (this.paused || this.stopped) return
        const input = event.inputBuffer.getChannelData(0)
        const length = Math.floor(input.length / this.factor)
        if (length <= 0) return
        const target = new Float32Array(length)
        for (let i = 0; i < length; i++) {
          let sum = 0
          const start = i * this.factor
          for (let k = 0; k < this.factor; k++) sum += input[start + k] || 0
          target[i] = sum / this.factor
        }
        this.pcmChunks.push(target)
        this.pcmSamples += target.length
      }
      this.pcmSource.connect(this.pcmNode)
      this.pcmNode.connect(this.pcmSink)
      this.pcmSink.connect(this.ctx.destination)
    } catch (error) {
      console.warn('[voice-pro] PCM 回放缓存不可用', error)
    }
  }

  pause(): void {
    if (!this.started || this.paused) return
    this.paused = true
    if (this.mediaRecorder?.state === 'recording') {
      try {
        this.mediaRecorder.pause()
      } catch {
        // 个别浏览器不支持 pause，PCM 时间仍然正确
      }
    }
  }

  resume(): void {
    if (!this.started || !this.paused) return
    this.paused = false
    if (this.mediaRecorder?.state === 'paused') {
      try {
        this.mediaRecorder.resume()
      } catch {
        // 忽略
      }
    }
  }

  /** 当前已录制内容的 WAV，用于暂停后立刻回放。 */
  snapshotWav(): Blob | null {
    if (this.pcmSamples === 0) return null
    const samples = mergeChunks(this.pcmChunks, this.pcmSamples)
    return encodeWav(samples, this.sampleRate)
  }

  stop(): Promise<Blob | null> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true

    if (this.pcmNode) {
      this.pcmNode.onaudioprocess = null
      this.pcmNode.disconnect()
      this.pcmNode = null
    }
    if (this.pcmSource) {
      this.pcmSource.disconnect()
      this.pcmSource = null
    }
    if (this.pcmSink) {
      this.pcmSink.disconnect()
      this.pcmSink = null
    }

    const pcmBlob = this.pcmSamples > 0
      ? encodeWav(mergeChunks(this.pcmChunks, this.pcmSamples), this.sampleRate)
      : null

    const recorder = this.mediaRecorder
    if (recorder && recorder.state !== 'inactive') {
      this.stopPromise = new Promise<Blob | null>((resolve) => {
        const finish = () => {
          const mediaBlob = this.mediaChunks.length > 0
            ? new Blob(this.mediaChunks, { type: this.mediaMime })
            : null
          resolve(mediaBlob && mediaBlob.size > 0 ? mediaBlob : pcmBlob)
        }
        recorder.onstop = finish
        try {
          recorder.stop()
        } catch {
          finish()
        }
        // 某些浏览器 onstop 不触发，兜底
        window.setTimeout(finish, 1500)
      })
      this.mediaRecorder = null
      return this.stopPromise
    }

    this.mediaRecorder = null
    this.stopPromise = Promise.resolve(pcmBlob)
    return this.stopPromise
  }

  dispose(): void {
    try {
      this.mediaNode?.disconnect()
    } catch {
      // 忽略
    }
    void this.stop()
    this.pcmChunks = []
    this.mediaChunks = []
  }

  private get mediaNode(): AudioNode | null {
    return this.pcmNode
  }
}
