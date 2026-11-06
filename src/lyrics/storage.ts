import {
  SONG_LYRICS_STORE,
  openAppDb,
  requestToPromise,
  transactionDone,
} from '../state/db'
import type { LyricLine, SongLyrics } from './types'

function isLine(value: unknown): value is LyricLine {
  if (!value || typeof value !== 'object') return false
  const line = value as Record<string, unknown>
  return (
    typeof line.text === 'string' &&
    line.text.trim().length > 0 &&
    typeof line.start === 'number' &&
    Number.isFinite(line.start) &&
    typeof line.end === 'number' &&
    Number.isFinite(line.end)
  )
}

function normalizeStored(value: unknown, songId: string): SongLyrics | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.songId !== songId) return null
  if (!Array.isArray(record.lines)) return null
  const lines = record.lines.filter(isLine).map((line) => ({
    ...line,
    words: Array.isArray(line.words)
      ? line.words.filter(
          (word) =>
            word &&
            typeof word.text === 'string' &&
            typeof word.start === 'number' &&
            typeof word.end === 'number',
        )
      : undefined,
  }))
  const source =
    record.source === 'lrc' || record.source === 'text' || record.source === 'demo'
      ? record.source
      : 'text'
  return {
    songId,
    lines,
    source,
    offsetMs: typeof record.offsetMs === 'number' ? record.offsetMs : undefined,
    title: typeof record.title === 'string' ? record.title : undefined,
    artist: typeof record.artist === 'string' ? record.artist : undefined,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
  }
}

export async function loadSongLyrics(songId: string): Promise<SongLyrics | null> {
  try {
    const db = await openAppDb()
    const tx = db.transaction(SONG_LYRICS_STORE, 'readonly')
    const value = await requestToPromise(tx.objectStore(SONG_LYRICS_STORE).get(songId))
    return normalizeStored(value, songId)
  } catch (error) {
    console.warn('[voice-pro] 读取歌词失败', error)
    return null
  }
}

export async function saveSongLyrics(lyrics: SongLyrics): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(SONG_LYRICS_STORE, 'readwrite')
  tx.objectStore(SONG_LYRICS_STORE).put(lyrics)
  await transactionDone(tx)
}

export async function deleteSongLyrics(songId: string): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(SONG_LYRICS_STORE, 'readwrite')
  tx.objectStore(SONG_LYRICS_STORE).delete(songId)
  await transactionDone(tx)
}
