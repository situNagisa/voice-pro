/** 歌词与参考旋律乐句的时间轴，统一以歌曲开头的秒数表示。 */

export interface LyricWord {
  text: string
  start: number
  end: number
}

export interface LyricLine {
  text: string
  start: number
  end: number
  /** 增强型 LRC 的逐字时间；没有逐字标签时为空。 */
  words?: LyricWord[]
  /** 自动对时后对应的乐句范围（含首尾），用于报告里按句显示歌词。 */
  phraseStart?: number
  phraseEnd?: number
}

export type LyricSource = 'lrc' | 'text' | 'demo'

export interface SongLyrics {
  /** 歌曲库里的歌曲 id；示例歌使用 demo id。 */
  songId: string
  lines: LyricLine[]
  source: LyricSource
  /** LRC 的 [offset:] 值，毫秒；解析时已应用，这里只用于展示。 */
  offsetMs?: number
  title?: string
  artist?: string
  updatedAt: number
}

export interface ParsedLyrics {
  mode: 'lrc' | 'text'
  lines: LyricLine[]
  title?: string
  artist?: string
  offsetMs?: number
  /** 至少有一行带增强型逐字标签 */
  enhanced: boolean
}
