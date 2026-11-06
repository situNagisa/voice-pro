import type { RawUserPoint } from '../audio/analysis'
import type { LoopRange } from '../audio/player'
import type { ReferenceMelody } from '../core/types'
import type { Settings } from './settings'

/** 已导入到内存的歌曲。音频本身不会写入 localStorage。 */
export interface LoadedSong {
  id: string
  name: string
  buffer: AudioBuffer
  melody: ReferenceMelody
  temporary: boolean
  warning?: string
  importedAt: number
  /** 内置示例歌的原始 id，用于练习记录回看时重新合成原唱。 */
  demoId?: string
  /** 示例歌的 BPM；导入歌没有，用音符间隔估算一拍。 */
  bpm?: number
  /** 人声分离出的伴奏；没有分离结果时为 null/undefined。 */
  accompaniment?: AudioBuffer | null
  /** 人声分离出的原唱人声；没有分离结果时为 null/undefined。 */
  vocals?: AudioBuffer | null
}

export interface PracticeSession {
  song: LoadedSong
  points: RawUserPoint[]
  loop: LoopRange | null
  loopLabel: string | null
  settings: Settings
}

/** 单句循环练习的目标句；label 用于界面与记录。 */
export interface PracticeLoopTarget extends LoopRange {
  label: string
}
