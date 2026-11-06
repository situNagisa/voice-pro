import type { Note } from '../core/types'
import { clamp } from './pitch'
import type { VoiceRangeSummary } from '../state/records'

export interface KeyAdvice {
  sufficient: boolean
  /** 建议的移调半音数，-6..6 */
  semitones: number
  /** 用户舒适音域相对原唱的中位差（已做八度折算） */
  diff: number
  songMedian: number | null
  headline: string
  detail: string
}

/** 以时长为权重取旋律的中位音高。 */
export function melodyMedian(notes: Note[]): number | null {
  const weighted = notes
    .filter((note) => note.end > note.start)
    .map((note) => ({ midi: note.midi, weight: note.end - note.start }))
    .sort((a, b) => a.midi - b.midi)
  const total = weighted.reduce((sum, item) => sum + item.weight, 0)
  if (total <= 0) return null
  let accumulated = 0
  for (const item of weighted) {
    accumulated += item.weight
    if (accumulated >= total / 2) return item.midi
  }
  return weighted[weighted.length - 1]?.midi ?? null
}

/**
 * 把“用户比原唱高/低多少”折算到移调范围。
 * 接近一个八度的差异视为八度选择，不额外移调。
 */
function foldOctave(diff: number): number {
  const octave = Math.round(diff / 12)
  if (octave !== 0) {
    const folded = diff - octave * 12
    if (Math.abs(folded) <= 2.5) return folded
  }
  return clamp(diff, -6, 6)
}

/** 至少要有 2 次练习（或一次很长的练习）才给建议，避免一两个音就下结论。 */
export function hasEnoughVoiceHistory(stats: VoiceRangeSummary | null): stats is VoiceRangeSummary {
  return stats != null && stats.samples >= 1500 && (stats.records >= 2 || stats.samples >= 3000)
}

export function adviseKey(
  stats: VoiceRangeSummary | null,
  notes: Note[],
): KeyAdvice {
  const songMedian = melodyMedian(notes)
  if (!hasEnoughVoiceHistory(stats) || songMedian == null) {
    return {
      sufficient: false,
      semitones: 0,
      diff: 0,
      songMedian,
      headline: '练几次后，再为你推荐调性',
      detail:
        stats == null
          ? '完成几次跟唱练习后，会根据你实际唱出的音高分布，算出更适合你的调。'
          : `目前只有 ${stats.records} 次练习、约 ${Math.round(stats.samples / 10)} 秒有效歌声；再多唱一两遍就能判断。`,
    }
  }

  const rawDiff = stats.medianMidi - songMedian
  const folded = foldOctave(rawDiff)
  const semitones = clamp(Math.round(folded), -6, 6)
  const amount = Math.abs(semitones)
  if (semitones === 0) {
    return {
      sufficient: true,
      semitones: 0,
      diff: folded,
      songMedian,
      headline: '你的舒适音域接近原唱，建议保持原调',
      detail: `根据 ${stats.records} 次练习、约 ${Math.round(stats.samples / 10)} 秒有效歌声统计；按八度对齐折算后，与原唱中位音高只差约 ${Math.abs(folded).toFixed(1)} 个半音。`,
    }
  }

  const lower = semitones < 0
  return {
    sufficient: true,
    semitones,
    diff: folded,
    songMedian,
    headline: `你的舒适音域比原唱${lower ? '低' : '高'}约 ${amount} 个半音，建议 ${semitones > 0 ? '+' : ''}${semitones}`,
    detail: `根据 ${stats.records} 次练习、约 ${Math.round(stats.samples / 10)} 秒有效歌声统计，你唱出的中位音高是 ${stats.medianMidi.toFixed(1)}（MIDI），这首歌是 ${songMedian.toFixed(1)}。按八度对齐折算后，用 ${semitones > 0 ? '+' : ''}${semitones} 会让参考旋律与伴奏一起移动，唱起来更接近你的舒适音域。`,
  }
}
