/**
 * 分轨存储。
 *
 * 优先用 WebCodecs 的 Opus 编码（48 kHz，立体声伴奏 96 kbps、人声单声道
 * 32 kbps），再用最小 Ogg 封装保存。四条音轨里只有原曲是用户原文件；
 * 伴奏/人声重新编码后：4 分钟歌约 3.8 MB（旧版 16-bit 单声道 WAV 约 19.2 MB）。
 *
 * 编码后会真实 decodeAudioData 一次；Safari 等不能解码 Ogg Opus 的环境
 * 会自动回退到 16-bit WAV（伴奏 24 kHz 立体声、人声 16 kHz 单声道）。
 * 旧缓存里的 WAV Blob 仍然可以直接 decodeAudioData，读取路径不变。
 */

import { isOpusEncodingSupported, OggOpusEncoder, OPUS_RATE } from './opusEncoder'

export const ACCOMPANIMENT_RATE = 24000
export const VOCALS_RATE = 16000

const OPUS_ACCOMPANIMENT_BITRATE = 96000
const OPUS_VOCALS_BITRATE = 32000
const RESAMPLE_TAPS = 12
const RESAMPLE_PHASES = 512

export interface EncodedTrack {
  blob: Blob
  codec: 'opus' | 'wav'
}

interface ResampleKernel {
  ratio: number
  table: Float32Array
}

type ChannelMode = 'stereo' | 'mono'

function buildKernel(sourceRate: number, targetRate: number): ResampleKernel {
  const cutoff = Math.min(1, targetRate / sourceRate)
  const tapCount = RESAMPLE_TAPS * 2
  const table = new Float32Array((RESAMPLE_PHASES + 1) * tapCount)
  for (let phase = 0; phase <= RESAMPLE_PHASES; phase++) {
    const frac = phase / RESAMPLE_PHASES
    const base = phase * tapCount
    let sum = 0
    for (let tap = 0; tap < tapCount; tap++) {
      const offset = tap - RESAMPLE_TAPS + 1
      const distance = frac - offset
      const x = distance * cutoff
      const sinc =
        Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / RESAMPLE_TAPS)
      const weight = sinc * window
      table[base + tap] = weight
      sum += weight
    }
    if (Math.abs(sum) > 1e-8) {
      for (let tap = 0; tap < tapCount; tap++) table[base + tap] /= sum
    }
  }
  return { ratio: sourceRate / targetRate, table }
}

/**
 * 把 AudioBuffer 的 [startFrame, startFrame+frameCount) 重采样成目标采样率。
 * 用带窗 sinc 查表，比线性插值干净；按秒分块调用，不需要整首歌的浮点副本。
 */
function resamplePlanes(
  buffer: AudioBuffer,
  mode: ChannelMode,
  startFrame: number,
  frameCount: number,
  kernel: ResampleKernel,
): Float32Array[] {
  const channelCount = mode === 'stereo' ? 2 : 1
  const planes: Float32Array[] = []
  for (let channel = 0; channel < channelCount; channel++) {
    planes.push(new Float32Array(frameCount))
  }
  const sourceChannels: Float32Array[] = []
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    sourceChannels.push(buffer.getChannelData(channel))
  }
  if (sourceChannels.length === 0) return planes

  const tapCount = RESAMPLE_TAPS * 2
  const ratio = kernel.ratio
  const table = kernel.table
  const mono = mode === 'mono'
  const last = (sourceChannels[0]?.length ?? 0) - 1

  for (let frame = 0; frame < frameCount; frame++) {
    const position = (startFrame + frame) * ratio
    const base = Math.floor(position)
    let phase = Math.floor((position - base) * RESAMPLE_PHASES)
    if (phase < 0) phase = 0
    else if (phase > RESAMPLE_PHASES - 1) phase = RESAMPLE_PHASES - 1
    const tableOffset = phase * tapCount
    if (mono) {
      let value = 0
      for (let tap = 0; tap < tapCount; tap++) {
        const index = base + tap - RESAMPLE_TAPS + 1
        if (index < 0 || index > last) continue
        let sample = 0
        for (const channel of sourceChannels) sample += channel[index]
        value += (sample / sourceChannels.length) * table[tableOffset + tap]
      }
      planes[0][frame] = value
    } else {
      for (let channel = 0; channel < 2; channel++) {
        const source = sourceChannels[Math.min(channel, sourceChannels.length - 1)]
        let value = 0
        for (let tap = 0; tap < tapCount; tap++) {
          const index = base + tap - RESAMPLE_TAPS + 1
          if (index < 0 || index > last) continue
          value += source[index] * table[tableOffset + tap]
        }
        planes[channel][frame] = value
      }
    }
  }
  return planes
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

async function encodeWavTrack(
  buffer: AudioBuffer,
  mode: ChannelMode,
  sampleRate: number,
): Promise<Blob> {
  const channels = mode === 'stereo' ? 2 : 1
  const frames = Math.max(1, Math.round(buffer.duration * sampleRate))
  const bytes = new ArrayBuffer(44 + frames * channels * 2)
  const view = new DataView(bytes)
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + frames * channels * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, frames * channels * 2, true)

  const kernel = buildKernel(buffer.sampleRate, sampleRate)
  const chunkFrames = sampleRate
  let offset = 44
  for (let start = 0; start < frames; start += chunkFrames) {
    const count = Math.min(chunkFrames, frames - start)
    const planes = resamplePlanes(buffer, mode, start, count, kernel)
    for (let frame = 0; frame < count; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = planes[channel][frame]
        const value = Math.max(-1, Math.min(1, sample))
        view.setInt16(
          offset,
          value < 0 ? value * 0x8000 : value * 0x7fff,
          true,
        )
        offset += 2
      }
    }
    if (start % (chunkFrames * 6) === 0) await nextTick()
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

async function verifyOpusDecode(blob: Blob, expectedSeconds: number): Promise<boolean> {
  if (typeof OfflineAudioContext === 'undefined') return false
  try {
    const ctx = new OfflineAudioContext(1, 8000, 8000)
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    const duration = decoded.duration
    if (!Number.isFinite(duration) || duration <= 0) return false
    return Math.abs(duration - expectedSeconds) <= Math.max(0.5, expectedSeconds * 0.02)
  } catch (error) {
    console.warn('[voice-pro] 当前环境无法解码 Ogg Opus，改用 WAV 存储', error)
    return false
  }
}

let opusState: 'unknown' | 'ok' | 'unsupported' = 'unknown'

async function encodeOpusTrack(
  buffer: AudioBuffer,
  mode: ChannelMode,
  bitrate: number,
): Promise<EncodedTrack | null> {
  if (opusState === 'unsupported') return null
  const channels = mode === 'stereo' ? 2 : 1
  if (!(await isOpusEncodingSupported(channels, bitrate))) {
    opusState = 'unsupported'
    return null
  }
  let encoder: OggOpusEncoder | null = null
  try {
    encoder = await OggOpusEncoder.create(channels, bitrate)
    if (!encoder) {
      opusState = 'unsupported'
      return null
    }
    const kernel = buildKernel(buffer.sampleRate, OPUS_RATE)
    const totalFrames = Math.max(1, Math.round(buffer.duration * OPUS_RATE))
    const chunkFrames = OPUS_RATE
    for (let start = 0; start < totalFrames; start += chunkFrames) {
      const count = Math.min(chunkFrames, totalFrames - start)
      const planes = resamplePlanes(buffer, mode, start, count, kernel)
      encoder.encode(planes, count, Math.round((start / OPUS_RATE) * 1_000_000))
      while (encoder.queueSize > 12) await nextTick()
      if (start % (chunkFrames * 4) === 0) await nextTick()
    }
    const encoded = await encoder.finish(totalFrames)
    if (opusState === 'unknown') {
      const ok = await verifyOpusDecode(encoded.blob, buffer.duration)
      if (!ok) {
        opusState = 'unsupported'
        return null
      }
      opusState = 'ok'
    }
    return { blob: encoded.blob, codec: 'opus' }
  } catch (error) {
    encoder?.abort()
    console.warn('[voice-pro] Opus 编码失败，改用 WAV 存储', error)
    return null
  }
}

/** 伴奏：优先 48 kHz 立体声 Opus，失败时 24 kHz 立体声 16-bit WAV。 */
export async function encodeAccompaniment(buffer: AudioBuffer): Promise<EncodedTrack> {
  const opus = await encodeOpusTrack(buffer, 'stereo', OPUS_ACCOMPANIMENT_BITRATE)
  if (opus) return opus
  return {
    blob: await encodeWavTrack(buffer, 'stereo', ACCOMPANIMENT_RATE),
    codec: 'wav',
  }
}

/** 人声：优先 48 kHz 单声道 Opus，失败时 16 kHz 单声道 16-bit WAV。 */
export async function encodeVocals(buffer: AudioBuffer): Promise<EncodedTrack> {
  const opus = await encodeOpusTrack(buffer, 'mono', OPUS_VOCALS_BITRATE)
  if (opus) return opus
  return {
    blob: await encodeWavTrack(buffer, 'mono', VOCALS_RATE),
    codec: 'wav',
  }
}

export async function decodeBlob(
  ctx: BaseAudioContext,
  blob: Blob,
): Promise<AudioBuffer> {
  const data = await blob.arrayBuffer()
  return ctx.decodeAudioData(data)
}
