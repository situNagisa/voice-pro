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
}

export interface PracticeSession {
  song: LoadedSong
  points: RawUserPoint[]
  loop: LoopRange | null
  loopLabel: string | null
  settings: Settings
}
