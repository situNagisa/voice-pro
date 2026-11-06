import { buildPhrases } from '../audio/analysis'
import type { ReferenceMelody } from '../core/types'
import { alignPlainLines, normalizeLyricLines } from './align'
import { parseLyrics } from './parse'
import type { ParsedLyrics, SongLyrics } from './types'

export type { ActiveLyric } from './find'
export {
  activeLyricAt,
  lyricForPhrase,
  shortLyric,
  sungCharCount,
} from './find'
export {
  alignPlainLines,
  assignPhraseRanges,
  normalizeLyricLines,
} from './align'
export { decodeLyricFile, parseLyrics } from './parse'
export {
  deleteSongLyrics,
  loadSongLyrics,
  saveSongLyrics,
} from './storage'
export type {
  LyricLine,
  LyricSource,
  LyricWord,
  ParsedLyrics,
  SongLyrics,
} from './types'
export { useRecordLyrics, useSongLyrics } from './useLyrics'
export type { SongLyricsState } from './useLyrics'

export interface LyricsBuildResult {
  lyrics: SongLyrics
  parsed: ParsedLyrics
  /** 纯文本经过了自动对时，提示用户微调 */
  autoAligned: boolean
}

/** 把导入的 LRC / 纯文本变成可保存的歌词时间轴。 */
export function buildLyrics(
  raw: string,
  songId: string,
  melody: ReferenceMelody,
  duration: number,
): LyricsBuildResult {
  const parsed = parseLyrics(raw, duration)
  const phrases = buildPhrases(melody.notes)
  const aligned =
    parsed.mode === 'text'
      ? alignPlainLines(
          parsed.lines.map((line) => line.text),
          melody,
        )
      : parsed.lines
  const lines = normalizeLyricLines(
    aligned,
    duration > 0 ? duration : melody.duration,
    phrases,
  )
  return {
    lyrics: {
      songId,
      lines,
      source: parsed.mode === 'lrc' ? 'lrc' : 'text',
      offsetMs: parsed.offsetMs,
      title: parsed.title,
      artist: parsed.artist,
      updatedAt: Date.now(),
    },
    parsed,
    autoAligned: parsed.mode === 'text',
  }
}
