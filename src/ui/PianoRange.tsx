import { midiToNoteName } from '../audio/pitch'

interface PianoRangeProps {
  lowMidi: number
  highMidi: number
  medianMidi?: number
}

const WHITE_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11]
const BLACK_PITCH_CLASSES = [1, 3, 6, 8, 10]

function isWhite(midi: number): boolean {
  return WHITE_PITCH_CLASSES.includes(((midi % 12) + 12) % 12)
}

/**
 * 用一段钢琴键示意实际唱到的音域。
 * 键位按半音排列，黑白键宽度不同；低/高音名直接标在下方。
 */
export function PianoRange({ lowMidi, highMidi, medianMidi }: PianoRangeProps) {
  const low = Math.min(lowMidi, highMidi)
  const high = Math.max(lowMidi, highMidi)
  let start = Math.floor(low) - 2
  let end = Math.ceil(high) + 2
  if (end - start < 16) {
    const center = (low + high) / 2
    start = Math.floor(center - 8)
    end = start + 16
  } else if (end - start > 34) {
    const center = (low + high) / 2
    start = Math.floor(center - 17)
    end = start + 34
  }
  start = Math.max(24, start)
  end = Math.min(96, Math.max(start + 12, end))
  while (!isWhite(start) && start > 24) start -= 1
  while (!isWhite(end) && end < 96) end += 1

  const whiteKeys: number[] = []
  for (let midi = start; midi <= end; midi++) {
    if (isWhite(midi)) whiteKeys.push(midi)
  }
  const whiteWidth = 100 / Math.max(1, whiteKeys.length)
  const activeLow = Math.round(low)
  const activeHigh = Math.round(high)
  const isActive = (midi: number) => midi >= activeLow && midi <= activeHigh

  const blackKeys: { midi: number; left: number }[] = []
  let whitesBefore = 0
  for (let midi = start; midi <= end; midi++) {
    if (isWhite(midi)) {
      whitesBefore += 1
      continue
    }
    if (BLACK_PITCH_CLASSES.includes(((midi % 12) + 12) % 12)) {
      blackKeys.push({ midi, left: whitesBefore * whiteWidth })
    }
  }

  const lowName = midiToNoteName(low).label
  const highName = midiToNoteName(high).label
  const medianName = medianMidi != null ? midiToNoteName(medianMidi).label : null
  const aria = `音域钢琴键示意：最低 ${lowName}，最高 ${highName}${
    medianName ? `，中位 ${medianName}` : ''
  }`

  return (
    <div className="piano-range" role="img" aria-label={aria}>
      <div className="piano-keys">
        {whiteKeys.map((midi) => (
          <span
            key={`w-${midi}`}
            className={`piano-key white ${isActive(midi) ? 'active' : ''}`}
            style={{ width: `${whiteWidth}%` }}
          >
            {((midi % 12) + 12) % 12 === 0 && (
              <em>{midiToNoteName(midi).label}</em>
            )}
          </span>
        ))}
        {blackKeys.map((key) => (
          <span
            key={`b-${key.midi}`}
            className={`piano-key black ${isActive(key.midi) ? 'active' : ''}`}
            style={{ left: `${key.left}%`, width: `${whiteWidth * 0.62}%` }}
          />
        ))}
      </div>
      <div className="piano-caption">
        <span>最低 <strong>{lowName}</strong></span>
        {medianName && <span>中位 <strong>{medianName}</strong></span>}
        <span>最高 <strong>{highName}</strong></span>
      </div>
    </div>
  )
}
