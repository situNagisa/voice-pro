import { buildPhrases } from '../audio/analysis'
import type { Phrase } from '../audio/analysis'
import type { ReferenceMelody } from '../core/types'
import type { LyricLine, LyricWord } from './types'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function visibleLength(text: string): number {
  return Math.max(1, Array.from(text.replace(/[\s\u3000]/g, '')).length)
}

function lineEstimate(text: string): number {
  return Math.max(0.9, visibleLength(text) * 0.34)
}

interface Weight {
  duration: number
  notes: number
  chars: number
}

function totalWeight(phrases: Phrase[], texts: string[]): Weight {
  return {
    duration: phrases.reduce((sum, phrase) => sum + Math.max(0, phrase.end - phrase.start), 0),
    notes: phrases.reduce((sum, phrase) => sum + phrase.notes.length, 0),
    chars: texts.reduce((sum, text) => sum + visibleLength(text), 0),
  }
}

/** 比较“一段时间”和“一段文字的发音量”，越接近越好。 */
function costForDuration(
  phraseDuration: number,
  noteCount: number,
  chars: number,
  total: Weight,
): number {
  const durationShare = total.duration > 0 ? phraseDuration / total.duration : 1 / 2
  const noteShare = total.notes > 0 ? noteCount / total.notes : durationShare
  const charShare = total.chars > 0 ? chars / total.chars : 1 / 2
  return Math.abs(durationShare - charShare) + Math.abs(noteShare - charShare) * 0.35
}

/** 平铺纯文本，按乐句与字数做动态规划，把每一行分到一个或多个连续乐句。 */
function alignFewLines(
  texts: string[],
  phrases: Phrase[],
  total: Weight,
): LyricLine[] {
  const lineCount = texts.length
  const phraseCount = phrases.length
  const dp: number[][] = Array.from({ length: lineCount + 1 }, () =>
    Array<number>(phraseCount + 1).fill(Number.POSITIVE_INFINITY),
  )
  const choice: number[][] = Array.from({ length: lineCount + 1 }, () =>
    Array<number>(phraseCount + 1).fill(-1),
  )
  dp[0][0] = 0

  for (let line = 1; line <= lineCount; line++) {
    const maxEnd = phraseCount - (lineCount - line)
    for (let end = line; end <= maxEnd; end++) {
      for (let previous = line - 1; previous < end; previous++) {
        if (!Number.isFinite(dp[line - 1][previous])) continue
        const first = phrases[previous]
        const last = phrases[end - 1]
        const duration = last.end - first.start
        const notes = phrases
          .slice(previous, end)
          .reduce((sum, phrase) => sum + phrase.notes.length, 0)
        const cost =
          dp[line - 1][previous] +
          costForDuration(duration, notes, visibleLength(texts[line - 1]), total)
        if (cost < dp[line][end]) {
          dp[line][end] = cost
          choice[line][end] = previous
        }
      }
    }
  }

  const result: LyricLine[] = []
  let end = phraseCount
  for (let line = lineCount; line >= 1; line--) {
    const previous = choice[line][end]
    if (previous < 0) break
    const group = phrases.slice(previous, end)
    const first = group[0]
    const last = group[group.length - 1]
    result.push({
      text: texts[line - 1],
      start: first.start,
      end: Math.max(first.start + 0.2, last.end),
      phraseStart: first.index,
      phraseEnd: last.index,
    })
    end = previous
  }
  return result.reverse()
}

/** 行数多于乐句：一个乐句分到多行，行内按字数切分乐句的时间。 */
function splitManyLines(
  texts: string[],
  phrases: Phrase[],
  total: Weight,
): LyricLine[] {
  const lineCount = texts.length
  const phraseCount = phrases.length
  const dp: number[][] = Array.from({ length: phraseCount + 1 }, () =>
    Array<number>(lineCount + 1).fill(Number.POSITIVE_INFINITY),
  )
  const choice: number[][] = Array.from({ length: phraseCount + 1 }, () =>
    Array<number>(lineCount + 1).fill(-1),
  )
  dp[0][0] = 0

  for (let phraseIndex = 1; phraseIndex <= phraseCount; phraseIndex++) {
    const maxEnd = lineCount - (phraseCount - phraseIndex)
    for (let end = phraseIndex; end <= maxEnd; end++) {
      for (let previous = phraseIndex - 1; previous < end; previous++) {
        if (!Number.isFinite(dp[phraseIndex - 1][previous])) continue
        const phrase = phrases[phraseIndex - 1]
        const chars = texts
          .slice(previous, end)
          .reduce((sum, text) => sum + visibleLength(text), 0)
        const cost =
          dp[phraseIndex - 1][previous] +
          costForDuration(phrase.end - phrase.start, phrase.notes.length, chars, total)
        if (cost < dp[phraseIndex][end]) {
          dp[phraseIndex][end] = cost
          choice[phraseIndex][end] = previous
        }
      }
    }
  }

  const groups: { phrase: Phrase; lines: number[] }[] = []
  let end = lineCount
  for (let phraseIndex = phraseCount; phraseIndex >= 1; phraseIndex--) {
    const previous = choice[phraseIndex][end]
    if (previous < 0) break
    const indexes: number[] = []
    for (let i = previous; i < end; i++) indexes.push(i)
    groups.push({ phrase: phrases[phraseIndex - 1], lines: indexes })
    end = previous
  }
  groups.reverse()

  const result: LyricLine[] = []
  for (const group of groups) {
    const chars = group.lines.reduce((sum, index) => sum + visibleLength(texts[index]), 0)
    const span = Math.max(0.2, group.phrase.end - group.phrase.start)
    let cursor = group.phrase.start
    for (const index of group.lines) {
      const share = (span * visibleLength(texts[index])) / Math.max(1, chars)
      result.push({
        text: texts[index],
        start: cursor,
        end: Math.min(group.phrase.end + 0.001, cursor + Math.max(0.18, share)),
        phraseStart: group.phrase.index,
        phraseEnd: group.phrase.index,
      })
      cursor += share
    }
  }
  return result
}

/** 把纯文本歌词按参考旋律自动对时。 */
export function alignPlainLines(
  lines: string[],
  melody: ReferenceMelody,
): LyricLine[] {
  const texts = lines.map((line) => line.trim()).filter((line) => line.length > 0)
  if (texts.length === 0) return []
  const phrases = buildPhrases(melody.notes)
  if (phrases.length === 0) {
    const duration = melody.duration > 0 ? melody.duration : texts.length * 2.6
    const totalChars = texts.reduce((sum, text) => sum + visibleLength(text), 0)
    let cursor = 0
    return texts.map((text) => {
      const share = (duration * visibleLength(text)) / Math.max(1, totalChars)
      const start = cursor
      cursor = Math.min(duration, cursor + share)
      return { text, start, end: Math.max(start + 0.5, cursor) }
    })
  }

  const total = totalWeight(phrases, texts)
  if (texts.length === phrases.length) {
    return texts.map((text, index) => ({
      text,
      start: phrases[index].start,
      end: Math.max(phrases[index].start + 0.2, phrases[index].end),
      phraseStart: phrases[index].index,
      phraseEnd: phrases[index].index,
    }))
  }
  if (texts.length < phrases.length) {
    return alignFewLines(texts, phrases, total)
  }
  return splitManyLines(texts, phrases, total)
}

function overlapsFirst(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
}

/** 按时间重叠把每行歌词挂到参考乐句上，报告据此把“第 N 句”换成歌词。 */
export function assignPhraseRanges(
  lines: LyricLine[],
  phrases: Phrase[],
): LyricLine[] {
  if (phrases.length === 0) return lines.map((line) => ({ ...line, words: line.words?.slice() }))
  return lines.map((line) => {
    let first: number | null = null
    let last: number | null = null
    const hits: number[] = []
    for (const phrase of phrases) {
      // 用半开区间判断：行尾正好落在下一句开头时，不要把下一句也算进本行。
      const overlaps = overlapsFirst(line.start, line.end, phrase.start, phrase.end) > 0.12
      const lineStartsInside =
        line.start >= phrase.start - 0.04 && line.start < phrase.end - 0.05
      const phraseStartsInside =
        phrase.start >= line.start - 0.04 && phrase.start < line.end - 0.05
      if (overlaps || lineStartsInside || phraseStartsInside) {
        hits.push(phrase.index)
      }
    }
    if (hits.length === 0) {
      let nearest: Phrase | null = null
      let distance = Number.POSITIVE_INFINITY
      for (const phrase of phrases) {
        const gap = Math.max(phrase.start - line.end, line.start - phrase.end, 0)
        if (gap < distance) {
          distance = gap
          nearest = phrase
        }
      }
      if (nearest && distance <= 1.5) hits.push(nearest.index)
    }
    for (const index of hits) {
      if (first == null || index < first) first = index
      if (last == null || index > last) last = index
    }
    if (first == null || last == null) return { ...line, words: line.words?.slice() }
    return {
      ...line,
      words: line.words?.slice(),
      phraseStart: first,
      phraseEnd: last,
    }
  })
}

/** 保存前统一校正顺序、起止时间和逐字时间，并重新计算乐句映射。 */
export function normalizeLyricLines(
  lines: LyricLine[],
  duration: number,
  phrases: Phrase[],
): LyricLine[] {
  const limit = Math.max(0.5, duration)
  let previousStart = -1
  const cleaned: LyricLine[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const text = line.text.trim()
    if (!text) continue
    let start = Number.isFinite(line.start) ? clamp(line.start, 0, Math.max(0, limit - 0.1)) : 0
    if (start < previousStart + 0.08) start = Math.min(limit - 0.1, previousStart + 0.08)
    const nextSource = lines[index + 1]
    const nextStart =
      nextSource && Number.isFinite(nextSource.start) ? clamp(nextSource.start, 0, limit) : null
    let end =
      nextStart != null && nextStart > start + 0.08
        ? Math.min(limit, nextStart)
        : Math.min(limit, Math.max(start + 0.45, line.end > start ? line.end : start + lineEstimate(text)))
    if (!Number.isFinite(end) || end <= start) end = Math.min(limit, start + 0.45)

    let words: LyricWord[] | undefined
    if (line.words && line.words.length > 0) {
      const sorted = line.words
        .filter((word) => word.text.length > 0 && Number.isFinite(word.start))
        .slice()
        .sort((a, b) => a.start - b.start)
      if (sorted.length > 0) {
        const offset = Math.max(0, start - sorted[0].start)
        words = sorted.map((word, index, list) => {
          const wordStart = clamp(word.start + offset, start, end)
          const next = list[index + 1]
          const wordEnd = next
            ? clamp(next.start + offset, wordStart + 0.05, end)
            : clamp(word.end + offset, wordStart + 0.05, end)
          return {
            text: word.text,
            start: wordStart,
            end: Math.max(wordStart + 0.04, wordEnd),
          }
        })
      }
    }
    cleaned.push({
      text,
      start,
      end,
      ...(words ? { words } : {}),
    })
    previousStart = start
  }

  if (cleaned.length > 0) {
    cleaned[cleaned.length - 1].end = Math.min(
      limit,
      Math.max(cleaned[cleaned.length - 1].start + 0.5, cleaned[cleaned.length - 1].end),
    )
  }
  return assignPhraseRanges(cleaned, phrases)
}
