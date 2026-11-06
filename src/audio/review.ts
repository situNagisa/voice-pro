import type { LoopRange } from '../audio/player'
import type { Note, ReferenceMelody } from '../core/types'
import type { PracticeRecord } from '../state/records'
import { referenceMidiAt, compareToTarget, pointTranspose } from './analysis'
import type { PitchComparison, RawUserPoint } from './analysis'
import { clamp } from './pitch'

export interface ReadingAt {
  point: RawUserPoint
  time: number
  targetMidi: number | null
  comparison: PitchComparison | null
}

/** 找到时间点附近最近的一个有效音高采样。 */
export function nearestPoint(
  points: RawUserPoint[],
  time: number,
  window = 0.22,
): RawUserPoint | null {
  if (points.length === 0) return null
  let lo = 0
  let hi = points.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t < time) lo = mid + 1
    else hi = mid - 1
  }
  let best: RawUserPoint | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (let i = Math.max(0, lo - 2); i <= Math.min(points.length - 1, lo + 2); i++) {
    const delta = Math.abs(points[i].t - time)
    if (delta < bestDelta) {
      bestDelta = delta
      best = points[i]
    }
  }
  return best && bestDelta <= window ? best : null
}

export function readingAt(
  points: RawUserPoint[],
  time: number,
  melody: ReferenceMelody | null,
  options: { transpose: number; octaveAlign: boolean; tolerance: number },
  window = 0.22,
): ReadingAt | null {
  const point = nearestPoint(points, time, window)
  if (!point) return null
  const targetMidi = melody
    ? referenceMidiAt(melody, point.t, options.transpose)
    : null
  // 中途改调时，每个点用采样当时的移调来比较；显示的“目标”仍是当前调。
  const shift = pointTranspose(point, options.transpose)
  const comparison =
    targetMidi == null
      ? null
      : compareToTarget(
          point.midi + (options.transpose - shift),
          targetMidi,
          options.octaveAlign,
          options.tolerance,
        )
  return { point, time: point.t, targetMidi, comparison }
}

/** 把歌曲时间换算到录音文件里的偏移；暂停过的段落会被跳过。 */
export function voiceOffsetAt(
  segments: PracticeRecord['segments'],
  songTime: number,
): number | null {
  for (const segment of segments) {
    if (segment.duration <= 0) continue
    if (songTime >= segment.songStart - 0.02 && songTime <= segment.songStart + segment.duration + 0.02) {
      return segment.voiceStart + clamp(songTime - segment.songStart, 0, segment.duration)
    }
  }
  // 落在段落之间（例如暂停处）时，取最近一段的末尾，方便回放时仍能听到声音
  let best: { distance: number; offset: number } | null = null
  for (const segment of segments) {
    if (segment.duration <= 0) continue
    const endSong = segment.songStart + segment.duration
    const distance = songTime < segment.songStart
      ? segment.songStart - songTime
      : songTime - endSong
    if (distance >= 0 && (!best || distance < best.distance)) {
      best = {
        distance,
        offset: songTime < segment.songStart
          ? segment.voiceStart
          : segment.voiceStart + segment.duration,
      }
    }
  }
  return best ? best.offset : null
}

/** 录音里可用的歌曲范围，用于把时间轴拖动限制在已唱过的部分。 */
export function recordedRange(
  segments: PracticeRecord['segments'],
  fallbackEnd: number,
): { start: number; end: number } {
  if (segments.length === 0) return { start: 0, end: fallbackEnd }
  const start = Math.min(...segments.map((segment) => segment.songStart))
  const end = Math.max(...segments.map((segment) => segment.songStart + segment.duration))
  return { start: Math.max(0, start - 0.3), end: end + 0.3 }
}

/** 记录里的旋律是精简版（不含逐帧数据），可以直接交给音高比较函数。 */
export function recordMelody(record: PracticeRecord): ReferenceMelody {
  return {
    duration: record.melodyDuration,
    hop: 0.01,
    frames: [],
    notes: record.melodyNotes as Note[],
  }
}

export function loopLabel(loop: LoopRange | null): string {
  if (!loop) return '完整歌曲'
  return `循环 ${loop.start.toFixed(1)}s – ${loop.end.toFixed(1)}s`
}
