import { PitchDetector } from 'pitchy'
import type { ExtractProgress, Note, PitchFrame, ReferenceMelody } from '../core/types'
import { extractReferenceMelody } from '../reference'
import { freqToMidi } from './pitch'

export interface ExtractionResult {
  melody: ReferenceMelody
  temporary: boolean
  warning?: string
}

const FALLBACK_WINDOW = 2048
const FALLBACK_HOP_SECONDS = 0.02
const FALLBACK_CLARITY = 0.66
const FALLBACK_MIN_F0 = 70
const FALLBACK_MAX_F0 = 1000

function abortError(): DOMException {
  return new DOMException('提取已取消', 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/**
 * 调用 reference 模块。真实模块尚未就绪或出错时，用 pitchy 对整首歌做
 * 逐帧检测作为开发/演示用的粗糙回退，并明确标记为临时结果。
 */
export async function extractMelodyWithFallback(
  audio: AudioBuffer,
  onProgress?: ExtractProgress,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  throwIfAborted(signal)
  try {
    const melody = await extractReferenceMelody(audio, onProgress, signal)
    if (!melody || !Array.isArray(melody.frames) || !Array.isArray(melody.notes)) {
      throw new Error('旋律提取返回了空结果')
    }
    return { melody, temporary: false }
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw abortError()
    }
    const reason = error instanceof Error ? error.message : String(error)
    onProgress?.('旋律提取模块暂不可用，改用简易检测…', 0.02)
    const melody = await roughExtract(audio, onProgress, signal)
    return {
      melody,
      temporary: true,
      warning: `真正的旋律提取模块暂不可用（${reason}），当前使用整首歌的简易逐帧检测，参考旋律会比较粗糙。`,
    }
  }
}

function mixToMono(buffer: AudioBuffer, factor: number): { data: Float32Array; sampleRate: number } {
  const channels = buffer.numberOfChannels
  const source = buffer.getChannelData(0)
  const length = Math.floor(source.length / factor)
  const mono = new Float32Array(length)
  for (let c = 0; c < channels; c++) {
    const channel = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) {
      const index = i * factor
      let sum = 0
      for (let k = 0; k < factor; k++) sum += channel[index + k] ?? 0
      mono[i] += sum / factor
    }
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) mono[i] /= channels
  }
  return { data: mono, sampleRate: buffer.sampleRate / factor }
}

/**
 * 开发用回退：将整首歌降采样为单声道，按 2048 窗逐帧跑 McLeod。
 * 混音里伴奏很响，结果只能作为粗略参考。
 */
export async function roughExtract(
  audio: AudioBuffer,
  onProgress?: ExtractProgress,
  signal?: AbortSignal,
): Promise<ReferenceMelody> {
  throwIfAborted(signal)
  const factor = audio.sampleRate >= 40000 ? 2 : 1
  onProgress?.('混合声道…', 0.08)
  await new Promise((resolve) => setTimeout(resolve, 0))
  throwIfAborted(signal)

  const { data, sampleRate } = mixToMono(audio, factor)
  const detector = PitchDetector.forFloat32Array(FALLBACK_WINDOW)
  detector.clarityThreshold = FALLBACK_CLARITY
  detector.minVolumeDecibels = -48

  const hop = Math.max(256, Math.round(sampleRate * FALLBACK_HOP_SECONDS))
  const total = Math.max(0, Math.floor((data.length - FALLBACK_WINDOW) / hop) + 1)
  const frames: PitchFrame[] = []

  for (let i = 0; i < total; i++) {
    if (i % 64 === 0) {
      throwIfAborted(signal)
      const ratio = total > 0 ? i / total : 1
      onProgress?.(`简易检测 ${Math.round(ratio * 100)}%`, 0.1 + ratio * 0.82)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const offset = i * hop
    const [pitch, clarity] = detector.findPitch(
      data.subarray(offset, offset + FALLBACK_WINDOW),
      sampleRate,
    )
    const voiced =
      clarity >= FALLBACK_CLARITY && pitch >= FALLBACK_MIN_F0 && pitch <= FALLBACK_MAX_F0
    frames.push({
      t: (offset + FALLBACK_WINDOW / 2) / sampleRate,
      f0: voiced ? pitch : null,
      clarity,
    })
  }

  throwIfAborted(signal)
  onProgress?.('整理参考音符…', 0.94)
  await new Promise((resolve) => setTimeout(resolve, 0))
  throwIfAborted(signal)

  const hopSeconds = hop / sampleRate
  const notes = framesToNotes(frames, hopSeconds, audio.duration)
  onProgress?.('完成', 1)

  return {
    duration: audio.duration,
    hop: hopSeconds,
    frames,
    notes,
  }
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function framesToNotes(frames: PitchFrame[], hop: number, duration: number): Note[] {
  // 先做简单的 5 点中值平滑，减少颤音在阈值附近来回跳导致的碎片。
  const smoothed: Array<number | null> = new Array(frames.length).fill(null)
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].f0 == null) continue
    const values: number[] = []
    for (let j = Math.max(0, i - 2); j <= Math.min(frames.length - 1, i + 2); j++) {
      const f0 = frames[j].f0
      if (f0 != null) values.push(freqToMidi(f0))
    }
    smoothed[i] = values.length >= 2 ? median(values) : null
  }

  interface Run {
    midi: number
    start: number
    end: number
  }
  const runs: Run[] = []
  let current: Run | null = null

  const flush = () => {
    if (!current) return
    if (current.end - current.start >= 0.07) runs.push(current)
    current = null
  }

  for (let i = 0; i < frames.length; i++) {
    const midi = smoothed[i]
    if (midi == null) {
      flush()
      continue
    }
    const quantized = Math.round(midi)
    const start = Math.max(0, frames[i].t - hop / 2)
    const end = Math.min(duration, frames[i].t + hop / 2)
    if (current && current.midi === quantized && start - current.end <= 0.1) {
      current.end = Math.max(current.end, end)
    } else {
      flush()
      current = { midi: quantized, start, end }
    }
  }
  flush()

  const merged: Note[] = []
  for (const run of runs) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.midi === run.midi &&
      run.start - previous.end <= 0.08
    ) {
      previous.end = Math.max(previous.end, run.end)
    } else {
      merged.push({ start: run.start, end: run.end, midi: run.midi })
    }
  }
  return merged
}
