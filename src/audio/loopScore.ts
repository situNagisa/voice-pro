import type { ReferenceMelody } from '../core/types'
import type { RawUserPoint } from './analysis'
import { compareToTarget, pointTranspose, referenceMidiAt } from './analysis'

export interface PassResult {
  pass: number
  hitRate: number | null
  samples: number
  avgCents: number | null
}

/** 单遍评分：只看本句计分区间，不把句前预备算进去。 */
export function evalPass(options: {
  points: RawUserPoint[]
  melody: ReferenceMelody
  scoreStart: number
  scoreEnd: number
  octaveAlign: boolean
  tolerance: number
  transpose: number
  pass: number
}): PassResult {
  let samples = 0
  let hits = 0
  let sum = 0
  for (const point of options.points) {
    if (point.t < options.scoreStart - 0.03 || point.t > options.scoreEnd + 0.03) continue
    const target = referenceMidiAt(
      options.melody,
      point.t,
      pointTranspose(point, options.transpose),
    )
    if (target == null) continue
    const comparison = compareToTarget(
      point.midi,
      target,
      options.octaveAlign,
      options.tolerance,
    )
    samples += 1
    sum += comparison.cents
    if (Math.abs(comparison.cents) <= options.tolerance) hits += 1
  }
  return {
    pass: options.pass,
    hitRate: samples >= 8 ? hits / samples : null,
    samples,
    avgCents: samples > 0 ? sum / samples : null,
  }
}
