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
}

export interface PracticeSession {
  song: LoadedSong
  points: RawUserPoint[]
  loop: LoopRange | null
  loopLabel: string | null
  settings: Settings
}
