/**
 * 报告“主要问题”的规则（都只在有效采样足够时触发）：
 * - 整体偏高/偏低：有效采样 ≥80，平均偏差 ≥ max(25, 容忍度/2) 音分；
 * - 高音区：目标音高 ≥ A4 的采样 ≥50，均值 ≥ max(25, 容忍度/2) 音分，
 *   且比中低音区更偏至少 10 音分（避免和“整体”重复）；
 * - 长音下滑：长音（≥1.2s）至少 3 个可评估，其中 ≥2 个、且过半长音的
 *   后半段均值比前半段低 ≥ max(22, 容忍度×0.45) 音分；
 * - 起音偏晚：有换气口的音符 ≥4 个，首次唱准相对拍点的延迟中位数 ≥110ms，
 *   且至少 60% 的音符延迟 ≥80ms。
 * 如果没有单一方向的问题，但至少 2 句命中率低于 60%，给出“分散偏弱”诊断。
 * 不满足阈值时不输出对应诊断；整场有效采样 <40 时报告显示“数据还不够”。
 */
import type { Note, ReferenceMelody } from '../core/types'
import {
  buildPhrases,
  compareToTarget,
  referenceMidiAt,
} from './analysis'
import type { SessionReport } from './analysis'
import type { PracticeRecord } from '../state/records'

export type DiagnosisTone = 'flat' | 'sharp' | 'warn'

export interface Diagnosis {
  id: string
  tone: DiagnosisTone
  title: string
  detail: string
  phraseIndexes: number[]
}

interface AnalyzedPoint {
  t: number
  midi: number
  cents: number
  targetMidi: number
  phraseIndex: number | null
}

interface Prepared {
  points: AnalyzedPoint[]
  notes: Note[]
  phrases: ReturnType<typeof buildPhrases>
  phraseByNote: Map<Note, number>
}

interface Candidate {
  diagnosis: Diagnosis
  priority: number
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function lowerBound(points: { t: number }[], time: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

function prepare(record: PracticeRecord, melody: ReferenceMelody): Prepared {
  const sorted = record.points.slice().sort((a, b) => a.t - b.t)
  const phrases = buildPhrases(melody.notes)
  const notes = phrases.flatMap((phrase) => phrase.notes)
  const phraseByNote = new Map<Note, number>()
  for (const phrase of phrases) {
    for (const note of phrase.notes) phraseByNote.set(note, phrase.index)
  }

  const phraseAt = (time: number): number | null => {
    let lo = 0
    let hi = phrases.length - 1
    let candidate = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (phrases[mid].start <= time) {
        candidate = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (candidate < 0) return null
    const phrase = phrases[candidate]
    if (time >= phrase.start - 0.06 && time <= phrase.end + 0.08) return phrase.index
    return null
  }

  const points: AnalyzedPoint[] = []
  for (const point of sorted) {
    const target = referenceMidiAt(melody, point.t, record.transpose)
    if (target == null) continue
    const comparison = compareToTarget(
      point.midi,
      target,
      record.octaveAlign,
      record.tolerance,
    )
    points.push({
      t: point.t,
      midi: point.midi,
      cents: comparison.cents,
      targetMidi: target,
      phraseIndex: phraseAt(point.t),
    })
  }
  return { points, notes, phrases, phraseByNote }
}

function fallbackWorst(report: SessionReport, limit = 3): number[] {
  return report.phrases
    .filter((phrase) => phrase.samples >= 5 && phrase.hitRate != null)
    .slice(0, limit)
    .map((phrase) => phrase.index)
}


function highRegisterDiagnosis(
  prepared: Prepared,
  report: SessionReport,
  tolerance: number,
): Candidate | null {
  const high = prepared.points.filter((point) => point.targetMidi >= 69)
  if (high.length < 50) return null
  const highAvg = mean(high.map((point) => point.cents))
  if (highAvg == null) return null
  const threshold = Math.max(25, tolerance * 0.5)
  if (Math.abs(highAvg) < threshold) return null

  const rest = prepared.points.filter((point) => point.targetMidi < 69)
  const restAvg = mean(rest.map((point) => point.cents))
  // 只有高音区明显比中低音区更偏，才单独说“高音”问题
  if (restAvg != null && restAvg * Math.sign(highAvg) > Math.abs(highAvg) - 10) return null

  const direction = highAvg > 0 ? 1 : -1
  const affected = high.filter(
    (point) => Math.sign(point.cents) === direction && Math.abs(point.cents) >= 15,
  )
  const counts = new Map<number, number>()
  for (const point of affected) {
    if (point.phraseIndex == null) continue
    counts.set(point.phraseIndex, (counts.get(point.phraseIndex) ?? 0) + 1)
  }
  let phraseIndexes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([index]) => index)
  if (phraseIndexes.length === 0) phraseIndexes = fallbackWorst(report)

  const amount = Math.abs(Math.round(highAvg))
  const flat = highAvg < 0
  return {
    priority: 1,
    diagnosis: {
      id: flat ? 'high-flat' : 'high-sharp',
      tone: flat ? 'flat' : 'sharp',
      title: `高音（A4 以上）平均${flat ? '偏低' : '偏高'} ${amount} 音分`,
      detail: flat
        ? `唱到 A4 及以上时音准整体往下掉，共 ${high.length} 个有效采样。练这几句时提前把气送上去，高音不要用喉部挤。`
        : `唱到 A4 及以上时音准整体往上冒，共 ${high.length} 个有效采样。练这几句时把高音的力气收一点，注意听住目标音。`,
      phraseIndexes,
    },
  }
}

function longNoteDiagnosis(prepared: Prepared, tolerance: number): Candidate | null {
  let eligible = 0
  let sliding = 0
  let totalSamples = 0
  const deltas: number[] = []
  const phraseIndexes: number[] = []

  for (const note of prepared.notes) {
    const duration = note.end - note.start
    if (duration < 1.2) continue
    const first: number[] = []
    const second: number[] = []
    const mid = note.start + duration / 2
    for (const point of prepared.points) {
      if (point.t < note.start + 0.05 || point.t > note.end - 0.05) continue
      if (point.t < mid) first.push(point.cents)
      else second.push(point.cents)
    }
    if (first.length < 4 || second.length < 4) continue
    eligible += 1
    totalSamples += first.length + second.length
    const firstAvg = mean(first)
    const secondAvg = mean(second)
    if (firstAvg == null || secondAvg == null) continue
    const delta = secondAvg - firstAvg
    if (delta <= -Math.max(22, tolerance * 0.45)) {
      sliding += 1
      deltas.push(delta)
      const phraseIndex = prepared.phraseByNote.get(note)
      if (phraseIndex != null) phraseIndexes.push(phraseIndex)
    }
  }

  if (eligible < 3 || sliding < 2 || sliding / eligible < 0.5 || totalSamples < 30) {
    return null
  }
  const amount = Math.max(15, Math.round(Math.abs(median(deltas))))
  const indexes = [...new Set(phraseIndexes)].slice(0, 3)
  return {
    priority: 3,
    diagnosis: {
      id: 'long-drop',
      tone: 'flat',
      title: `长音后半段下滑约 ${amount} 音分`,
      detail: `在 ${sliding} 个长音里，后半段的平均音高比开头低。长音不要一开口就松气，保持住气息，结尾前再收。`,
      phraseIndexes: indexes,
    },
  }
}

function onsetDiagnosis(prepared: Prepared, record: PracticeRecord): Candidate | null {
  const sortedPoints = prepared.points
  const delays: number[] = []
  const latePhrases: number[] = []
  const noteSorted = prepared.notes.slice().sort((a, b) => a.start - b.start)
  let eligible = 0

  for (let index = 0; index < noteSorted.length; index++) {
    const note = noteSorted[index]
    if (note.end - note.start < 0.5) continue
    const previous = noteSorted[index - 1]
    // 连音之间没有换气口，起音早晚没有意义
    if (previous && note.start - previous.end < 0.12) continue
    const target = note.midi
    let from = lowerBound(sortedPoints, note.start - 0.05)
    let first: { t: number; delay: number } | null = null
    for (; from < sortedPoints.length; from++) {
      const point = sortedPoints[from]
      if (point.t > note.start + 0.6) break
      if (point.t < note.start - 0.04) continue
      const comparison = compareToTarget(
        point.midi,
        target,
        record.octaveAlign,
        record.tolerance,
      )
      if (Math.abs(comparison.cents) > 250) continue
      first = { t: point.t, delay: Math.max(0, point.t - note.start) }
      break
    }
    if (!first || first.delay > 0.5) continue
    eligible += 1
    delays.push(first.delay)
    if (first.delay >= 0.085) {
      const phraseIndex = prepared.phraseByNote.get(note)
      if (phraseIndex != null) latePhrases.push(phraseIndex)
    }
  }

  if (eligible < 4) return null
  const medianDelay = median(delays)
  const lateShare = delays.filter((delay) => delay >= 0.08).length / delays.length
  if (medianDelay < 0.11 || lateShare < 0.6) return null

  const indexes = [...new Set(latePhrases)].slice(0, 3)
  return {
    priority: 4,
    diagnosis: {
      id: 'late-onset',
      tone: 'warn',
      title: `起音偏晚约 ${Math.round(medianDelay * 1000)}ms`,
      detail: `每个乐句的开头平均要等 ${(medianDelay).toFixed(2)} 秒才唱出来。跟着循环的预备拍提前吸气，在拍点上直接出声。`,
      phraseIndexes: indexes,
    },
  }
}

function overallDiagnosis(
  prepared: Prepared,
  report: SessionReport,
  tolerance: number,
): Candidate | null {
  if (prepared.points.length < 80) return null
  const avg = mean(prepared.points.map((point) => point.cents))
  if (avg == null) return null
  if (Math.abs(avg) < Math.max(25, tolerance * 0.5)) return null

  const direction = avg > 0 ? 1 : -1
  const phraseIndexes = report.phrases
    .filter(
      (phrase) =>
        phrase.samples >= 5 &&
        phrase.avgCents != null &&
        Math.sign(phrase.avgCents) === direction &&
        Math.abs(phrase.avgCents) >= 20,
    )
    .slice(0, 3)
    .map((phrase) => phrase.index)

  const amount = Math.abs(Math.round(avg))
  const sharp = avg > 0
  return {
    priority: 2,
    diagnosis: {
      id: sharp ? 'overall-sharp' : 'overall-flat',
      tone: sharp ? 'sharp' : 'flat',
      title: `整体${sharp ? '偏高' : '偏低'}约 ${amount} 音分`,
      detail: sharp
        ? '大部分音都压在目标上方，像是起音时力气给多了。先轻声跟一遍，把每个音落到目标中间。'
        : '大部分音都落在目标下方，像是气息不够或习惯性放松。先跟着伴奏哼一遍，把音高托住。',
      phraseIndexes: phraseIndexes.length > 0 ? phraseIndexes : fallbackWorst(report),
    },
  }
}

/**
 * 从本次练习的原始音高采样里找 1–3 条可解释的问题。
 * 有效采样太少或没有达到阈值时返回空数组，报告页会显示“数据还不够”。
 */
export function diagnoseSession(
  record: PracticeRecord,
  melody: ReferenceMelody,
  report: SessionReport,
): Diagnosis[] {
  if (report.validFrames < 40) return []
  const prepared = prepare(record, melody)
  const candidates: Candidate[] = []
  const high = highRegisterDiagnosis(prepared, report, record.tolerance)
  if (high) candidates.push(high)
  const overall = overallDiagnosis(prepared, report, record.tolerance)
  const longNote = longNoteDiagnosis(prepared, record.tolerance)
  const onset = onsetDiagnosis(prepared, record)
  if (overall && !high) candidates.push(overall)
  if (longNote) candidates.push(longNote)
  if (onset) candidates.push(onset)

  const fallback = fallbackWorst(report)
  const sorted = candidates.sort((a, b) => a.priority - b.priority)
  if (sorted.length === 0) {
    const weak = report.phrases.filter(
      (phrase) =>
        phrase.samples >= 5 &&
        phrase.hitRate != null &&
        phrase.hitRate < 0.6,
    )
    if (weak.length >= 2) {
      return [
        {
          id: 'weak-phrases',
          tone: 'warn',
          title: `有 ${weak.length} 句命中率低于 60%`,
          detail:
            '问题比较分散，不是单一方向偏高或偏低。先从最弱的几句开始，一句一句把音准稳定下来。',
          phraseIndexes: weak.slice(0, 3).map((phrase) => phrase.index),
        },
      ]
    }
  }
  return sorted
    .slice(0, 3)
    .map((candidate) => candidate.diagnosis)
    .map((diagnosis) =>
      diagnosis.phraseIndexes.length > 0
        ? diagnosis
        : { ...diagnosis, phraseIndexes: fallback },
    )
}
