import type { ReferenceMelody } from '../core/types'
import {
  SONG_AUDIO_STORE,
  SONG_MELODY_STORE,
  SONG_STORE,
  openAppDb,
  requestToPromise,
  transactionDone,
} from '../state/db'

/** 歌曲库列表只读这份轻量元信息，不会把 Blob 和上万帧旋律一起读出来。 */
export interface LibrarySongMeta {
  /** 文件内容哈希（SHA-256） */
  id: string
  name: string
  duration: number
  noteCount: number
  temporary: boolean
  warning?: string
  createdAt: number
  updatedAt: number
  sourceName: string
  sourceType: string
  sourceSize: number
  hasStems: boolean
  sampleRate: number
  channels: number
  /** 以下三项用于设置页展示占用空间 */
  sourceBytes: number
  audioBytes: number
  melodyBytes: number
}

export interface LibrarySongAudio {
  id: string
  source: Blob
  accompaniment: Blob | null
  vocals: Blob | null
}

export interface StoredSongMelody {
  id: string
  melody: ReferenceMelody
}

export interface LibraryUsage {
  count: number
  bytes: number
  sourceBytes: number
  audioBytes: number
  melodyBytes: number
}

export async function findLibrarySong(id: string): Promise<LibrarySongMeta | null> {
  const db = await openAppDb()
  const tx = db.transaction(SONG_STORE, 'readonly')
  const value = await requestToPromise(tx.objectStore(SONG_STORE).get(id))
  return (value as LibrarySongMeta | undefined) ?? null
}

export async function listLibrarySongs(): Promise<LibrarySongMeta[]> {
  try {
    const db = await openAppDb()
    const tx = db.transaction(SONG_STORE, 'readonly')
    const items = await requestToPromise(tx.objectStore(SONG_STORE).getAll())
    return (items as LibrarySongMeta[]).sort((a, b) => b.createdAt - a.createdAt)
  } catch (error) {
    console.warn('[voice-pro] 读取歌曲库失败', error)
    return []
  }
}

export async function saveLibrarySong(
  meta: LibrarySongMeta,
  melody: ReferenceMelody,
  audio: LibrarySongAudio,
): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(
    [SONG_STORE, SONG_MELODY_STORE, SONG_AUDIO_STORE],
    'readwrite',
  )
  tx.objectStore(SONG_STORE).put(meta)
  tx.objectStore(SONG_MELODY_STORE).put({ id: meta.id, melody } satisfies StoredSongMelody)
  tx.objectStore(SONG_AUDIO_STORE).put(audio)
  await transactionDone(tx)
}

export async function loadLibrarySongData(id: string): Promise<{
  meta: LibrarySongMeta
  melody: ReferenceMelody
  audio: LibrarySongAudio
} | null> {
  const db = await openAppDb()
  const tx = db.transaction(
    [SONG_STORE, SONG_MELODY_STORE, SONG_AUDIO_STORE],
    'readonly',
  )
  const [metaValue, melodyValue, audioValue] = await Promise.all([
    requestToPromise(tx.objectStore(SONG_STORE).get(id)),
    requestToPromise(tx.objectStore(SONG_MELODY_STORE).get(id)),
    requestToPromise(tx.objectStore(SONG_AUDIO_STORE).get(id)),
  ])
  const meta = metaValue as LibrarySongMeta | undefined
  const melodyRecord = melodyValue as StoredSongMelody | undefined
  const audio = audioValue as LibrarySongAudio | undefined
  if (!meta) return null
  if (!melodyRecord || !audio?.source) {
    throw new Error('歌曲缓存不完整，请删除后重新导入。')
  }
  return { meta, melody: melodyRecord.melody, audio }
}

export async function renameLibrarySong(id: string, name: string): Promise<void> {
  const meta = await findLibrarySong(id)
  if (!meta) return
  const db = await openAppDb()
  const tx = db.transaction(SONG_STORE, 'readwrite')
  tx.objectStore(SONG_STORE).put({ ...meta, name, updatedAt: Date.now() })
  await transactionDone(tx)
}

export async function deleteLibrarySong(id: string): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(
    [SONG_STORE, SONG_MELODY_STORE, SONG_AUDIO_STORE],
    'readwrite',
  )
  tx.objectStore(SONG_STORE).delete(id)
  tx.objectStore(SONG_MELODY_STORE).delete(id)
  tx.objectStore(SONG_AUDIO_STORE).delete(id)
  await transactionDone(tx)
}

export async function clearLibrary(): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(
    [SONG_STORE, SONG_MELODY_STORE, SONG_AUDIO_STORE],
    'readwrite',
  )
  tx.objectStore(SONG_STORE).clear()
  tx.objectStore(SONG_MELODY_STORE).clear()
  tx.objectStore(SONG_AUDIO_STORE).clear()
  await transactionDone(tx)
}

export async function getLibraryUsage(): Promise<LibraryUsage> {
  const songs = await listLibrarySongs()
  return songs.reduce<LibraryUsage>(
    (sum, song) => ({
      count: sum.count + 1,
      sourceBytes: sum.sourceBytes + song.sourceBytes,
      audioBytes: sum.audioBytes + song.audioBytes,
      melodyBytes: sum.melodyBytes + song.melodyBytes,
      bytes: sum.bytes + song.sourceBytes + song.audioBytes + song.melodyBytes,
    }),
    { count: 0, bytes: 0, sourceBytes: 0, audioBytes: 0, melodyBytes: 0 },
  )
}

export function estimateMelodyBytes(melody: ReferenceMelody): number {
  try {
    return new Blob([JSON.stringify(melody)]).size
  } catch {
    return melody.frames.length * 24 + melody.notes.length * 24
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
