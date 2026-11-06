import { listDemoSongs } from '../demo'
import { renderDemoSong, renderDemoStems } from '../demo'
import { DEMO_SONG_SPECS } from '../demo/songs'
import type { Note, ReferenceMelody } from '../core/types'
import type { LoadedSong } from './session'

/** 直接把内置乐谱换算成参考旋律，示例歌不需要再做一次人声提取。 */
export function demoMelodyNotes(id: string): { notes: Note[]; duration: number } | null {
  const spec = DEMO_SONG_SPECS.find((song) => song.id === id)
  if (!spec) return null
  const beatSec = 60 / spec.bpm
  const notes = spec.melody.map((note) => ({
    start: note.beat * beatSec,
    end: (note.beat + note.beats) * beatSec - 0.02,
    midi: note.midi,
  }))
  const end = spec.melody.reduce(
    (max, note) => Math.max(max, (note.beat + note.beats) * beatSec),
    0,
  )
  return { notes, duration: end + 1.2 }
}

export function demoMelody(id: string, duration: number): ReferenceMelody {
  const derived = demoMelodyNotes(id)
  return {
    duration,
    hop: 0.01,
    frames: [],
    notes: derived?.notes ?? [],
  }
}

/** 加载示例歌：本地合成原曲，并从乐谱生成参考旋律。 */
export async function loadDemoSong(id: string): Promise<LoadedSong> {
  const meta = listDemoSongs().find((song) => song.id === id)
  if (!meta) throw new Error('没有找到这首示例歌')
  const spec = DEMO_SONG_SPECS.find((song) => song.id === id)
  const [buffer, stems] = await Promise.all([
    renderDemoSong(id),
    renderDemoStems(id).catch((error: unknown) => {
      console.warn('[voice-pro] 示例歌分轨合成失败，只提供原曲', error)
      return null
    }),
  ])
  return {
    id: `demo-${id}`,
    demoId: id,
    name: meta.title,
    buffer,
    melody: demoMelody(id, buffer.duration),
    temporary: false,
    importedAt: Date.now(),
    accompaniment: stems?.accompaniment ?? null,
    vocals: stems?.vocals ?? null,
    bpm: spec?.bpm,
  }
}
