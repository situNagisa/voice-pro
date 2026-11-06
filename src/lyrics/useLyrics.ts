import { useEffect, useMemo, useState } from 'react'
import { demoLyricSong } from '../demo/lyrics'
import type { PracticeRecordMeta } from '../state/records'
import type { LoadedSong } from '../state/session'
import { loadSongLyrics } from './storage'
import type { SongLyrics } from './types'

export interface SongLyricsState {
  lyrics: SongLyrics | null
  loading: boolean
  setLyrics: (lyrics: SongLyrics | null) => void
  reload: () => void
}

interface StoredLyrics {
  songId: string
  lyrics: SongLyrics | null
}

/** 练唱/循环页：示例歌取内置歌词，导入歌从歌曲库读取。 */
export function useSongLyrics(song: LoadedSong | null): SongLyricsState {
  const [stored, setStored] = useState<StoredLyrics | null>(null)
  const [revision, setRevision] = useState(0)
  const demoId = song?.demoId ?? null
  const demo = useMemo(
    () => (demoId ? demoLyricSong(demoId) : null),
    [demoId],
  )
  const songId = song && !song.demoId ? song.id : null
  const storedLyrics = stored && stored.songId === songId ? stored.lyrics : null

  useEffect(() => {
    if (!songId) return
    let active = true
    void loadSongLyrics(songId).then((value) => {
      if (active) setStored({ songId, lyrics: value })
    })
    return () => {
      active = false
    }
  }, [songId, revision])

  return {
    lyrics: demo ?? storedLyrics,
    loading: songId != null && stored?.songId !== songId,
    setLyrics: (lyrics) => {
      if (songId) setStored({ songId, lyrics })
    },
    reload: () => setRevision((value) => value + 1),
  }
}

/** 报告/回看页：记录里只有歌曲 id，示例歌重新取内置歌词。 */
export function useRecordLyrics(record: PracticeRecordMeta | null): SongLyrics | null {
  const demoId = record?.songKind === 'demo' ? record.songId : null
  const demo = useMemo(
    () => (demoId ? demoLyricSong(demoId) : null),
    [demoId],
  )
  const [stored, setStored] = useState<StoredLyrics | null>(null)
  const songId =
    record && record.songKind === 'imported' ? record.songId : null
  const storedLyrics = stored && stored.songId === songId ? stored.lyrics : null

  useEffect(() => {
    if (!songId) return
    let active = true
    void loadSongLyrics(songId).then((value) => {
      if (active) setStored({ songId, lyrics: value })
    })
    return () => {
      active = false
    }
  }, [songId])

  return demo ?? storedLyrics
}
