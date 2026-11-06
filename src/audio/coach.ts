/** 音准仪“练声小课”的固定练习、目标音序列与评分规则。 */
import type { RawUserPoint } from './analysis'
import { clamp, midiToNoteName, midiToFreq } from './pitch'
import type { Note } from '../core/types'

export type CoachExerciseId = 'long-tone' | 'scale' | 'leaps'

export interface CoachNoteSpec {
  /** 相对起始音的半音数 */
  offset: number
  start: number
  end: number
  /** 只在这个区间内计分，避开起音和换音 */
  scoreStart: number
  scoreEnd: number
}

export interface CoachExercise {
  id: CoachExerciseId
  title: string
  subtitle: string
  description: string
  duration: number
  tolerance: number
  /** 界面直接展示的评分标准 */
  criteria: string
  tips: string[]
  notes: CoachNoteSpec[]
  /** 试听时每个音给多长 */
  previewNoteSeconds: number
}

function scaleNotes(rootOffset = 0): CoachNoteSpec[] {
  const offsets = [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0].map(
    (offset) => rootOffset + offset,
  )
  const step = 0.7
  return offsets.map((offset, index) => ({
    offset,
    start: index * step,
    end: index * step + step,
    scoreStart: index * step + 0.12,
    scoreEnd: index * step + step - 0.08,
  }))
}

function leapNotes(): CoachNoteSpec[] {
  const offsets = [0, 4, 0, 7, 0]
  const step = 1.1
  return offsets.map((offset, index) => ({
    offset,
    start: index * step,
    end: index * step + step,
    scoreStart: index * step + 0.14,
    scoreEnd: index * step + step - 0.08,
  }))
}

export const COACH_EXERCISES: CoachExercise[] = [
  {
    id: 'long-tone',
    title: '长音稳定',
    subtitle: '保持一个音 5 秒，看抖动',
    description:
      '先听参考音，再把这个音平稳地保持 5 秒。系统只看起音后的稳定段；音高不是越高越好，越稳越好。',
    duration: 5,
    tolerance: 35,
    criteria: '音准 70%（稳定段内落在 ±35 音分）+ 稳定 30%（5 秒内音高抖动越小越高）',
    tips: ['肩膀放松，气息均匀地送出去', '想象音高是一条直线，不要追着指针上下摆'],
    notes: [
      { offset: 0, start: 0, end: 5, scoreStart: 0.7, scoreEnd: 4.6 },
    ],
    previewNoteSeconds: 1.8,
  },
  {
    id: 'scale',
    title: '音阶上下行',
    subtitle: '八度大调音阶，上行再下行',
    description:
      '从起始音往上唱一个八度大调音阶，再原路下行。每个音都有固定的进入时间，尽量在换音前就把音头站稳。',
    duration: 15 * 0.7,
    tolerance: 40,
    criteria: '音准 70%（每个音落在 ±40 音分）+ 稳定 30%（平均偏差越小越高）',
    tips: ['先听一遍完整音阶再开始', '高音不要突然加大力气，提前把气送上去'],
    notes: scaleNotes(),
    previewNoteSeconds: 0.32,
  },
  {
    id: 'leaps',
    title: '三度 / 五度跳进',
    subtitle: '根音 → 三度 → 根音 → 五度',
    description:
      '从根音跳到三度，回到根音，再跳到五度。跳进最容易“摸”不准，先在心里听到目标音再出声。',
    duration: 5 * 1.1,
    tolerance: 40,
    criteria: '音准 70%（每个音落在 ±40 音分）+ 稳定 30%（平均偏差越小越高）',
    tips: ['跳进前先在心里预听目标音', '不要滑到目标音，直接站上去'],
    notes: leapNotes(),
    previewNoteSeconds: 0.7,
  },
]

export function findCoachExercise(id: CoachExerciseId): CoachExercise {
  return COACH_EXERCISES.find((exercise) => exercise.id === id) ?? COACH_EXERCISES[0]
}

export interface CoachTargetNote {
  midi: number
  start: number
  end: number
  scoreStart: number
  scoreEnd: number
}

export function buildCoachTargets(exercise: CoachExercise, rootMidi: number): CoachTargetNote[] {
  return exercise.notes.map((note) => ({
    midi: rootMidi + note.offset,
    start: note.start,
    end: note.end,
    scoreStart: note.scoreStart,
    scoreEnd: note.scoreEnd,
  }))
}

export function coachMelodyNotes(targets: CoachTargetNote[]): Note[] {
  return targets.map((target) => ({
    start: target.start,
    end: target.end,
    midi: target.midi,
  }))
}

export interface CoachNoteScore {
  midi: number
  label: string
  samples: number
  hitRate: number | null
  avgCents: number | null
}

export interface CoachScoreResult {
  samples: number
  hits: number
  hitRate: number | null
  avgCents: number | null
  meanAbsCents: number | null
  jitterCents: number | null
  stability: number | null
  score: number | null
  notes: CoachNoteScore[]
}

function emptyScoreNotes(targets: CoachTargetNote[]): CoachNoteScore[] {
  return targets.map((target) => ({
    midi: target.midi,
    label: midiToNoteName(target.midi).label,
    samples: 0,
    hitRate: null,
    avgCents: null,
  }))
}

/**
 * 练习评分。练声不跟随用户的八度对齐设置：目标音给出哪个八度，就按哪个八度算。
 * 有效采样太少时返回 score = null，界面不会硬给分。
 */
export function scoreCoachAttempt(
  points: RawUserPoint[],
  targets: CoachTargetNote[],
  tolerance: number,
  exerciseId: CoachExerciseId,
): CoachScoreResult {
  const notes = emptyScoreNotes(targets)
  let samples = 0
  let hits = 0
  let sumCents = 0
  let sumAbs = 0
  let sumSquares = 0

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]
    let noteSamples = 0
    let noteHits = 0
    let noteSum = 0
    for (const point of points) {
      if (point.t < target.scoreStart || point.t > target.scoreEnd) continue
      if (point.clarity < 0.8 || !Number.isFinite(point.midi)) continue
      const cents = (point.midi - target.midi) * 100
      noteSamples += 1
      noteSum += cents
      samples += 1
      sumCents += cents
      sumAbs += Math.abs(cents)
      sumSquares += cents * cents
      if (Math.abs(cents) <= tolerance) {
        noteHits += 1
        hits += 1
      }
    }
    notes[index] = {
      midi: target.midi,
      label: midiToNoteName(target.midi).label,
      samples: noteSamples,
      hitRate: noteSamples > 0 ? noteHits / noteSamples : null,
      avgCents: noteSamples > 0 ? noteSum / noteSamples : null,
    }
  }

  if (samples < 20) {
    return {
      samples,
      hits,
      hitRate: samples > 0 ? hits / samples : null,
      avgCents: samples > 0 ? sumCents / samples : null,
      meanAbsCents: samples > 0 ? sumAbs / samples : null,
      jitterCents: samples > 1 ? Math.sqrt(Math.max(0, sumSquares / samples - (sumCents / samples) ** 2)) : null,
      stability: null,
      score: null,
      notes,
    }
  }

  const hitRate = hits / samples
  const meanAbsCents = sumAbs / samples
  const jitter = Math.sqrt(Math.max(0, sumSquares / samples - (sumCents / samples) ** 2))
  const stability =
    exerciseId === 'long-tone'
      ? clamp(1 - jitter / 75, 0, 1)
      : clamp(1 - meanAbsCents / 100, 0, 1)
  const score = Math.round(100 * (0.7 * hitRate + 0.3 * stability))

  return {
    samples,
    hits,
    hitRate,
    avgCents: sumCents / samples,
    meanAbsCents,
    jitterCents: jitter,
    stability,
    score,
    notes,
  }
}

export interface CoachToneHandle {
  stop: () => void
}

/** 用简单正弦 + 一点二次谐波播放目标音，供练声前试听。 */
export function playCoachReference(
  ctx: AudioContext,
  targets: CoachTargetNote[],
  secondsPerNote: number,
): CoachToneHandle {
  const master = ctx.createGain()
  master.gain.value = 0.22
  master.connect(ctx.destination)
  const oscillators: OscillatorNode[] = []
  const start = ctx.currentTime + 0.03

  for (const target of targets) {
    const duration = Math.max(0.18, Math.min(target.end - target.start, secondsPerNote))
    const from = start + target.start * (secondsPerNote / Math.max(0.01, target.end - target.start))
    const oscillator = ctx.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.value = midiToFreq(target.midi)
    const harmonic = ctx.createOscillator()
    harmonic.type = 'triangle'
    harmonic.frequency.value = midiToFreq(target.midi) * 2
    const harmonicGain = ctx.createGain()
    harmonicGain.gain.value = 0.12
    const envelope = ctx.createGain()
    envelope.gain.setValueAtTime(0.0001, from)
    envelope.gain.linearRampToValueAtTime(1, from + 0.03)
    envelope.gain.setValueAtTime(0.8, from + Math.max(0.04, duration - 0.08))
    envelope.gain.linearRampToValueAtTime(0.0001, from + duration)
    oscillator.connect(envelope)
    harmonic.connect(harmonicGain)
    harmonicGain.connect(envelope)
    envelope.connect(master)
    oscillator.start(from)
    oscillator.stop(from + duration + 0.02)
    harmonic.start(from)
    harmonic.stop(from + duration + 0.02)
    oscillators.push(oscillator, harmonic)
  }

  return {
    stop: () => {
      for (const oscillator of oscillators) {
        try {
          oscillator.stop()
        } catch {
          // 已经停止
        }
      }
      try {
        master.disconnect()
      } catch {
        // 已经断开
      }
    },
  }
}
