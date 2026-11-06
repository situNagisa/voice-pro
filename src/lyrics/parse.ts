import type { LyricLine, LyricWord, ParsedLyrics } from './types'

const LEADING_TIME_TAG = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const META_TAG = /^\s*\[(ti|ar|al|by|offset|length|re|ve):\s*([^\]]*)\]\s*/i

function toSeconds(minutes: string, seconds: string, fraction?: string): number {
  const min = Number(minutes)
  const sec = Number(seconds)
  let ms = 0
  if (fraction) {
    const digits = fraction.padEnd(3, '0').slice(0, 3)
    ms = Number(digits)
  }
  return min * 60 + sec + ms / 1000
}

function shiftTime(value: number, offsetSec: number): number {
  return Math.max(0, value + offsetSec)
}

function trimWords(words: LyricWord[]): LyricWord[] {
  return words
    .map((word) => ({ ...word }))
    .filter((word) => word.text.length > 0)
}

function parseEnhancedText(
  rest: string,
): { text: string; words: LyricWord[]; endHint: number | null } {
  WORD_TAG.lastIndex = 0
  if (!WORD_TAG.test(rest)) {
    return { text: rest.trim(), words: [], endHint: null }
  }
  WORD_TAG.lastIndex = 0

  let text = ''
  let cursor = 0
  let pendingStart: number | null = null
  let endHint: number | null = null
  const words: LyricWord[] = []
  let match: RegExpExecArray | null
  while ((match = WORD_TAG.exec(rest)) != null) {
    const segment = rest.slice(cursor, match.index)
    if (pendingStart != null && segment.length > 0) {
      words.push({ text: segment, start: pendingStart, end: pendingStart })
      text += segment
    } else if (pendingStart == null && segment.trim().length > 0) {
      // 第一个逐字标签前的文字没有自己的时间，先并入整行。
      text += segment
    }
    pendingStart = toSeconds(match[1], match[2], match[3])
    cursor = match.index + match[0].length
  }

  const tail = rest.slice(cursor)
  if (pendingStart != null) {
    if (tail.length > 0) {
      words.push({ text: tail, start: pendingStart, end: pendingStart })
      text += tail
    } else {
      // 行尾的空标签只用来标记这一句的结束时间。
      endHint = pendingStart
    }
  }
  return { text: text.trim(), words: trimWords(words), endHint }
}

function orderWords(words: LyricWord[], lineEnd: number): LyricWord[] | undefined {
  if (words.length === 0) return undefined
  const sorted = words
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((word, index, list) => {
      const nextStart = list[index + 1]?.start
      const end =
        nextStart != null && nextStart > word.start + 0.02
          ? nextStart
          : Math.max(word.start + 0.16, Math.min(lineEnd, word.start + 0.6))
      return { ...word, end: Math.max(word.start + 0.05, end) }
    })
  return sorted
}

function estimateLineEnd(start: number, text: string, duration: number): number {
  const visible = Array.from(text.replace(/\s/g, '')).length
  const guess = start + Math.max(1.1, visible * 0.34)
  const capped = duration > start ? Math.min(guess, duration) : guess
  return Math.max(start + 0.45, capped)
}

interface TimedLine {
  start: number
  text: string
  words: LyricWord[]
  endHint: number | null
}

/** 解析 LRC 或纯文本。纯文本的 lines 只有文字，时间留给自动对时。 */
export function parseLyrics(raw: string, duration = 0): ParsedLyrics {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const rawLines = text.split('\n')
  let title: string | undefined
  let artist: string | undefined
  let offsetMs = 0
  let enhanced = false
  const timed: TimedLine[] = []

  for (const rawLine of rawLines) {
    let line = rawLine
    let metaMatch = META_TAG.exec(line)
    while (metaMatch) {
      const key = metaMatch[1].toLowerCase()
      const value = metaMatch[2].trim()
      if (key === 'ti' && value) title = value
      else if (key === 'ar' && value) artist = value
      else if (key === 'offset') {
        const parsed = Number(value.replace(/[^\d+-.]/g, ''))
        if (Number.isFinite(parsed)) offsetMs = parsed
      }
      line = line.slice(metaMatch[0].length)
      metaMatch = META_TAG.exec(line)
    }

    const starts: number[] = []
    let timeMatch: RegExpExecArray | null
    while ((timeMatch = LEADING_TIME_TAG.exec(line)) != null) {
      starts.push(toSeconds(timeMatch[1], timeMatch[2], timeMatch[3]))
      line = line.slice(timeMatch[0].length)
    }

    if (starts.length === 0) continue
    const parsed = parseEnhancedText(line)
    if (parsed.words.length > 0) enhanced = true
    if (!parsed.text) continue
    const baseStart = starts[0]
    for (const start of starts) {
      // 一行挂多个时间标签（副歌复用）时，逐字时间随这一次出现整体平移。
      const shift = start - baseStart
      timed.push({
        start,
        text: parsed.text,
        words:
          shift === 0
            ? parsed.words
            : parsed.words.map((word) => ({
                ...word,
                start: word.start + shift,
                end: word.end + shift,
              })),
        endHint: parsed.endHint != null ? parsed.endHint + shift : null,
      })
    }
  }

  if (timed.length > 0) {
    const offsetSec = offsetMs / 1000
    timed.sort((a, b) => a.start - b.start)
    const lines: LyricLine[] = timed.map((item, index) => {
      const start = shiftTime(item.start, offsetSec)
      const next = timed[index + 1]
      const nextStart = next ? shiftTime(next.start, offsetSec) : null
      const hint = item.endHint != null ? shiftTime(item.endHint, offsetSec) : null
      let end =
        hint != null && hint > start
          ? hint
          : nextStart != null && nextStart > start
            ? nextStart
            : estimateLineEnd(start, item.text, duration)
      if (end <= start) end = start + 0.45
      const words = orderWords(
        item.words.map((word) => ({
          ...word,
          start: shiftTime(word.start, offsetSec),
          end: shiftTime(word.end, offsetSec),
        })),
        end,
      )
      if (words && words.length > 0) {
        const lastEnd = words[words.length - 1].end
        if (lastEnd > end) end = lastEnd
      }
      return {
        text: item.text,
        start,
        end,
        ...(words ? { words } : {}),
      }
    })
    return { mode: 'lrc', lines, title, artist, offsetMs, enhanced }
  }

  // 没有时间标签就当纯文本歌词：去掉元数据行和空行。
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
    .filter((line) => line.length > 0)
  return { mode: 'text', lines: lines.map((textLine) => ({ text: textLine, start: 0, end: 0 })), title, artist, enhanced: false }
}

/** 读取 .lrc/.txt：优先 UTF-8，失败后按 GB18030 兜底（国内 LRC 常见编码）。 */
export async function decodeLyricFile(file: File): Promise<string> {
  const data = await file.arrayBuffer()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(data)
    } catch {
      return new TextDecoder('utf-8').decode(data)
    }
  }
}
