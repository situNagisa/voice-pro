import { PitchDetector } from 'pitchy'
import { canCaptureDisplayAudio, describeMediaError, freqToMidi } from './pitch'

export type InputSource = 'mic' | 'display'
export type CaptureMode = 'worklet' | 'scriptprocessor'

export interface CaptureFrame {
  /** AudioContext.currentTime，单位秒。 */
  t: number
  f0: number | null
  clarity: number
  midi: number | null
}

const WINDOW_SIZE = 2048
const HOP_SECONDS = 0.01
const MIN_F0 = 65
const MAX_F0 = 1300
const CLARITY_THRESHOLD = 0.8
const SMOOTH_SIZE = 5
const MIN_RMS = 0.0035

const WORKLET_CODE = `
class PitchCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.windowSize = opts.windowSize || 2048;
    this.hopSize = opts.hopSize || 441;
    this.ring = new Float32Array(this.windowSize);
    this.writeIndex = 0;
    this.sinceEmit = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.ring[this.writeIndex] = channel[i];
      this.writeIndex = (this.writeIndex + 1) % this.windowSize;
      this.sinceEmit++;
      if (this.sinceEmit >= this.hopSize) {
        this.sinceEmit -= this.hopSize;
        const out = new Float32Array(this.windowSize);
        const firstLength = this.windowSize - this.writeIndex;
        out.set(this.ring.subarray(this.writeIndex), 0);
        out.set(this.ring.subarray(0, this.writeIndex), firstLength);
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pitch-capture-processor', PitchCaptureProcessor);
`

/**
 * 从一个 AudioContext 里采集麦克风或屏幕共享音频，并逐帧输出音高。
 * 检测本身在主线程用 pitchy 完成，工作线程只负责搬运 PCM。
 */
export class PitchCapture {
  private ctx: AudioContext
  private stream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private scriptNode: ScriptProcessorNode | null = null
  private sink: GainNode | null = null
  private detector: PitchDetector<Float32Array> | null = null
  private smoothValues: number[] = []
  private active = false
  private mode: CaptureMode = 'worklet'
  private scriptRing = new Float32Array(WINDOW_SIZE)
  private scriptWrite = 0
  private scriptWindow = new Float32Array(WINDOW_SIZE)
  private onFrame: ((frame: CaptureFrame) => void) | null = null
  private onStreamEnded: (() => void) | null = null
  private endedNotified = false

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  get captureMode(): CaptureMode {
    return this.mode
  }

  /** 设备报告的输出 + 基础延迟，用于输入延迟补偿的初始值。 */
  get latencyMs(): number {
    const output = Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency : 0
    const base = Number.isFinite(this.ctx.baseLatency) ? this.ctx.baseLatency : 0
    return (output + base) * 1000
  }

  async start(
    source: InputSource,
    onFrame: (frame: CaptureFrame) => void,
    onStreamEnded?: () => void,
  ): Promise<void> {
    if (this.active) throw new Error('音频采集已经在运行')
    this.onFrame = onFrame
    this.onStreamEnded = onStreamEnded ?? null
    this.endedNotified = false

    try {
      this.stream = await this.openStream(source)
      this.watchStream(this.stream)

      this.detector = PitchDetector.forFloat32Array(WINDOW_SIZE)
      this.detector.clarityThreshold = CLARITY_THRESHOLD
      this.detector.minVolumeDecibels = -55
      this.smoothValues = []

      this.sourceNode = this.ctx.createMediaStreamSource(this.stream)
      this.sink = this.ctx.createGain()
      this.sink.gain.value = 0
      this.sink.connect(this.ctx.destination)

      this.active = true
      const workletOk = await this.tryStartWorklet()
      if (!workletOk) this.startScriptProcessor()
    } catch (error) {
      this.stop()
      throw error
    }
  }

  private async openStream(source: InputSource): Promise<MediaStream> {
    if (!navigator.mediaDevices) {
      throw new Error('当前浏览器不支持音频采集。')
    }
    if (source === 'display') {
      if (!canCaptureDisplayAudio()) {
        throw new Error('此设备不支持捕获其他应用的声音，请改用麦克风。')
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error(
          '没有捕获到声音。选择共享窗口时请勾选“分享标签页音频/系统声音”，然后重试。',
        )
      }
      return stream
    }

    return navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    })
  }

  private watchStream(stream: MediaStream): void {
    const notify = () => {
      if (!this.active || this.endedNotified) return
      this.endedNotified = true
      this.onStreamEnded?.()
    }
    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', notify, { once: true })
    })
  }

  private async tryStartWorklet(): Promise<boolean> {
    if (!this.ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false
    let node: AudioWorkletNode | null = null
    try {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        await this.ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      node = new AudioWorkletNode(this.ctx, 'pitch-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          windowSize: WINDOW_SIZE,
          hopSize: Math.max(64, Math.round(this.ctx.sampleRate * HOP_SECONDS)),
        },
      })
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.active) return
        this.handleWindow(event.data)
      }
      this.sourceNode?.connect(node)
      if (this.sink) node.connect(this.sink)
      this.workletNode = node
      this.mode = 'worklet'
      return true
    } catch (error) {
      console.warn('[voice-pro] AudioWorklet 不可用，回退到 ScriptProcessor', error)
      if (node) {
        node.port.onmessage = null
        node.disconnect()
      }
      return false
    }
  }

  private startScriptProcessor(): void {
    const node = this.ctx.createScriptProcessor(1024, 1, 1)
    node.onaudioprocess = (event) => {
      if (!this.detector || !this.active) return
      const input = event.inputBuffer.getChannelData(0)
      for (let i = 0; i < input.length; i++) {
        this.scriptRing[this.scriptWrite] = input[i]
        this.scriptWrite = (this.scriptWrite + 1) % WINDOW_SIZE
      }
      const firstLength = WINDOW_SIZE - this.scriptWrite
      this.scriptWindow.set(this.scriptRing.subarray(this.scriptWrite), 0)
      this.scriptWindow.set(this.scriptRing.subarray(0, this.scriptWrite), firstLength)
      this.handleWindow(this.scriptWindow)
    }
    this.sourceNode?.connect(node)
    if (this.sink) node.connect(this.sink)
    this.scriptNode = node
    this.mode = 'scriptprocessor'
  }

  private handleWindow(samples: Float32Array): void {
    const detector = this.detector
    if (!detector) return

    let sumSquares = 0
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i]
    }
    const rms = Math.sqrt(sumSquares / samples.length)
    const [pitch, clarity] = detector.findPitch(samples, this.ctx.sampleRate)

    let f0: number | null = null
    if (rms >= MIN_RMS && clarity >= CLARITY_THRESHOLD && pitch >= MIN_F0 && pitch <= MAX_F0) {
      f0 = pitch
    }

    if (f0 != null) {
      this.smoothValues.push(f0)
      if (this.smoothValues.length > SMOOTH_SIZE) this.smoothValues.shift()
      const sorted = [...this.smoothValues].sort((a, b) => a - b)
      f0 = sorted[Math.floor(sorted.length / 2)]
    } else {
      this.smoothValues = []
    }

    this.onFrame?.({
      t: this.ctx.currentTime,
      f0,
      clarity,
      midi: f0 == null ? null : freqToMidi(f0),
    })
  }

  stop(): void {
    this.active = false
    this.onFrame = null
    this.onStreamEnded = null
    this.detector = null
    this.smoothValues = []

    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      try {
        this.workletNode.port.close()
      } catch {
        // 忽略已关闭的 port
      }
      this.workletNode.disconnect()
      this.workletNode = null
    }
    if (this.scriptNode) {
      this.scriptNode.onaudioprocess = null
      this.scriptNode.disconnect()
      this.scriptNode = null
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }
    if (this.sink) {
      this.sink.disconnect()
      this.sink = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }
  }
}

export function mediaErrorMessage(error: unknown, source: InputSource): string {
  return describeMediaError(error, source)
}
