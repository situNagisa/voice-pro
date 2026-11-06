import type { LyricLine, SongLyrics } from './types'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface ActiveLyric {
  currentIndex: number | null
  nextIndex: number | null
  current: LyricLine | null
  next: LyricLine | null
  /** 当前行内的进度 0..1 */
  progress: number
  /** 当前行还在唱，还是已经结束在等下一句 */
  active: boolean
}

/** 找到某一时刻正在唱和即将唱的那一行。 */
export function activeLyricAt(lines: LyricLine[], time: number): ActiveLyric {
  if (lines.length === 0) {
    return {
      currentIndex: null,
      nextIndex: null,
      current: null,
      next: null,
      progress: 0,
      active: false,
    }
  }
  let lo = 0
  let hi = lines.length - 1
  let index = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].start <= time + 0.02) {
      index = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (index < 0) {
    return {
      currentIndex: null,
      nextIndex: 0,
      current: null,
      next: lines[0],
      progress: 0,
      active: false,
    }
  }
  const line = lines[index]
  const span = Math.max(0.1, line.end - line.start)
  const progress = clamp((time - line.start) / span, 0, 1)
  const active = time <= line.end + 0.25
  const nextIndex = index + 1 < lines.length ? index + 1 : null
  return {
    currentIndex: index,
    nextIndex,
    current: line,
    next: nextIndex != null ? lines[nextIndex] : null,
    progress,
    active,
  }
}

interface PhraseLike {
  index: number
  start: number
  end: number
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
}

/** 取某个参考乐句对应的歌词；自动对时的映射优先，旧数据退回时间重叠。 */
export function lyricForPhrase(
  source: LyricLine[] | SongLyrics | null | undefined,
  phrase: PhraseLike,
): string | null {
  const lines = Array.isArray(source) ? source : source?.lines
  if (!lines || lines.length === 0) return null
  const mapped = lines.filter(
    (line) =>
      line.phraseStart != null &&
      line.phraseEnd != null &&
      phrase.index >= line.phraseStart &&
      phrase.index <= line.phraseEnd,
  )
  const candidates =
    mapped.length > 0
      ? mapped
      : lines.filter(
          (line) =>
            overlap(line.start, line.end, phrase.start, phrase.end) > 0.12 ||
            (line.start >= phrase.start - 0.05 && line.start <= phrase.end + 0.05),
        )
  const texts: string[] = []
  // 优先取“在这一句里开头”的歌词行；一行跨多个乐句时，后续乐句用重叠最多的一行补上。
  const startsInside = candidates.filter(
    (line) => line.start >= phrase.start - 0.15 && line.start < phrase.end + 0.02,
  )
  if (startsInside.length > 0) {
    for (const line of startsInside) {
      if (line.text && !texts.includes(line.text)) texts.push(line.text)
    }
    return texts.join(' / ')
  }
  let best: LyricLine | null = null
  let bestOverlap = Number.NEGATIVE_INFINITY
  for (const line of candidates) {
    const amount = overlap(line.start, line.end, phrase.start, phrase.end)
    if (amount > bestOverlap) {
      bestOverlap = amount
      best = line
    }
  }
  return best?.text ?? candidates[0]?.text ?? null
}

/** 句子标签用歌词时避免把整段歌词塞进按钮。 */
export function shortLyric(text: string, max = 22): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

/** 当前行已唱到第几个字，用于没有逐字标签时的进度高亮。 */
export function sungCharCount(text: string, progress: number): number {
  const length = Array.from(text).length
  return Math.round(length * clamp(progress, 0, 1))
}
