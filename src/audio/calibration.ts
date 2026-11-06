/**
 * 输出 + 输入延迟的自动校准。
 *
 * 两种方式：
 * - 外放：喇叭播放短促 click，麦克风检测到达时间。测到的是
 *   「扬声器 → 空气 → 麦克风 → Web Audio 时间轴」的总延迟，适合外放练唱。
 * - 跟拍：播放节拍，用户跟着拍手或发「嗒」。结果里包含人的反应时间
 *   （通常 50–150 ms），适合戴耳机——耳机不串音，click 法测不到。
 *
 * 结果按输出设备（label 优先）保存；标签拿不到时退回「外放/有线/蓝牙」分类。
 * 练唱时由 resolveLatencyMs 读取当前默认输出，自动套用。
 */

import { clamp } from './pitch'

export type OutputKind = 'speaker' | 'wired' | 'bluetooth'
export type CalibrationMethod = 'speaker' | 'tap'

export interface LatencyProfile {
  /** 总补偿延迟，毫秒。 */
  ms: number
  method: CalibrationMethod
  kind: OutputKind
  deviceLabel?: string
  deviceId?: string
  measuredAt: number
  /** 多次测量的离散程度（MAD），毫秒。 */
  spreadMs: number
  samples: number
}

export interface LatencyProfiles {
  [key: string]: LatencyProfile
}

export interface OutputInfo {
  label: string
  id: string
  /** 只有能从 label 判断时才有值。 */
  kind: OutputKind | null
}

export interface CalibrationMeasurement {
  ms: number
  spreadMs: number
  samples: number
  method: CalibrationMethod
}

export interface CalibrationOptions {
  onProgress?: (stage: string, ratio: number) => void
  signal?: AbortSignal
}

export const OUTPUT_KIND_LABEL: Record<OutputKind, string> = {
  speaker: '外放',
  wired: '有线耳机',
  bluetooth: '蓝牙耳机',
}

const MAX_LATENCY_MS = 600
const CLICK_INTERVAL = 0.82
const CLICK_COUNT = 7
const BEAT_INTERVAL = 0.75
const BEAT_COUNT = 10

const RAW_CAPTURE_CODE = `
class CalibrationCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage({ t: currentTime, samples: copy }, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('calibration-capture', CalibrationCaptureProcessor);
`

interface RawBlock {
  t: number
  samples: Float32Array
}

interface Recording {
  samples: Float32Array
  startTime: number
  sampleRate: number
}

class RawMicRecorder {
  private readonly ctx: AudioContext
  private readonly stream: MediaStream
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private blocks: RawBlock[] = []
  private closed = false

  private constructor(ctx: AudioContext, stream: MediaStream) {
    this.ctx = ctx
    this.stream = stream
  }

  static async create(ctx: AudioContext, stream: MediaStream): Promise<RawMicRecorder> {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      throw new Error('当前设备不支持精确的延迟校准（缺少 AudioWorklet）。')
    }
    const recorder = new RawMicRecorder(ctx, stream)
    await recorder.start()
    return recorder
  }

  private async start(): Promise<void> {
    const blob = new Blob([RAW_CAPTURE_CODE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await this.ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const node = new AudioWorkletNode(this.ctx, 'calibration-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    node.port.onmessage = (event: MessageEvent<RawBlock>) => {
      if (this.closed) return
      const block = event.data
      if (block?.samples?.length) this.blocks.push(block)
    }
    const sink = this.ctx.createGain()
    sink.gain.value = 0
    const source = this.ctx.createMediaStreamSource(this.stream)
    source.connect(node)
    node.connect(sink)
    sink.connect(this.ctx.destination)
    this.node = node
    this.source = source
    this.sink = sink
  }

  stop(): Recording {
    this.closed = true
    if (this.node) {
      this.node.port.onmessage = null
      try {
        this.node.port.close()
      } catch {
        // 已关闭
      }
      this.node.disconnect()
      this.node = null
    }
    this.source?.disconnect()
    this.source = null
    this.sink?.disconnect()
    this.sink = null

    let total = 0
    for (const block of this.blocks) total += block.samples.length
    const samples = new Float32Array(total)
    let offset = 0
    for (const block of this.blocks) {
      samples.set(block.samples, offset)
      offset += block.samples.length
    }
    const startTime = this.blocks[0]?.t ?? this.ctx.currentTime
    this.blocks = []
    return { samples, startTime, sampleRate: this.ctx.sampleRate }
  }
}

export function outputKindFromLabel(label: string): OutputKind | null {
  const text = label.toLowerCase()
  if (!text) return null
  if (/bluetooth|bt|airpods|buds|beats|wh-|wf-|freebuds|galaxy buds|enco|soundcore|耳机.*蓝牙/.test(text)) {
    return 'bluetooth'
  }
  if (/headphone|headset|earphone|earbud|wired|usb|有线|耳机|耳麦/.test(text)) {
    return 'wired'
  }
  if (/speaker|扬声器|外放|built-in|internal/.test(text)) return 'speaker'
  return null
}

/** 设备 label 是否足够具体，可以用来做校准档案的键。 */
export function deviceProfileKey(label: string): string | null {
  const normalized = label.trim().toLowerCase()
  if (!normalized) return null
  if (/^(default|默认)(\s*(output|输出))?$/.test(normalized)) return null
  return `device:${normalized}`
}

export function kindProfileKey(kind: OutputKind): string {
  return `kind:${kind}`
}

/** 枚举当前默认输出。需要页面已经拿到麦克风权限，否则 label 为空。 */
export async function currentOutputInfo(): Promise<OutputInfo> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { label: '', id: '', kind: null }
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter((device) => device.kind === 'audiooutput')
    const preferred =
      outputs.find((device) => device.deviceId === 'default') ??
      outputs.find((device) => device.label) ??
      outputs[0]
    const named = outputs.find(
      (device) => device.label && deviceProfileKey(device.label) != null,
    )
    // Chrome 的 default 条目常常没有可读 label，借用另一条有名字的输出设备。
    const preferredLabel = (preferred?.label || '').trim()
    const label = deviceProfileKey(preferredLabel)
      ? preferredLabel
      : (named?.label || preferredLabel).trim()
    return {
      label,
      id: preferred?.deviceId ?? named?.deviceId ?? '',
      kind: outputKindFromLabel(label),
    }
  } catch {
    return { label: '', id: '', kind: null }
  }
}

export interface LatencyResolution {
  ms: number
  source: 'manual' | 'device' | 'kind' | 'estimate'
  profile: LatencyProfile | null
}

/**
 * 练唱开始前调用：手动值优先，其次按当前默认输出设备匹配校准档案，
 * 再退回输出类型（外放/有线/蓝牙），最后用 Web Audio 的估算值。
 */
export async function resolveLatency(
  manualMs: number | null,
  profiles: LatencyProfiles,
  lastKind: OutputKind,
  fallbackMs: number,
): Promise<LatencyResolution> {
  if (manualMs != null) {
    return { ms: clamp(Math.round(manualMs), 0, MAX_LATENCY_MS), source: 'manual', profile: null }
  }
  const info = await Promise.race([
    currentOutputInfo(),
    new Promise<OutputInfo>((resolve) =>
      window.setTimeout(() => resolve({ label: '', id: '', kind: null }), 700),
    ),
  ])
  const deviceKey = deviceProfileKey(info.label)
  const byDevice = deviceKey ? profiles[deviceKey] : undefined
  if (byDevice) {
    return {
      ms: clamp(Math.round(byDevice.ms), 0, MAX_LATENCY_MS),
      source: 'device',
      profile: byDevice,
    }
  }
  const kind = info.kind ?? lastKind
  const byKind = profiles[kindProfileKey(kind)]
  if (byKind) {
    return {
      ms: clamp(Math.round(byKind.ms), 0, MAX_LATENCY_MS),
      source: 'kind',
      profile: byKind,
    }
  }
  return {
    ms: clamp(Math.round(fallbackMs), 0, MAX_LATENCY_MS),
    source: 'estimate',
    profile: null,
  }
}

export function resolveLatencyMs(
  manualMs: number | null,
  profiles: LatencyProfiles,
  lastKind: OutputKind,
  fallbackMs: number,
): Promise<number> {
  return resolveLatency(manualMs, profiles, lastKind, fallbackMs).then((result) => result.ms)
}

/** 最近一次校准的档案，用于设置页和准备页展示。 */
export function latestProfile(
  profiles: LatencyProfiles,
): LatencyProfile | null {
  let latest: LatencyProfile | null = null
  for (const profile of Object.values(profiles)) {
    if (!latest || profile.measuredAt > latest.measuredAt) latest = profile
  }
  return latest
}

export function profileSummary(profile: LatencyProfile): string {
  const kind = OUTPUT_KIND_LABEL[profile.kind]
  const name = profile.deviceLabel?.trim() || kind
  const method = profile.method === 'speaker' ? '外放检测' : '跟拍'
  return `${name} · ${profile.ms} ms（${method}）`
}

export function hasCalibration(manualMs: number | null, profiles: LatencyProfiles): boolean {
  return manualMs != null || Object.keys(profiles).length > 0
}

/**
 * 外放 click 校准。返回总延迟（输出 + 输入）；多次测量取中位数。
 * 需要安静环境，手机外放、不要戴耳机。
 */
export async function measureSpeakerLatency(
  options: CalibrationOptions = {},
): Promise<CalibrationMeasurement> {
  const { onProgress, signal } = options
  throwIfAborted(signal)
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  let stream: MediaStream | null = null
  let recorder: RawMicRecorder | null = null
  try {
    await ctx.resume()
    onProgress?.('等待麦克风权限', 0.02)
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    })
    throwIfAborted(signal)
    recorder = await RawMicRecorder.create(ctx, stream)
    await wait(350, signal)
    throwIfAborted(signal)

    const sampleRate = ctx.sampleRate
    const click = makeTone(sampleRate, 1000, 0.018, 0.6)
    const buffer = ctx.createBuffer(1, click.length, sampleRate)
    buffer.getChannelData(0).set(click)
    const gain = ctx.createGain()
    gain.gain.value = 0.9
    gain.connect(ctx.destination)

    const firstAt = ctx.currentTime + 0.55
    const clickTimes: number[] = []
    for (let i = 0; i < CLICK_COUNT; i++) {
      const at = firstAt + i * CLICK_INTERVAL
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      source.start(at)
      clickTimes.push(at)
      onProgress?.('播放 click，检测到达时间', (i + 1) / CLICK_COUNT)
    }

    const lastAt = clickTimes[clickTimes.length - 1] ?? firstAt
    await wait(Math.max(0, (lastAt + 0.9 - ctx.currentTime) * 1000), signal)
    throwIfAborted(signal)

    const recording = recorder.stop()
    recorder = null
    const template = decimate(click, 4)
    const delays: number[] = []
    for (let i = 1; i < clickTimes.length; i++) {
      const delay = detectClickDelay(recording, clickTimes[i], template, 4)
      if (delay != null) delays.push(delay * 1000)
    }
    if (delays.length < 3) {
      throw new Error('没有检测到 click。请用外放、把音量调到 60% 以上，手机离自己约 30 厘米，环境安静后重试。')
    }
    return summarize(delays, 'speaker')
  } finally {
    recorder?.stop()
    stream?.getTracks().forEach((track) => track.stop())
    await ctx.close().catch(() => undefined)
  }
}

/**
 * 跟拍校准：播放节拍，用户拍手或发「嗒」。结果含人的反应时间。
 * 戴耳机时 click 不会大量串进麦克风，测的是「听到 → 反应 → 发声 → 采集」。
 */
export async function measureTapLatency(
  options: CalibrationOptions = {},
): Promise<CalibrationMeasurement> {
  const { onProgress, signal } = options
  throwIfAborted(signal)
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  let stream: MediaStream | null = null
  let recorder: RawMicRecorder | null = null
  try {
    await ctx.resume()
    onProgress?.('等待麦克风权限', 0.02)
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    })
    throwIfAborted(signal)
    recorder = await RawMicRecorder.create(ctx, stream)
    await wait(350, signal)
    throwIfAborted(signal)

    const sampleRate = ctx.sampleRate
    const tick = makeTone(sampleRate, 880, 0.05, 0.32)
    const buffer = ctx.createBuffer(1, tick.length, sampleRate)
    buffer.getChannelData(0).set(tick)
    const gain = ctx.createGain()
    gain.gain.value = 0.8
    gain.connect(ctx.destination)

    const firstAt = ctx.currentTime + 1
    const beatTimes: number[] = []
    for (let i = 0; i < BEAT_COUNT; i++) {
      const at = firstAt + i * BEAT_INTERVAL
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      source.start(at)
      beatTimes.push(at)
      onProgress?.('播放节拍，跟着拍手或说「嗒」', (i + 1) / BEAT_COUNT)
    }

    const lastAt = beatTimes[beatTimes.length - 1] ?? firstAt
    await wait(Math.max(0, (lastAt + 0.7 - ctx.currentTime) * 1000), signal)
    throwIfAborted(signal)

    const recording = recorder.stop()
    recorder = null
    const offsets = detectTapOffsets(recording, beatTimes)
    if (offsets.length < 4) {
      throw new Error('节拍里没有识别到足够的拍手声。请靠近手机一点，拍手或说「嗒」再响一些，重试。')
    }
    const result = summarize(offsets, 'tap')
    if (result.ms < 40) {
      throw new Error('跟拍结果异常偏小，可能是麦克风直接收到了节拍声。请戴耳机、调低播放音量后重试。')
    }
    return result
  } finally {
    recorder?.stop()
    stream?.getTracks().forEach((track) => track.stop())
    await ctx.close().catch(() => undefined)
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('校准已取消', 'AbortError')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('校准已取消', 'AbortError'))
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    function onAbort(): void {
      window.clearTimeout(timer)
      reject(new DOMException('校准已取消', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function makeTone(
  sampleRate: number,
  frequency: number,
  seconds: number,
  amplitude: number,
): Float32Array {
  const length = Math.max(1, Math.round(sampleRate * seconds))
  const out = new Float32Array(length)
  const twoPi = Math.PI * 2
  for (let i = 0; i < length; i++) {
    const window = 0.5 - 0.5 * Math.cos((twoPi * i) / (length - 1 || 1))
    out[i] = Math.sin((twoPi * frequency * i) / sampleRate) * window * amplitude
  }
  return out
}

function decimate(input: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return input
  const length = Math.ceil(input.length / factor)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    const start = i * factor
    const end = Math.min(input.length, start + factor)
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / Math.max(1, end - start)
  }
  return out
}

/** 在 click 之后的窗口里做归一化互相关，返回从播放时刻到检测到声音的秒数。 */
function detectClickDelay(
  recording: Recording,
  clickTime: number,
  template: Float32Array,
  factor: number,
): number | null {
  const effectiveRate = recording.sampleRate / factor
  const samples = decimate(recording.samples, factor)
  const from = Math.max(0, Math.floor((clickTime + 0.004 - recording.startTime) * effectiveRate))
  const to = Math.min(
    samples.length - template.length,
    Math.ceil((clickTime + 0.8 - recording.startTime) * effectiveRate),
  )
  if (to <= from) return null

  let templateEnergy = 0
  for (let i = 0; i < template.length; i++) templateEnergy += template[i] * template[i]
  if (templateEnergy <= 1e-9) return null

  let bestScore = -1
  let bestIndex = -1
  for (let i = from; i <= to; i++) {
    let dot = 0
    let energy = 0
    for (let k = 0; k < template.length; k++) {
      const value = samples[i + k]
      dot += value * template[k]
      energy += value * value
    }
    const score = dot / Math.sqrt(energy * templateEnergy + 1e-12)
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }
  if (bestScore < 0.2 || bestIndex < 0) return null
  const detectedAt = recording.startTime + (bestIndex * factor) / recording.sampleRate
  const delay = detectedAt - clickTime
  return delay >= 0 && delay <= 0.8 ? delay : null
}

/** 用能量起音检测每一拍的拍手/「嗒」，返回相对节拍的偏移（秒）。 */
function detectTapOffsets(recording: Recording, beatTimes: number[]): number[] {
  const { samples, sampleRate, startTime } = recording
  const frame = Math.max(64, Math.round(sampleRate * 0.006))
  const hop = Math.max(32, Math.round(frame / 2))
  const frameCount = Math.max(0, Math.floor((samples.length - frame) / hop) + 1)
  const rms = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    let sum = 0
    const start = i * hop
    for (let j = 0; j < frame; j++) sum += samples[start + j] * samples[start + j]
    rms[i] = Math.sqrt(sum / frame)
  }
  const sorted = Array.from(rms).sort((a, b) => a - b)
  const noise = sorted[Math.floor(sorted.length * 0.2)] ?? 0

  const offsets: number[] = []
  for (let beatIndex = 2; beatIndex < beatTimes.length; beatIndex++) {
    const beat = beatTimes[beatIndex]
    const fromTime = beat + 0.05
    const toTime = beat + 0.5
    const fromFrame = Math.max(0, Math.floor((fromTime - startTime) / hop))
    const toFrame = Math.min(frameCount - 1, Math.ceil((toTime - startTime) / hop))
    if (toFrame <= fromFrame) continue

    let peak = 0
    let peakFrame = -1
    for (let i = fromFrame; i <= toFrame; i++) {
      if (rms[i] > peak) {
        peak = rms[i]
        peakFrame = i
      }
    }
    if (peakFrame < 0) continue
    const threshold = Math.max(0.009, noise * 6, peak * 0.2)
    if (peak < threshold) continue

    let onsetFrame = peakFrame
    for (let i = peakFrame; i >= fromFrame; i--) {
      if (rms[i] < threshold * 0.55) {
        onsetFrame = i + 1
        break
      }
      onsetFrame = i
    }
    const onset = startTime + (onsetFrame * hop) / sampleRate
    const offset = onset - beat
    if (offset >= 0.05 && offset <= 0.5) offsets.push(offset)
  }
  return offsets
}

function summarize(offsets: number[], method: CalibrationMethod): CalibrationMeasurement {
  const sorted = offsets.slice().sort((a, b) => a - b)
  const median = percentile(sorted, 0.5)
  const deviation = sorted.map((value) => Math.abs(value - median))
  const mad = percentile(deviation.slice().sort((a, b) => a - b), 0.5)
  return {
    ms: Math.round(clamp(median * 1000, 0, MAX_LATENCY_MS)),
    spreadMs: Math.round(mad * 1000 * 1.4826),
    samples: sorted.length,
    method,
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

export { MAX_LATENCY_MS }
