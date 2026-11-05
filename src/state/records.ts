import type { RawUserPoint } from '../audio/analysis'
import type { AudioSegment } from '../audio/recorder'
import type { LoopRange } from '../audio/player'
import type { Note } from '../core/types'

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

const DB_NAME = 'voicepro'
const DB_VERSION = 1
const META_STORE = 'records'
const DETAIL_STORE = 'details'
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      if (!db.objectStoreNames.contains(DETAIL_STORE)) {
        db.createObjectStore(DETAIL_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地记录数据库'))
  })
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败'))
  })
}

export async function saveRecord(record: PracticeRecord): Promise<void> {
  const db = await openDb()
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
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([META_STORE, DETAIL_STORE], 'readwrite')
    tx.objectStore(META_STORE).put(meta)
    tx.objectStore(DETAIL_STORE).put(detail)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('保存练习记录失败'))
    tx.onabort = () => reject(tx.error ?? new Error('保存练习记录被中止'))
  })
}

export async function listRecords(): Promise<PracticeRecordMeta[]> {
  try {
    const db = await openDb()
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
    const db = await openDb()
    const tx = db.transaction(META_STORE, 'readonly')
    return await requestToPromise(tx.objectStore(META_STORE).count())
  } catch {
    return 0
  }
}

export async function loadRecord(id: string): Promise<PracticeRecord | null> {
  const db = await openDb()
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
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([META_STORE, DETAIL_STORE], 'readwrite')
    tx.objectStore(META_STORE).delete(id)
    tx.objectStore(DETAIL_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('删除记录失败'))
  })
}

export async function clearRecords(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([META_STORE, DETAIL_STORE], 'readwrite')
    tx.objectStore(META_STORE).clear()
    tx.objectStore(DETAIL_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('清空记录失败'))
  })
}
