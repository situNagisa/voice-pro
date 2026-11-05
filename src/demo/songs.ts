/**
 * 内置示例歌曲的乐谱数据。
 * 旋律均按"拍"描述，合成时再按 BPM 换算成秒；音高用 MIDI 编号（C4 = 60）。
 * 《小星星》《欢乐颂》为公版旋律，第三首为原创练习曲。
 */

export type Vowel = 'a' | 'o' | 'e'

export interface MelodyNote {
  /** 相对歌曲开头的拍号位置 */
  beat: number
  /** 时值（拍） */
  beats: number
  /** MIDI 音高 */
  midi: number
  /** 指定元音；不填时由合成器按音长选择（长音 o，短音 a） */
  vowel?: Vowel
}

export interface ChordSpec {
  beat: number
  beats: number
  /** 和弦三个音的 MIDI，依次放在左、中、右三个声像位置 */
  tones: readonly [number, number, number]
  /** 低音 MIDI */
  bass: number
}

export interface DemoSongSpec {
  id: string
  title: string
  desc: string
  bpm: number
  beatsPerBar: number
  /** 乐曲总拍数（不含末尾混响/释放尾巴） */
  totalBeats: number
  melody: MelodyNote[]
  chords: ChordSpec[]
}

/** 结尾留一点释放尾巴，避免乐曲被硬切 */
export const DEMO_TAIL_SECONDS = 1.2

export function songDurationSec(spec: DemoSongSpec): number {
  return (spec.totalBeats * 60) / spec.bpm + DEMO_TAIL_SECONDS
}

type NoteSpec = readonly [offset: number, beats: number, midi: number, vowel?: Vowel]

function notes(startBeat: number, specs: readonly NoteSpec[]): MelodyNote[] {
  return specs.map(([offset, beats, midi, vowel]) =>
    vowel
      ? { beat: startBeat + offset, beats, midi, vowel }
      : { beat: startBeat + offset, beats, midi },
  )
}

type ChordName = 'C' | 'F' | 'G' | 'Am'

const VOICINGS: Record<ChordName, { tones: readonly [number, number, number]; bass: number }> = {
  C: { tones: [60, 64, 67], bass: 36 },
  F: { tones: [65, 69, 72], bass: 41 },
  G: { tones: [67, 71, 74], bass: 43 },
  Am: { tones: [57, 60, 64], bass: 33 },
}

function progression(startBeat: number, names: readonly ChordName[]): ChordSpec[] {
  return names.map((name, index) => {
    const voicing = VOICINGS[name]
    return {
      beat: startBeat + index * 4,
      beats: 4,
      tones: voicing.tones,
      bass: voicing.bass,
    }
  })
}

/* ---------- ① 小星星：慢速 C 大调，C4–C5 ---------- */

const TWINKLE_ASK: readonly NoteSpec[] = [
  [0, 1, 60],
  [1, 1, 60],
  [2, 1, 67],
  [3, 1, 67],
  [4, 1, 69],
  [5, 1, 69],
  [6, 2, 67],
]

const TWINKLE_DESC: readonly NoteSpec[] = [
  [0, 1, 65],
  [1, 1, 65],
  [2, 1, 64],
  [3, 1, 64],
  [4, 1, 62],
  [5, 1, 62],
  [6, 2, 60],
]

const TWINKLE_G_END: readonly NoteSpec[] = [
  [0, 1, 67],
  [1, 1, 67],
  [2, 1, 65],
  [3, 1, 65],
  [4, 1, 64],
  [5, 1, 64],
  [6, 2, 62],
]

/* ---------- ② 欢乐颂：中速 C 大调，C4–G4 ---------- */

const ODE_END_D: readonly NoteSpec[] = [
  [0, 1, 64],
  [1, 1, 64],
  [2, 1, 65],
  [3, 1, 67],
  [4, 1, 67],
  [5, 1, 65],
  [6, 1, 64],
  [7, 1, 62],
  [8, 1, 60],
  [9, 1, 60],
  [10, 1, 62],
  [11, 1, 64],
  [12, 1.5, 64],
  [13.5, 0.5, 62],
  [14, 2, 62],
]

const ODE_END_C: readonly NoteSpec[] = [
  [0, 1, 64],
  [1, 1, 64],
  [2, 1, 65],
  [3, 1, 67],
  [4, 1, 67],
  [5, 1, 65],
  [6, 1, 64],
  [7, 1, 62],
  [8, 1, 60],
  [9, 1, 60],
  [10, 1, 62],
  [11, 1, 64],
  [12, 1.5, 64],
  [13.5, 0.5, 62],
  [14, 2, 60],
]

const ODE_BRIDGE: readonly NoteSpec[] = [
  [0, 1, 62],
  [1, 1, 62],
  [2, 1, 64],
  [3, 1, 60],
  [4, 1, 62],
  [5, 0.5, 64],
  [5.5, 0.5, 65],
  [6, 0.5, 64],
  [6.5, 1.5, 60],
  [8, 1, 62],
  [9, 0.5, 64],
  [9.5, 0.5, 65],
  [10, 0.5, 64],
  [10.5, 1.5, 60],
  [12, 1, 62],
  [13, 1, 64],
  [14, 1, 65],
  [15, 1, 67],
]

/* ---------- ③ 原创练声曲：C4–A5，含六度/八度跳进与长音 ---------- */

const ETUDE_PHRASE_1: readonly NoteSpec[] = [
  [0, 2, 60],
  [2, 2, 64],
  [4, 3, 67],
  [7, 1, 69],
  [8, 2, 67],
  [10, 2, 64],
  [12, 4, 62],
]

const ETUDE_PHRASE_2: readonly NoteSpec[] = [
  [0, 1, 64],
  [1, 1, 67],
  [2, 2, 72],
  [4, 2, 71],
  [6, 2, 67],
  [8, 2, 69],
  [10, 2, 65],
  [12, 4, 64],
]

const ETUDE_PHRASE_3: readonly NoteSpec[] = [
  [0, 2, 72],
  [2, 1, 69],
  [3, 1, 67],
  [4, 3, 76],
  [7, 1, 74],
  [8, 2, 72],
  [10, 1, 71],
  [11, 1, 69],
  [12, 4, 67],
]

const ETUDE_PHRASE_4: readonly NoteSpec[] = [
  [0, 1, 69],
  [1, 1, 72],
  [2, 2, 76],
  [4, 1, 79],
  [5, 2, 81],
  [7, 1, 79],
  [8, 2, 76],
  [10, 1, 74],
  [11, 1, 72],
  [12, 4, 72],
]

export const DEMO_SONG_SPECS: readonly DemoSongSpec[] = [
  {
    id: 'twinkle',
    title: '小星星',
    desc: '慢速 · C 大调 · 入门',
    bpm: 72,
    beatsPerBar: 4,
    totalBeats: 56,
    melody: [
      ...notes(4, TWINKLE_ASK),
      ...notes(12, TWINKLE_DESC),
      ...notes(20, TWINKLE_G_END),
      ...notes(28, TWINKLE_G_END),
      ...notes(36, TWINKLE_ASK),
      ...notes(44, TWINKLE_DESC),
    ],
    chords: progression(0, [
      'C', 'C', 'C', 'F', 'G', 'G', 'G',
      'G', 'G', 'C', 'C', 'F', 'C', 'C',
    ]),
  },
  {
    id: 'ode-to-joy',
    title: '欢乐颂',
    desc: '中速 · C 大调 · 长句换气',
    bpm: 100,
    beatsPerBar: 4,
    totalBeats: 72,
    melody: [
      ...notes(4, ODE_END_D),
      ...notes(20, ODE_END_C),
      ...notes(36, ODE_BRIDGE),
      ...notes(52, ODE_END_C),
    ],
    chords: progression(0, [
      'C', 'C', 'G', 'C', 'G', 'C', 'G', 'C', 'C',
      'C', 'G', 'G', 'G', 'C', 'G', 'C', 'C', 'C',
    ]),
  },
  {
    id: 'sunrise-etude',
    title: '晨曦练声曲',
    desc: '稍慢 · C 大调 · 音域 C4–A5 · 跳进与长音',
    bpm: 88,
    beatsPerBar: 4,
    totalBeats: 76,
    melody: [
      ...notes(4, ETUDE_PHRASE_1),
      ...notes(20, ETUDE_PHRASE_2),
      ...notes(36, ETUDE_PHRASE_3),
      ...notes(52, ETUDE_PHRASE_4),
    ],
    chords: progression(0, [
      'C', 'C', 'C', 'C', 'G', 'C', 'G', 'F', 'C', 'F',
      'C', 'C', 'G', 'F', 'C', 'G', 'C', 'C', 'C',
    ]),
  },
]
