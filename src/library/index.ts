import type { LoadedSong } from '../state/session'
import { decodeBlob } from './audioStore'
import { loadLibrarySongData } from './db'

export type {
  LibrarySongAudio,
  LibrarySongMeta,
  LibraryUsage,
} from './db'
export {
  clearLibrary,
  deleteLibrarySong,
  estimateMelodyBytes,
  findLibrarySong,
  formatBytes,
  getLibraryUsage,
  listLibrarySongs,
  renameLibrarySong,
  saveLibrarySong,
} from './db'
export { hashFile } from './hash'
export {
  acknowledgeLibraryJob,
  cancelLibraryImport,
  discardLibraryJob,
  getLibraryJobSnapshot,
  restoreLibraryJob,
  resumeLibraryImport,
  startLibraryImport,
  subscribeLibraryJob,
} from './jobs'
export type { LibraryJobSnapshot, LibraryJobStatus } from './jobs'

/**
 * 从歌曲库打开一首歌：只解码原曲和分轨，不重新分析。
 * 4 分钟 mp3 解码通常不到 1 秒，相比 80 秒的分离可以算秒开。
 */
export async function loadLibrarySong(id: string): Promise<LoadedSong | null> {
  const data = await loadLibrarySongData(id)
  if (!data) return null
  const { meta, melody, audio } = data

  const ctx = new AudioContext({ latencyHint: 'playback' })
  try {
    const sourcePromise = decodeBlob(ctx, audio.source).catch((error: unknown) => {
      throw new Error(
        error instanceof Error
          ? `原曲解码失败：${error.message}`
          : '原曲解码失败，缓存可能已损坏。',
      )
    })
    const accompanimentPromise = audio.accompaniment
      ? decodeBlob(ctx, audio.accompaniment).catch((error: unknown) => {
          console.warn('[voice-pro] 伴奏解码失败，已忽略分轨', error)
          return null
        })
      : Promise.resolve(null)
    const vocalsPromise = audio.vocals
      ? decodeBlob(ctx, audio.vocals).catch((error: unknown) => {
          console.warn('[voice-pro] 人声分轨解码失败，已忽略分轨', error)
          return null
        })
      : Promise.resolve(null)

    const [buffer, accompaniment, vocals] = await Promise.all([
      sourcePromise,
      accompanimentPromise,
      vocalsPromise,
    ])
    return {
      id: meta.id,
      name: meta.name,
      buffer,
      melody,
      temporary: meta.temporary,
      warning: meta.warning,
      importedAt: meta.createdAt,
      accompaniment,
      vocals,
    }
  } finally {
    void ctx.close().catch(() => undefined)
  }
}
