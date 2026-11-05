import type { Note, ReferenceMelody } from '../core/types'
import { clamp, freqToMidi, midiToNoteName } from './pitch'

/** 用户实时唱出的一个有效音高采样点（未做移调/八度处理）。 */
export interface RawUserPoint {
  /** 已补偿输入延迟后的歌曲时间（秒）；自由练习时为相对时间。 */
  t: number
  f0: number
  midi: number
  clarity: number
}

export type Severity = 'good' | 'warn' | 'bad' | 'neutral'

export interface PitchComparison {
  targetMidi: number
  cents: number
  octaveShift: number
  inTune: boolean
  direction: -1 | 0 | 1
  severity: Severity
}

export function severityForCents(cents: number, tolerance: number): Severity {
  const abs = Math.abs(cents)
  if (abs <= tolerance) return 'good'
  if (abs <= tolerance * 2) return 'warn'
  return 'bad'
}

export function directionForCents(cents: number, tolerance: number): -1 | 0 | 1 {
  if (cents > tolerance) return 1
  if (cents < -tolerance) return -1
  return 0
}

/**
 * 将用户音高与参考音高比较。targetMidi 已经包含移调。
 * 开启八度对齐时，选择离参考音最近的八度并把用户音高平移过去；
 * 返回的 cents 是平移后的偏差（正 = 偏高）。
 */
export function compareToTarget(
  userMidi: number,
  targetMidi: number,
  octaveAlign: boolean,
  tolerance: number,
): PitchComparison {
  let octaveShift = 0
  let cents = (userMidi - targetMidi) * 100
  if (octaveAlign) {
    octaveShift = Math.round((targetMidi - userMidi) / 12)
    cents = (userMidi + octaveShift * 12 - targetMidi) * 100
  }
  const inTune = Math.abs(cents) <= tolerance
  return {
    targetMidi,
    cents,
    octaveShift,
    inTune,
    direction: directionForCents(cents, tolerance),
    severity: severityForCents(cents, tolerance),
  }
}

/**
 * 取某一时刻的参考音高（MIDI，已移调）。
 * 优先用帧数据；帧里没有有效值时用音符条块补洞。
 */
export function referenceMidiAt(
  melody: ReferenceMelody,
  time: number,
  transpose = 0,
  tolerance = 0.09,
): number | null {
  const frames = melody.frames
  if (frames.length > 0) {
    let lo = 0
    let hi = frames.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid].t < time) lo = mid + 1
      else hi = mid - 1
    }
    const radius = Math.min(30, Math.ceil(tolerance / Math.max(melody.hop, 0.005)) + 2)
    let best: number | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (let i = Math.max(0, lo - radius); i <= Math.min(frames.length - 1, lo + radius); i++) {
      const frame = frames[i]
      if (frame.f0 == null) continue
      const distance = Math.abs(frame.t - time)
      if (distance <= tolerance && distance < bestDistance) {
        bestDistance = distance
        best = freqToMidi(frame.f0) + transpose
      }
    }
    if (best != null) return best
  }

  const note = referenceNoteAt(melody, time, transpose)
  return note?.midi ?? null
}

export function referenceNoteAt(
  melody: ReferenceMelody,
  time: number,
  transpose = 0,
): Note | null {
  const notes = melody.notes
  if (notes.length === 0) return null
  let lo = 0
  let hi = notes.length - 1
  let candidate = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].start <= time) {
      candidate = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  for (let i = Math.max(0, candidate - 1); i <= Math.min(notes.length - 1, candidate + 2); i++) {
    const note = notes[i]
    if (time >= note.start - 0.06 && time <= note.end + 0.06) {
      return { ...note, midi: note.midi + transpose }
    }
  }
  if (candidate >= 0) {
    const note = notes[candidate]
    if (time - note.end <= 0.15) return { ...note, midi: note.midi + transpose }
  }
  return null
}

export interface Phrase {
  index: number
  start: number
  end: number
  notes: Note[]
}

/** 参考音符间隔 > 0.6s 视为新乐句。 */
export function buildPhrases(notes: Note[]): Phrase[] {
  const sorted = notes
    .filter((note) => Number.isFinite(note.start) && Number.isFinite(note.end) && note.end > note.start)
    .slice()
    .sort((a, b) => a.start - b.start)

  const groups: Note[][] = []
  let current: Note[] = []
  let lastEnd = Number.NEGATIVE_INFINITY
  for (const note of sorted) {
    if (current.length > 0 && note.start - lastEnd > 0.6) {
      groups.push(current)
      current = []
    }
    current.push(note)
    lastEnd = Math.max(lastEnd, note.end)
  }
  if (current.length > 0) groups.push(current)

  return groups.map((group, index) => ({
    index,
    start: group[0].start,
    end: Math.max(...group.map((note) => note.end)),
    notes: group,
  }))
}

export interface PhraseReport {
  index: number
  start: number
  end: number
  noteCount: number
  noteLabels: string[]
  samples: number
  hits: number
  hitRate: number | null
  avgCents: number | null
  meanAbsCents: number | null
  score: number | null
  lowConfidence: boolean
}

export interface SessionReport {
  duration: number
  validFrames: number
  hits: number
  hitRate: number | null
  avgCents: number | null
  meanAbsCents: number | null
  score: number | null
  tolerance: number
  transpose: number
  octaveAlign: boolean
  phraseCount: number
  phrases: PhraseReport[]
}

interface AccentStats {
  samples: number
  hits: number
  sumCents: number
  sumAbsCents: number
}

function emptyStats(): AccentStats {
  return { samples: 0, hits: 0, sumCents: 0, sumAbsCents: 0 }
}

function addPoint(stats: AccentStats, cents: number, tolerance: number): void {
  stats.samples += 1
  stats.sumCents += cents
  stats.sumAbsCents += Math.abs(cents)
  if (Math.abs(cents) <= tolerance) stats.hits += 1
}

function scoreFor(hitRate: number, meanAbsCents: number): number {
  const stability = clamp(1 - meanAbsCents / 100, 0, 1)
  return Math.round(100 * (0.7 * hitRate + 0.3 * stability))
}

function finishStats(stats: AccentStats) {
  if (stats.samples === 0) {
    return {
      samples: 0,
      hits: 0,
      hitRate: null,
      avgCents: null,
      meanAbsCents: null,
      score: null,
    }
  }
  const hitRate = stats.hits / stats.samples
  const avgCents = stats.sumCents / stats.samples
  const meanAbsCents = stats.sumAbsCents / stats.samples
  return {
    samples: stats.samples,
    hits: stats.hits,
    hitRate,
    avgCents,
    meanAbsCents,
    score: scoreFor(hitRate, meanAbsCents),
  }
}

export interface EvaluateOptions {
  transpose: number
  octaveAlign: boolean
  tolerance: number
}

function lowerBound(points: RawUserPoint[], time: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

function evaluateRange(
  points: RawUserPoint[],
  melody: ReferenceMelody,
  range: { start: number; end: number } | null,
  options: EvaluateOptions,
): AccentStats {
  const stats = emptyStats()
  const from = range ? lowerBound(points, range.start - 0.02) : 0
  const to = range ? lowerBound(points, range.end + 0.02 + 1e-9) : points.length
  for (let i = from; i < to; i++) {
    const point = points[i]
    const target = referenceMidiAt(melody, point.t, options.transpose)
    if (target == null) continue
    const comparison = compareToTarget(
      point.midi,
      target,
      options.octaveAlign,
      options.tolerance,
    )
    addPoint(stats, comparison.cents, options.tolerance)
  }
  return stats
}

export function evaluateSession(
  points: RawUserPoint[],
  melody: ReferenceMelody,
  options: EvaluateOptions,
): SessionReport {
  const sortedPoints = points.slice().sort((a, b) => a.t - b.t)
  const totalStats = evaluateRange(sortedPoints, melody, null, options)
  const total = finishStats(totalStats)

  const phrases = buildPhrases(melody.notes).map((phrase): PhraseReport => {
    const stats = evaluateRange(sortedPoints, melody, phrase, options)
    const result = finishStats(stats)
    const uniqueLabels: string[] = []
    for (const note of phrase.notes) {
      const label = midiToNoteName(note.midi + options.transpose).label
      if (!uniqueLabels.includes(label)) uniqueLabels.push(label)
      if (uniqueLabels.length >= 8) break
    }
    return {
      index: phrase.index,
      start: phrase.start,
      end: phrase.end,
      noteCount: phrase.notes.length,
      noteLabels: uniqueLabels,
      samples: result.samples,
      hits: result.hits,
      hitRate: result.hitRate,
      avgCents: result.avgCents,
      meanAbsCents: result.meanAbsCents,
      score: result.score,
      lowConfidence: result.samples > 0 && result.samples < 5,
    }
  })

  phrases.sort((a, b) => {
    const aUsable = a.samples >= 5 && a.hitRate != null
    const bUsable = b.samples >= 5 && b.hitRate != null
    if (aUsable && bUsable) {
      const byHit = a.hitRate! - b.hitRate!
      if (Math.abs(byHit) > 0.0001) return byHit
      return (b.meanAbsCents ?? 0) - (a.meanAbsCents ?? 0)
    }
    if (aUsable) return -1
    if (bUsable) return 1
    if (a.samples > 0 && b.samples === 0) return -1
    if (b.samples > 0 && a.samples === 0) return 1
    return a.index - b.index
  })

  return {
    duration: melody.duration,
    validFrames: total.samples,
    hits: total.hits,
    hitRate: total.hitRate,
    avgCents: total.avgCents,
    meanAbsCents: total.meanAbsCents,
    score: total.score,
    tolerance: options.tolerance,
    transpose: options.transpose,
    octaveAlign: options.octaveAlign,
    phraseCount: phrases.length,
    phrases,
  }
}
