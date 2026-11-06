import type { ReferenceMelody } from '../core/types'
import { markSkipSeparation } from '../core/audioFlags'
import { extractMelodyWithFallback } from '../audio/extract'
import { separateVocals } from '../separation'
import type { SeparationSpeed } from '../separation'

export type AnalyzePhase = 'separate' | 'extract'

/** stage 是给用户看的阶段文案，ratio 是本阶段 0..1 的进度。 */
export type AnalyzeProgress = (
  stage: string,
  ratio: number,
  phase: AnalyzePhase,
) => void

export interface SongAnalysis {
  melody: ReferenceMelody
  temporary: boolean
  warning?: string
  vocals: AudioBuffer | null
  accompaniment: AudioBuffer | null
}

function abortError(): DOMException {
  return new DOMException('分析已取消', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 导入歌的统一分析入口：
 * 先分离人声拿到 vocals/accompaniment，再只对人声提取旋律。
 * extractReferenceMelody 内部默认会再分离一次，这里用 core/audioFlags 的
 * “跳过分离”标记绕开，和内置示例歌走的是同一个机制。
 */
export async function analyzeSongAudio(
  audio: AudioBuffer,
  onProgress?: AnalyzeProgress,
  signal?: AbortSignal,
  options: { separationSpeed?: SeparationSpeed } = {},
): Promise<SongAnalysis> {
  if (signal?.aborted) throw abortError()

  const notify = (stage: string, ratio: number, phase: AnalyzePhase): void => {
    try {
      onProgress?.(stage, ratio, phase)
    } catch {
      // UI 回调抛错不应中断分析。
    }
  }

  let vocals: AudioBuffer | null = null
  let accompaniment: AudioBuffer | null = null
  let separationWarning: string | undefined

  try {
    const separated = await separateVocals(
      audio,
      (stage, ratio) => notify(stage, ratio, 'separate'),
      signal,
      { speed: options.separationSpeed },
    )
    vocals = separated.vocals
    accompaniment = separated.accompaniment
    // 已经分离好的人声，提取时跳过内置分离；同时避免再次加载 30 MB 模型。
    markSkipSeparation(vocals)
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortError()
    console.warn('[voice-pro] 人声分离失败，改用整曲提取', error)
    separationWarning = '人声分离失败，这首歌只能通过整曲提取旋律，伴奏不可用。'
    // 整曲回退时也跳过 reference 内部的第二次分离尝试，避免重复失败。
    markSkipSeparation(audio)
  }

  if (signal?.aborted) throw abortError()

  const extracted = await extractMelodyWithFallback(
    vocals ?? audio,
    (stage, ratio) =>
      // reference 模块对“跳过分离”的音频会报“示例歌直接提取”，导入歌里换个说法。
      notify(stage === '示例歌直接提取' ? '准备提取人声旋律' : stage, ratio, 'extract'),
    signal,
  )

  return {
    melody: extracted.melody,
    temporary: extracted.temporary,
    warning: [separationWarning, extracted.warning].filter(Boolean).join(' ') || undefined,
    vocals,
    accompaniment,
  }
}
