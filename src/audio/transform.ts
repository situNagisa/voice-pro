/**
 * 变调 / 变速（保持音高）的离线处理。
 *
 * 做法是先做 WSOLA 时间伸缩，再用线性重采样改变音高：
 * - 目标音高倍数 p = 2^(半音/12)，目标速度 v；
 * - 先把音频拉长 p/v 倍（WSOLA 保持音高），再按 p 倍压缩并提高音高；
 * - 最终时长 = 原时长 / v，音高 = 原音高 × p。
 *
 * 整首歌的处理会分片让出主线程，结果按“原 buffer + 参数”缓存，
 * 同一设置下再次练唱、回放不需要重新计算。
 */

import { clamp } from './pitch'

const FRAME = 2048
const HOP = FRAME / 2
const SEARCH = 512
const SEARCH_STEP = 16
const CORR = 192
const YIELD_EVERY = 512

export interface TransformOptions {
  /** 半音数，-12..+12；0 表示不变调 */
  semitones: number
  /** 播放速度，0.5..2；1 表示原速 */
  speed?: number
}

interface OffsetsPlan {
  offsets: Int32Array
  frameCount: number
  stretchLength: number
}

interface CacheEntry {
  promise: Promise<AudioBuffer>
  touched: number
}

const cache = new WeakMap<AudioBuffer, Map<string, CacheEntry>>()
let touchCounter = 0

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

function makeAudioBuffer(
  numberOfChannels: number,
  length: number,
  sampleRate: number,
): AudioBuffer {
  // 用 1 帧的离线上下文创建目标缓冲区，兼容不支持 AudioBuffer 构造函数的 WebView
  const ctx = new OfflineAudioContext(numberOfChannels, 1, sampleRate)
  return ctx.createBuffer(numberOfChannels, length, sampleRate)
}

function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  }
  return window
}

const WINDOW = hannWindow(FRAME)

/** 多声道合成一条单声道信号，只用于 WSOLA 的相似度搜索。 */
function downmix(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  const mono = new Float32Array(buffer.length)
  const scale = 1 / Math.max(1, channels)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) mono[i] += data[i] * scale
  }
  return mono
}

function windowEnergy(mono: Float32Array, index: number): number {
  const end = mono.length
  let energy = 0
  for (let i = 0; i < CORR; i++) {
    const value = index + i < end ? mono[index + i] : 0
    energy += value * value
  }
  return energy
}

/** 归一化互相关，避免响度变化把搜索带偏；参考段能量在每帧只算一次。 */
function similarity(
  mono: Float32Array,
  candidate: number,
  reference: number,
  referenceEnergy: number,
): number {
  if (referenceEnergy < 1e-10) return 0
  const end = mono.length
  let dot = 0
  let energy = 0
  for (let i = 0; i < CORR; i++) {
    const x = candidate + i < end ? mono[candidate + i] : 0
    const y = reference + i < end ? mono[reference + i] : 0
    dot += x * y
    energy += x * x
  }
  if (energy < 1e-10) return 0
  return dot / Math.sqrt(energy * referenceEnergy)
}

async function planOffsets(
  mono: Float32Array,
  stretch: number,
): Promise<OffsetsPlan> {
  const inputLength = mono.length
  const stretchLength = Math.max(1, Math.ceil(inputLength * stretch))
  const frameCount = Math.max(1, Math.ceil(stretchLength / HOP))
  const maxStart = Math.max(0, inputLength - FRAME)
  const offsets = new Int32Array(frameCount)
  let previous = 0

  for (let frame = 0; frame < frameCount; frame++) {
    if (frame === 0) {
      offsets[frame] = 0
      previous = 0
      continue
    }
    // 输出每推进 HOP，输入只推进 HOP / stretch（stretch 为拉长倍数）
    const ideal = clamp(Math.round((frame * HOP) / stretch), 0, maxStart)
    const reference = clamp(previous + HOP, 0, maxStart)
    const referenceEnergy = windowEnergy(mono, reference)
    let best = ideal
    let bestScore = similarity(mono, ideal, reference, referenceEnergy)
    const from = Math.max(0, ideal - SEARCH)
    const to = Math.min(maxStart, ideal + SEARCH)
    for (let candidate = from; candidate <= to; candidate += SEARCH_STEP) {
      if (candidate === ideal) continue
      const score = similarity(mono, candidate, reference, referenceEnergy)
      // 相同相似度时保留离理想位置最近的候选，避免整体被拉偏
      if (score > bestScore + 1e-6) {
        bestScore = score
        best = candidate
      }
    }
    offsets[frame] = best
    previous = best
    if (frame % YIELD_EVERY === 0) await nextTick()
  }

  return { offsets, frameCount, stretchLength }
}

function stretchChannel(input: Float32Array, plan: OffsetsPlan): Float32Array {
  const output = new Float32Array(plan.stretchLength)
  const weights = new Float32Array(plan.stretchLength)
  for (let frame = 0; frame < plan.frameCount; frame++) {
    const start = frame * HOP
    const source = plan.offsets[frame]
    const limit = Math.min(FRAME, plan.stretchLength - start)
    for (let i = 0; i < limit; i++) {
      const value = source + i < input.length ? input[source + i] : 0
      const weight = WINDOW[i]
      output[start + i] += value * weight
      weights[start + i] += weight
    }
  }
  // 首尾帧的窗和会小于 1，按窗和归一化，避免循环接缝与整段音量忽大忽小
  for (let i = 0; i < plan.stretchLength; i++) {
    const weight = weights[i]
    output[i] = weight > 1e-5 ? output[i] / weight : 0
  }
  return output
}

function resampleChannel(
  input: Float32Array,
  pitch: number,
  outputLength: number,
  sampleRate: number,
): Float32Array {
  const output = new Float32Array(outputLength)
  if (Math.abs(pitch - 1) < 1e-6) {
    output.set(input.subarray(0, Math.min(input.length, outputLength)))
  } else {
    const last = input.length - 1
    for (let i = 0; i < outputLength; i++) {
      const position = i * pitch
      const index = Math.floor(position)
      if (index >= last) {
        output[i] = last >= 0 ? input[last] : 0
        continue
      }
      const frac = position - index
      output[i] = input[index] * (1 - frac) + input[index + 1] * frac
    }
  }
  // 极短的淡入淡出，盖住首尾帧的窗函数边缘，避免循环接缝爆音
  const fade = Math.min(Math.round(sampleRate * 0.006), Math.floor(outputLength / 4))
  for (let i = 0; i < fade; i++) {
    const gain = i / fade
    output[i] *= gain
    output[outputLength - 1 - i] *= gain
  }
  return output
}

async function processUncached(
  buffer: AudioBuffer,
  semitones: number,
  speed: number,
): Promise<AudioBuffer> {
  const pitch = Math.pow(2, semitones / 12)
  const stretch = pitch / speed
  const outputLength = Math.max(1, Math.round(buffer.length / speed))
  const mono = downmix(buffer)
  const plan = await planOffsets(mono, stretch)
  const result = makeAudioBuffer(buffer.numberOfChannels, outputLength, buffer.sampleRate)

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel)
    const stretched = stretchChannel(input, plan)
    const output = resampleChannel(stretched, pitch, outputLength, buffer.sampleRate)
    result.getChannelData(channel).set(output)
    if (buffer.numberOfChannels > 1) await nextTick()
  }
  return result
}

/** 处理整段音频；semitones=0 且 speed=1 时直接返回原 buffer。 */
export function processBuffer(
  buffer: AudioBuffer,
  options: TransformOptions,
): Promise<AudioBuffer> {
  const semitones = clamp(Math.round(options.semitones), -12, 12)
  const speed = clamp(options.speed ?? 1, 0.5, 2)
  if (semitones === 0 && Math.abs(speed - 1) < 1e-6) return Promise.resolve(buffer)

  const key = `${semitones}:${speed.toFixed(3)}`
  let entries = cache.get(buffer)
  if (!entries) {
    entries = new Map()
    cache.set(buffer, entries)
  }
  const existing = entries.get(key)
  if (existing) {
    existing.touched = ++touchCounter
    return existing.promise
  }

  const promise = processUncached(buffer, semitones, speed)
  entries.set(key, { promise, touched: ++touchCounter })

  // 同一首歌最多留 3 份变调结果，避免整首歌的副本把手机内存吃满
  if (entries.size > 3) {
    let oldestKey: string | null = null
    let oldest = Number.POSITIVE_INFINITY
    for (const [entryKey, entry] of entries) {
      if (entryKey === key) continue
      if (entry.touched < oldest) {
        oldest = entry.touched
        oldestKey = entryKey
      }
    }
    if (oldestKey) entries.delete(oldestKey)
  }

  promise.catch(() => {
    entries?.delete(key)
  })
  return promise
}

/**
 * 截取一段音频（可带前置静音），用于单句循环。
 * 首尾加很短的淡入淡出，避免循环接缝处出现爆音。
 */
export function sliceBuffer(
  buffer: AudioBuffer,
  start: number,
  end: number,
  padBefore = 0,
): AudioBuffer {
  const rate = buffer.sampleRate
  const from = clamp(start, 0, buffer.duration)
  const to = clamp(end, from, buffer.duration)
  const padSamples = Math.max(0, Math.round(padBefore * rate))
  const bodySamples = Math.max(1, Math.round((to - from) * rate))
  const length = padSamples + bodySamples
  const result = makeAudioBuffer(buffer.numberOfChannels, length, rate)
  const fade = Math.min(Math.round(rate * 0.006), Math.floor(bodySamples / 4))
  const startSample = Math.round(from * rate)

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel)
    const output = new Float32Array(length)
    const available = Math.min(bodySamples, Math.max(0, input.length - startSample))
    if (available > 0) {
      output.set(input.subarray(startSample, startSample + available), padSamples)
    }
    for (let i = 0; i < fade; i++) {
      const gain = i / fade
      output[padSamples + i] *= gain
      output[padSamples + bodySamples - 1 - i] *= gain
    }
    result.getChannelData(channel).set(output)
  }
  return result
}

/** 供 UI 估算“一拍”的长度；示例歌有 BPM，导入歌用音符间隔推断。 */
export function estimateBeatSeconds(notes: { start: number; end: number }[], bpm?: number): number {
  if (bpm && Number.isFinite(bpm) && bpm > 0) return clamp(60 / bpm, 0.25, 1.5)
  const gaps: number[] = []
  const durations: number[] = []
  const sorted = notes.slice().sort((a, b) => a.start - b.start)
  for (let i = 0; i < sorted.length; i++) {
    const note = sorted[i]
    const duration = note.end - note.start
    if (duration >= 0.18 && duration <= 1.4) durations.push(duration)
    if (i > 0) {
      const gap = note.start - sorted[i - 1].start
      if (gap >= 0.18 && gap <= 1.4) gaps.push(gap)
    }
  }
  const values = (gaps.length >= 3 ? gaps : durations).slice().sort((a, b) => a - b)
  if (values.length === 0) return 0.55
  const median = values[Math.floor(values.length / 2)]
  return clamp(median, 0.3, 0.9)
}
