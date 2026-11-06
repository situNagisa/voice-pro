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

export async function saveRecord(record: PracticeRecord): Promise<void> {
  const db = await openAppDb()
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
}

export async function clearRecords(): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction([META_STORE, DETAIL_STORE], 'readwrite')
  tx.objectStore(META_STORE).clear()
  tx.objectStore(DETAIL_STORE).clear()
  await transactionDone(tx)
}
