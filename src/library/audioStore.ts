import { encodeWav } from '../audio/recorder'

/**
 * 分轨存储格式选择：16-bit PCM WAV，单声道。
 * - MediaRecorder 只能实时录制，4 分钟伴奏要等 4 分钟，导入体验不可接受；
 * - WebCodecs 的 Opus/AAC 需要自己写 Ogg/MP4 封装，而 Safari/WebView 的
 *   解码支持并不一致，失败时整条缓存就废了；
 * - WAV 是所有浏览器和 Capacitor WebView 都保证能 decodeAudioData 的格式，
 *   体积也还能接受：4 分钟伴奏 24 kHz 约 11 MB，人声 16 kHz 约 7.7 MB。
 * 伴奏保留 12 kHz 带宽，人声只用于跟唱参考，16 kHz 足够覆盖基频与主要谐波。
 */
export const ACCOMPANIMENT_RATE = 24000
export const VOCALS_RATE = 16000

/** 把多声道 AudioBuffer 降成单声道并重采样到目标采样率。 */
async function renderMono(buffer: AudioBuffer, sampleRate: number): Promise<Float32Array> {
  const length = Math.max(1, Math.round(buffer.duration * sampleRate))
  if (typeof OfflineAudioContext !== 'undefined') {
    try {
      const ctx = new OfflineAudioContext(1, length, sampleRate)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start()
      const rendered = await ctx.startRendering()
      return new Float32Array(rendered.getChannelData(0))
    } catch (error) {
      console.warn('[voice-pro] 音频重采样失败，改用线性插值', error)
    }
  }
  return linearResampleToMono(buffer, sampleRate, length)
}

function linearResampleToMono(
  buffer: AudioBuffer,
  sampleRate: number,
  length: number,
): Float32Array {
  const out = new Float32Array(length)
  const channels = buffer.numberOfChannels
  const step = buffer.sampleRate / sampleRate
  for (let i = 0; i < length; i++) {
    const pos = i * step
    const base = Math.min(Math.floor(pos), Math.max(0, buffer.length - 1))
    const next = Math.min(base + 1, Math.max(0, buffer.length - 1))
    const frac = pos - base
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel)
      sum += (data[base] ?? 0) + ((data[next] ?? 0) - (data[base] ?? 0)) * frac
    }
    out[i] = channels > 0 ? sum / channels : 0
  }
  return out
}

/** 编码成 16-bit 单声道 WAV。 */
export async function encodeTrack(
  buffer: AudioBuffer,
  sampleRate: number,
): Promise<Blob> {
  const samples = await renderMono(buffer, sampleRate)
  return encodeWav(samples, sampleRate)
}

export async function decodeBlob(
  ctx: BaseAudioContext,
  blob: Blob,
): Promise<AudioBuffer> {
  const data = await blob.arrayBuffer()
  return ctx.decodeAudioData(data)
}
