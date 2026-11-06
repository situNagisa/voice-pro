import type { RawUserPoint } from '../audio/analysis'
import type { AudioSegment } from '../audio/recorder'
import type { LoopRange } from '../audio/player'
import type { Note } from '../core/types'
import {
  RECORD_DETAIL_STORE as DETAIL_STORE,
  RECORD_STORE as META_STORE,
  openAppDb,
  requestToPromise,
  transactionDone,
} from './db'

export type SongKind = 'demo' | 'imported'

/** 列表页只读这份轻量元信息，避免把录音和上万条轨迹一次读出来。 */
export interface PracticeRecordMeta {
  id: string
  createdAt: number
  songId: string
  songName: string
  songKind: SongKind
  duration: number
  score: number | null
  hitRate: number | null
  tolerance: number
  /** 用户实际唱出的音高分布（已按本次移调还原到原调），用于推荐调性 */
  voiceSamples?: number
  voiceLowMidi?: number
  voiceMedianMidi?: number
  voiceHighMidi?: number
}

/** 把多条练习记录的音高分布汇总成一个舒适音域。 */
export interface VoiceRangeSummary {
  records: number
  samples: number
  lowMidi: number
  medianMidi: number
  highMidi: number
}

export interface PracticeRecord extends PracticeRecordMeta {
  transpose: number
  octaveAlign: boolean
  points: RawUserPoint[]
  melodyNotes: Note[]
  melodyDuration: number
  voice: Blob | null
  voiceMime: string | null
  segments: AudioSegment[]
  loop: LoopRange | null
}

interface RecordDetail {
  id: string
  transpose: number
  octaveAlign: boolean
  points: RawUserPoint[]
  melodyNotes: Note[]
  melodyDuration: number
  voice: Blob | null
  voiceMime: string | null
  segments: AudioSegment[]
  loop: LoopRange | null
}

let voiceStatsCache: Promise<VoiceRangeSummary | null> | null = null

function quantileSorted(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = (sorted.length - 1) * ratio
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  if (lo === hi) return sorted[lo]
  const weight = index - lo
  return sorted[lo] * (1 - weight) + sorted[hi] * weight
}

function summarizeVoice(
  points: RawUserPoint[],
  transpose: number,
): Pick<
  PracticeRecordMeta,
  'voiceSamples' | 'voiceLowMidi' | 'voiceMedianMidi' | 'voiceHighMidi'
> {
  const values = points
    .filter((point) => point.clarity >= 0.8 && Number.isFinite(point.midi))
    .map((point) => point.midi - transpose)
    .sort((a, b) => a - b)
  if (values.length < 10) return {}
  return {
    voiceSamples: values.length,
    voiceLowMidi: quantileSorted(values, 0.1),
    voiceMedianMidi: quantileSorted(values, 0.5),
    voiceHighMidi: quantileSorted(values, 0.9),
  }
}

/**
 * 汇总历史练习里“实际唱出来的音高”。
 * 新记录直接在元信息里带分布；旧记录按需读取最近几条明细补算。
 */
export async function loadVoiceStats(): Promise<VoiceRangeSummary | null> {
  if (voiceStatsCache) return voiceStatsCache
  voiceStatsCache = (async () => {
    const metas = await listRecords()
    const parts: {
      samples: number
      low: number
      median: number
      high: number
    }[] = []
    let missing = 0
    for (const meta of metas.slice(0, 30)) {
      if (meta.voiceSamples && meta.voiceMedianMidi != null) {
        parts.push({
          samples: meta.voiceSamples,
          low: meta.voiceLowMidi ?? meta.voiceMedianMidi,
          median: meta.voiceMedianMidi,
          high: meta.voiceHighMidi ?? meta.voiceMedianMidi,
        })
        continue
      }
      if (missing >= 6) continue
      missing += 1
      try {
        const record = await loadRecord(meta.id)
        if (!record) continue
        const summary = summarizeVoice(record.points, record.transpose)
        if (
          summary.voiceSamples &&
          summary.voiceMedianMidi != null
        ) {
          parts.push({
            samples: summary.voiceSamples,
            low: summary.voiceLowMidi ?? summary.voiceMedianMidi,
            median: summary.voiceMedianMidi,
            high: summary.voiceHighMidi ?? summary.voiceMedianMidi,
          })
        }
      } catch {
        // 单条记录读不出来不影响整体推荐
      }
    }
    if (parts.length === 0) return null
    parts.sort((a, b) => a.median - b.median)
    const samples = parts.reduce((sum, part) => sum + part.samples, 0)
    let accumulated = 0
    let median = parts[0].median
    for (const part of parts) {
      accumulated += part.samples
      if (accumulated >= samples / 2) {
        median = part.median
        break
      }
    }
    return {
      records: parts.length,
      samples,
      lowMidi: Math.min(...parts.map((part) => part.low)),
      medianMidi: median,
      highMidi: Math.max(...parts.map((part) => part.high)),
    }
  })()
  return voiceStatsCache
}

export async function saveRecord(record: PracticeRecord): Promise<void> {
  const db = await openAppDb()
  const summary = summarizeVoice(record.points, record.transpose)
  const meta: PracticeRecordMeta = {
    id: record.id,
    createdAt: record.createdAt,
    songId: record.songId,
    songName: record.songName,
    songKind: record.songKind,
    duration: record.duration,
    score: record.score,
    hitRate: record.hitRate,
    tolerance: record.tolerance,
    ...summary,
  }
  const detail: RecordDetail = {
    id: record.id,
    transpose: record.transpose,
    octaveAlign: record.octaveAlign,
    points: record.points,
    melodyNotes: record.melodyNotes,
    melodyDuration: record.melodyDuration,
    voice: record.voice,
    voiceMime: record.voiceMime,
    segments: record.segments,
    loop: record.loop,
  }
  const tx = db.transaction([META_STORE, DETAIL_STORE], 'readwrite')
  tx.objectStore(META_STORE).put(meta)
  tx.objectStore(DETAIL_STORE).put(detail)
  await transactionDone(tx)
  voiceStatsCache = null
}

export async function listRecords(): Promise<PracticeRecordMeta[]> {
  try {
    const db = await openAppDb()
    const tx = db.transaction(META_STORE, 'readonly')
    const items = await requestToPromise(tx.objectStore(META_STORE).getAll())
    return (items as PracticeRecordMeta[]).sort((a, b) => b.createdAt - a.createdAt)
  } catch (error) {
    console.warn('[voice-pro] 读取练习记录失败', error)
    return []
  }
}

export async function countRecords(): Promise<number> {
  try {
    const db = await openAppDb()
    const tx = db.transaction(META_STORE, 'readonly')
    return await requestToPromise(tx.objectStore(META_STORE).count())
  } catch {
    return 0
  }
}

export async function loadRecord(id: string): Promise<PracticeRecord | null> {
  const db = await openAppDb()
  const tx = db.transaction([META_STORE, DETAIL_STORE], 'readonly')
  const metaRequest = tx.objectStore(META_STORE).get(id)
  const detailRequest = tx.objectStore(DETAIL_STORE).get(id)
  const [metaValue, detailValue] = await Promise.all([
    requestToPromise(metaRequest),
    requestToPromise(detailRequest),
  ])
  const meta = metaValue as PracticeRecordMeta | undefined
  const detail = detailValue as RecordDetail | undefined
  if (!meta || !detail) return null
  return { ...meta, ...detail }
}

export async function deleteRecord(id: string): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction([META_STORE, DETAIL_STORE], 'readwrite')
  tx.objectStore(META_STORE).delete(id)
  tx.objectStore(DETAIL_STORE).delete(id)
  await transactionDone(tx)
  voiceStatsCache = null
}

export async function clearRecords(): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction([META_STORE, DETAIL_STORE], 'readwrite')
  tx.objectStore(META_STORE).clear()
  tx.objectStore(DETAIL_STORE).clear()
  await transactionDone(tx)
  voiceStatsCache = null
}
