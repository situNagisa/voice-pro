export interface RecentSong {
  id: string
  name: string
  duration: number
  noteCount: number
  temporary: boolean
  importedAt: number
}

const STORAGE_KEY = 'voicepro.recent.v1'
const MAX_RECENT = 8

function isRecentSong(value: unknown): value is RecentSong {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.duration === 'number' &&
    typeof item.noteCount === 'number' &&
    typeof item.temporary === 'boolean' &&
    typeof item.importedAt === 'number'
  )
}

export function loadRecentSongs(): RecentSong[] {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return []
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentSong).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

function persist(list: RecentSong[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT)))
  } catch {
    // 忽略存储失败
  }
}

export function addRecentSong(song: RecentSong): RecentSong[] {
  const current = loadRecentSongs().filter(
    (item) =>
      item.id !== song.id &&
      !(item.name === song.name && Math.abs(item.duration - song.duration) < 0.5),
  )
  const next = [song, ...current].slice(0, MAX_RECENT)
  persist(next)
  return next
}

export function removeRecentSong(id: string): RecentSong[] {
  const next = loadRecentSongs().filter((item) => item.id !== id)
  persist(next)
  return next
}

export function clearRecentSongs(): RecentSong[] {
  persist([])
  return []
}
