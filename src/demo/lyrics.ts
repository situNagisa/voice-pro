import { buildPhrases } from '../audio/analysis'
import type { Note } from '../core/types'
import { assignPhraseRanges } from '../lyrics/align'
import type { LyricLine, LyricWord, SongLyrics } from '../lyrics/types'
import { DEMO_SONG_SPECS } from './songs'
import type { DemoSongSpec } from './songs'

interface DemoLyricLineSpec {
  text: string
  /** 相对歌曲开头的拍号，与 songs.ts 里的旋律音符共用时间轴 */
  startBeat: number
}

/**
 * 示例歌歌词。小星星与欢乐颂使用公版中文词，练声曲用原创的“啊/哦”短句。
 * 每行的字数和对应乐句的音符数接近，逐字时间直接由旋律音符推出。
 */
const DEMO_LYRIC_LINES: Record<string, readonly DemoLyricLineSpec[]> = {
  twinkle: [
    { text: '一闪一闪亮晶晶', startBeat: 4 },
    { text: '满天都是小星星', startBeat: 12 },
    { text: '挂在天上放光明', startBeat: 20 },
    { text: '好像许多小眼睛', startBeat: 28 },
    { text: '一闪一闪亮晶晶', startBeat: 36 },
    { text: '满天都是小星星', startBeat: 44 },
  ],
  'ode-to-joy': [
    { text: '欢乐女神圣洁美丽灿烂光芒照大地', startBeat: 4 },
    { text: '我们心中充满热情来到你的圣殿里', startBeat: 20 },
    { text: '你的力量能使人们消除一切分歧', startBeat: 36 },
    { text: '在你温柔翅膀之下人们团结成兄弟', startBeat: 52 },
  ],
  'sunrise-etude': [
    { text: '啊，晨光升起来', startBeat: 4 },
    { text: '哦，风穿过山岗', startBeat: 20 },
    { text: '啊，声音飞向云端', startBeat: 36 },
    { text: '哦，把长音唱稳', startBeat: 52 },
  ],
}

function demoNotes(spec: DemoSongSpec): Note[] {
  const beatSec = 60 / spec.bpm
  return spec.melody
    .slice()
    .sort((a, b) => a.beat - b.beat)
    .map((note) => ({
      start: note.beat * beatSec,
      end: Math.max(note.beat * beatSec + 0.12, (note.beat + note.beats) * beatSec - 0.02),
      midi: note.midi,
    }))
}

/** 把一行字按对应音符均分成逐字时间；一个字跨到相邻音符时也保持在行内。 */
function buildCharWords(
  text: string,
  notes: Note[],
  lineStart: number,
  lineEnd: number,
): LyricWord[] | undefined {
  const chars = Array.from(text)
  if (chars.length === 0) return undefined
  if (notes.length === 0) {
    return chars.map((char, index) => {
      const start = lineStart + ((lineEnd - lineStart) * index) / chars.length
      const end = lineStart + ((lineEnd - lineStart) * (index + 1)) / chars.length
      return { text: char, start, end }
    })
  }

  const slots = notes.map((_, index) => {
    const from = Math.floor((index * chars.length) / notes.length)
    const to = Math.floor(((index + 1) * chars.length) / notes.length)
    return { from, to }
  })
  const words: LyricWord[] = new Array(chars.length)
  for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
    const { from, to } = slots[noteIndex]
    if (to <= from) continue
    const note = notes[noteIndex]
    const span = Math.max(0.06, note.end - note.start)
    for (let i = from; i < to; i++) {
      const position = i - from
      const count = to - from
      words[i] = {
        text: chars[i],
        start: note.start + (span * position) / count,
        end: note.start + (span * (position + 1)) / count,
      }
    }
  }
  return words
}

function buildDemoLyrics(spec: DemoSongSpec, specs: readonly DemoLyricLineSpec[]): SongLyrics {
  const beatSec = 60 / spec.bpm
  const notes = demoNotes(spec)
  const phrases = buildPhrases(notes)
  const lines: LyricLine[] = specs
    .slice()
    .sort((a, b) => a.startBeat - b.startBeat)
    .map((lineSpec, index) => {
      const nextBeat = specs[index + 1]?.startBeat ?? spec.totalBeats + 1
      const start = Math.max(0, lineSpec.startBeat * beatSec)
      const lineNotes = notes.filter(
        (note) => note.start >= start - 0.03 && note.start < nextBeat * beatSec - 0.03,
      )
      const naturalEnd =
        lineNotes.length > 0
          ? Math.max(...lineNotes.map((note) => note.end))
          : start + Math.max(1.2, Array.from(lineSpec.text).length * 0.34)
      const nextStart = specs[index + 1] ? specs[index + 1].startBeat * beatSec : naturalEnd
      const end = Math.max(start + 0.5, Math.min(naturalEnd, nextStart))
      return {
        text: lineSpec.text,
        start,
        end,
        words: buildCharWords(lineSpec.text, lineNotes, start, end),
      }
    })
  return {
    songId: spec.id,
    lines: assignPhraseRanges(lines, phrases),
    source: 'demo',
    updatedAt: 0,
  }
}

const cache = new Map<string, SongLyrics | null>()

/** 取示例歌内置歌词；没有配词的示例歌返回 null。 */
export function demoLyricSong(id: string): SongLyrics | null {
  if (cache.has(id)) return cache.get(id) ?? null
  const spec = DEMO_SONG_SPECS.find((song) => song.id === id)
  const specs = DEMO_LYRIC_LINES[id]
  if (!spec || !specs) {
    cache.set(id, null)
    return null
  }
  const lyrics = buildDemoLyrics(spec, specs)
  cache.set(id, lyrics)
  return lyrics
}
