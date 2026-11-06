/**
 * “记录 → 我的进步”需要的本地统计。
 * 全部只读 IndexedDB 里已有的练习元信息，诊断汇总才会按需读取少数几条明细。
 */
import { evaluateSession } from '../audio/analysis'
import { diagnoseSession } from '../audio/diagnosis'
import type { DiagnosisTone } from '../audio/diagnosis'
import { recordMelody } from '../audio/review'
import type { PracticeRecordMeta } from './records'
import { loadRecord } from './records'

export type ProgressPeriod = 7 | 30

export interface DailyProgress {
  dayStart: number
  /** 横轴第几天（0 是窗口第一天） */
  index: number
  count: number
  seconds: number
  hitRate: number | null
}

export interface PeriodSummary {
  days: ProgressPeriod
  since: number
  count: number
  seconds: number
  activeDays: number
  scoredCount: number
  avgHitRate: number | null
  bestScore: number | null
  avgScore: number | null
  daily: DailyProgress[]
  /** 有命中率数据的日点，供折线图使用 */
  hitTrend: { index: number; value: number; label: string }[]
  /** 最近一天与最早一天的命中率差（百分点），不足两天为 null */
  trendDelta: number | null
}

export interface VoiceRangeInfo {
  lowMidi: number
  highMidi: number
  medianMidi: number
  records: number
  samples: number
  /** 这些练习实际练过的秒数（优先按录音分段累计） */
  seconds: number
  /** 旧记录没有真实最低/最高音，用 10%–90% 分位近似 */
  approximate: boolean
}

export interface SongGroup {
  songId: string
  songName: string
  songKind: 'demo' | 'imported'
  attempts: PracticeRecordMeta[]
  bestScore: number | null
  latest: PracticeRecordMeta
}

export interface DiagnosisAggregate {
  id: string
  label: string
  advice: string
  tone: DiagnosisTone
  count: number
}

export interface DiagnosisSummary {
  /** 真正读入并分析的记录数 */
  analyzed: number
  /** 达到有效音高门槛、能参与归类的记录数 */
  usable: number
  items: DiagnosisAggregate[]
}

export function practiceSeconds(record: PracticeRecordMeta): number {
  const seconds = record.practicedSeconds ?? record.duration
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function periodDayStarts(days: ProgressPeriod, now: number): number[] {
  const today = startOfDay(now)
  const starts: number[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    starts.push(date.getTime())
  }
  return starts
}

export function filterByPeriod(
  records: PracticeRecordMeta[],
  days: ProgressPeriod,
  now = Date.now(),
): PracticeRecordMeta[] {
  const since = periodDayStarts(days, now)[0]
  return records.filter((record) => record.createdAt >= since)
}

export function summarizePeriod(
  records: PracticeRecordMeta[],
  days: ProgressPeriod,
  now = Date.now(),
): PeriodSummary {
  const dayStarts = periodDayStarts(days, now)
  const indexByDay = new Map(dayStarts.map((start, index) => [start, index]))
  const daily: DailyProgress[] = dayStarts.map((dayStart, index) => ({
    dayStart,
    index,
    count: 0,
    seconds: 0,
    hitRate: null,
  }))
  const dayHits = new Map<number, { sum: number; count: number }>()
  const inPeriod = records.filter((record) => record.createdAt >= dayStarts[0])
  let count = 0
  let seconds = 0
  let hitSum = 0
  let hitCount = 0
  let bestScore: number | null = null
  let scoreSum = 0
  let scoreCount = 0

  for (const record of inPeriod) {
    const index = indexByDay.get(startOfDay(record.createdAt))
    if (index == null) continue
    count += 1
    const bucket = daily[index]
    bucket.count += 1
    const spent = practiceSeconds(record)
    bucket.seconds += spent
    seconds += spent

    if (record.hitRate != null && Number.isFinite(record.hitRate)) {
      const rate = Math.max(0, Math.min(1, record.hitRate))
      const acc = dayHits.get(index) ?? { sum: 0, count: 0 }
      acc.sum += rate
      acc.count += 1
      dayHits.set(index, acc)
      hitSum += rate
      hitCount += 1
    }
    if (record.score != null && Number.isFinite(record.score)) {
      bestScore = bestScore == null ? record.score : Math.max(bestScore, record.score)
      scoreSum += record.score
      scoreCount += 1
    }
  }

  for (const [index, acc] of dayHits) {
    daily[index].hitRate = acc.count > 0 ? acc.sum / acc.count : null
  }

  const hitTrend = daily
    .filter((bucket) => bucket.hitRate != null)
    .map((bucket) => ({
      index: bucket.index,
      value: Math.round((bucket.hitRate ?? 0) * 100),
      label: dateLabel(bucket.dayStart),
    }))

  return {
    days,
    since: dayStarts[0],
    count,
    seconds,
    activeDays: daily.filter((bucket) => bucket.count > 0).length,
    scoredCount: hitCount,
    avgHitRate: hitCount > 0 ? hitSum / hitCount : null,
    bestScore,
    avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null,
    daily,
    hitTrend,
    trendDelta:
      hitTrend.length >= 2 ? hitTrend[hitTrend.length - 1].value - hitTrend[0].value : null,
  }
}

export function voiceRangeOf(records: PracticeRecordMeta[]): VoiceRangeInfo | null {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  let samples = 0
  let seconds = 0
  let recordsUsed = 0
  let approximate = false
  const medians: { midi: number; weight: number }[] = []

  for (const record of records) {
    const recordLow = record.voiceMinMidi ?? record.voiceLowMidi
    const recordHigh = record.voiceMaxMidi ?? record.voiceHighMidi
    if (recordLow == null || recordHigh == null) continue
    if (!Number.isFinite(recordLow) || !Number.isFinite(recordHigh)) continue
    if (record.voiceMinMidi == null || record.voiceMaxMidi == null) approximate = true
    low = Math.min(low, recordLow)
    high = Math.max(high, recordHigh)
    samples += record.voiceSamples ?? 1
    seconds += practiceSeconds(record)
    recordsUsed += 1
    if (record.voiceMedianMidi != null) {
      medians.push({ midi: record.voiceMedianMidi, weight: record.voiceSamples ?? 1 })
    }
  }
  if (recordsUsed === 0 || !Number.isFinite(low) || !Number.isFinite(high)) return null

  medians.sort((a, b) => a.midi - b.midi)
  const totalWeight = medians.reduce((sum, item) => sum + item.weight, 0)
  let median = (low + high) / 2
  let accumulated = 0
  for (const item of medians) {
    accumulated += item.weight
    if (accumulated >= totalWeight / 2) {
      median = item.midi
      break
    }
  }
  return {
    lowMidi: low,
    highMidi: high,
    medianMidi: median,
    records: recordsUsed,
    samples,
    seconds,
    approximate,
  }
}

export function groupRecordsBySong(records: PracticeRecordMeta[]): SongGroup[] {
  const groups = new Map<string, PracticeRecordMeta[]>()
  for (const record of records) {
    if (record.songKind === 'exercise') continue
    const list = groups.get(record.songId)
    if (list) list.push(record)
    else groups.set(record.songId, [record])
  }
  const result: SongGroup[] = []
  for (const [songId, attempts] of groups) {
    const sorted = attempts.slice().sort((a, b) => a.createdAt - b.createdAt)
    let bestScore: number | null = null
    for (const attempt of sorted) {
      if (attempt.score == null) continue
      bestScore = bestScore == null ? attempt.score : Math.max(bestScore, attempt.score)
    }
    const latest = sorted[sorted.length - 1]
    result.push({
      songId,
      songName: latest.songName,
      songKind: latest.songKind === 'demo' ? 'demo' : 'imported',
      attempts: sorted,
      bestScore,
      latest,
    })
  }
  return result.sort((a, b) => b.latest.createdAt - a.latest.createdAt)
}

const DIAGNOSIS_LABELS: Record<string, { label: string; advice: string }> = {
  'high-flat': { label: '高音偏低', advice: '高音提前把气送上去，别用喉部挤。' },
  'high-sharp': { label: '高音偏高', advice: '高音收一点力气，先轻声听住目标音。' },
  'overall-flat': { label: '整体偏低', advice: '把气息托住，别让每个音尾往下掉。' },
  'overall-sharp': { label: '整体偏高', advice: '起音轻一点，让音落到目标中间。' },
  'long-drop': { label: '长音后半段下滑', advice: '长音保持气息，结尾前再收，不要一开口就松气。' },
  'late-onset': { label: '起音偏晚', advice: '预备拍上提前吸气，拍点一到直接出声。' },
  'weak-phrases': { label: '多句命中率偏低', advice: '逐句循环，先把最弱的两三句练稳。' },
}

interface RawDiagnosisSummary {
  analyzed: number
  usable: number
  counts: Map<string, { count: number; tone: DiagnosisTone }>
}

const diagnosisCache = new Map<string, DiagnosisSummary>()

async function analyzeRecords(
  records: PracticeRecordMeta[],
  limit: number,
): Promise<RawDiagnosisSummary> {
  const selected = records.slice(0, limit)
  const counts = new Map<string, { count: number; tone: DiagnosisTone }>()
  let analyzed = 0
  let usable = 0

  for (const meta of selected) {
    let record
    try {
      record = await loadRecord(meta.id)
    } catch {
      continue
    }
    if (!record) continue
    analyzed += 1
    try {
      const melody = recordMelody(record)
      const report = evaluateSession(record.points, melody, {
        transpose: record.transpose,
        octaveAlign: record.octaveAlign,
        tolerance: record.tolerance,
      })
      if (report.validFrames < 40) continue
      usable += 1
      for (const diagnosis of diagnoseSession(record, melody, report)) {
        const current = counts.get(diagnosis.id)
        counts.set(diagnosis.id, {
          count: (current?.count ?? 0) + 1,
          tone: diagnosis.tone,
        })
      }
    } catch (error) {
      console.warn('[voice-pro] 汇总问题诊断失败', error)
    }
  }
  return { analyzed, usable, counts }
}

/**
 * 汇总时间窗口内最近若干首歌曲练习的“主要问题”。
 * 练声小课不参与：它的目标和歌曲不是一回事，混在一起会误导读数。
 */
export async function loadDiagnosisSummary(
  records: PracticeRecordMeta[],
  days: ProgressPeriod,
  now = Date.now(),
): Promise<DiagnosisSummary | null> {
  const pool = filterByPeriod(records, days, now)
    .filter((record) => record.songKind !== 'exercise')
    .slice(0, 12)
  if (pool.length === 0) return null
  const key = `${days}:${pool.map((record) => record.id).join(',')}`
  const cached = diagnosisCache.get(key)
  if (cached) return cached

  const raw = await analyzeRecords(pool, pool.length)
  const items: DiagnosisAggregate[] = [...raw.counts.entries()]
    .map(([id, value]) => {
      const copy = DIAGNOSIS_LABELS[id] ?? {
        label: id,
        advice: '回看对应的句子，逐句放慢练习。',
      }
      return {
        id,
        label: copy.label,
        advice: copy.advice,
        tone: value.tone,
        count: value.count,
      }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  const summary: DiagnosisSummary = { analyzed: raw.analyzed, usable: raw.usable, items }
  if (diagnosisCache.size >= 6) {
    const oldest = diagnosisCache.keys().next().value
    if (oldest != null) diagnosisCache.delete(oldest)
  }
  diagnosisCache.set(key, summary)
  return summary
}
