import type { ChordSpec, DemoSongSpec, MelodyNote, Vowel } from './songs'
import { songDurationSec } from './songs'

/**
 * 示例歌曲合成：
 * - 人声：锯齿 + 脉冲源，经三段共振峰带通（元音 a/o/e），带起音、短滑音和长音后段颤音；
 * - 伴奏：失谐锯齿和弦垫音（左右展开）+ 低音 + 节拍器式轻打击，整体压低约 6–9 dB；
 * - 人声不声像、居中，方便 src/reference 的中置提取拿到旋律。
 */

const SAMPLE_RATE = 44100
const MIX_PEAK = 0.92
/** 伴奏总音量：相对人声约低 6–9 dB */
const BAND_GAIN = 0.55
const VIBRATO_MIN_SECONDS = 0.8
const VIBRATO_CENTS = 24

const VOWEL_FORMANTS: Record<Vowel, readonly [number, number, number]> = {
  a: [800, 1150, 2900],
  o: [450, 800, 2830],
  e: [520, 1600, 2500],
}
const FORMANT_Q: readonly [number, number, number] = [6, 9, 11]
const FORMANT_GAIN: readonly [number, number, number] = [1, 0.55, 0.3]

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

/** 确定性伪随机，保证同一首歌每次合成都一样 */
function noise01(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

function vowelOf(note: MelodyNote): Vowel {
  return note.vowel ?? (note.beats >= 2 ? 'o' : 'a')
}

function makeFormant(
  ctx: OfflineAudioContext,
  frequency: number,
  q: number,
  gainValue: number,
  destination: AudioNode,
): BiquadFilterNode {
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = frequency
  filter.Q.value = q
  const gain = ctx.createGain()
  gain.gain.value = gainValue
  filter.connect(gain)
  gain.connect(destination)
  return filter
}

function scheduleVocal(
  ctx: OfflineAudioContext,
  bus: AudioNode,
  melody: readonly MelodyNote[],
  beatSec: number,
): void {
  const formants = [
    makeFormant(ctx, VOWEL_FORMANTS.a[0], FORMANT_Q[0], FORMANT_GAIN[0], bus),
    makeFormant(ctx, VOWEL_FORMANTS.a[1], FORMANT_Q[1], FORMANT_GAIN[1], bus),
    makeFormant(ctx, VOWEL_FORMANTS.a[2], FORMANT_Q[2], FORMANT_GAIN[2], bus),
  ]
  formants.forEach((filter, index) => {
    filter.frequency.setValueAtTime(VOWEL_FORMANTS.a[index], 0)
  })

  // 保留一点基频的直达声，避免只有共振峰时声音过薄
  const body = ctx.createBiquadFilter()
  body.type = 'lowpass'
  body.frequency.value = 1400
  body.Q.value = 0.7
  const bodyGain = ctx.createGain()
  bodyGain.gain.value = 0.16
  body.connect(bodyGain)
  bodyGain.connect(bus)

  let previous: MelodyNote | null = null
  let previousEnd = -Infinity

  melody.forEach((note, index) => {
    const start = note.beat * beatSec
    const end = start + note.beats * beatSec
    const duration = end - start
    const targetHz = midiToHz(note.midi)

    // 与前一个音几乎相连时做短滑音；大跳则改为轻微的上滑起音
    const legato = previous !== null && start - previousEnd < 0.12
    const interval = previous !== null ? Math.abs(previous.midi - note.midi) : Infinity
    const previousHz = previous !== null ? midiToHz(previous.midi) : targetHz
    const glideFrom =
      legato && interval <= 7 ? previousHz : targetHz * 2 ** (-40 / 1200)
    const glide = legato && interval <= 7 ? 0.055 : 0.045

    const centers = VOWEL_FORMANTS[vowelOf(note)]
    formants.forEach((filter, formantIndex) => {
      filter.frequency.setTargetAtTime(centers[formantIndex], start, 0.025)
    })

    const saw = ctx.createOscillator()
    saw.type = 'sawtooth'
    const pulse = ctx.createOscillator()
    pulse.type = 'square'
    const pulseGain = ctx.createGain()
    pulseGain.gain.value = 0.28
    const noteGain = ctx.createGain()

    const cents = (noise01(index + 1) - 0.5) * 5
    for (const osc of [saw, pulse]) {
      osc.frequency.setValueAtTime(glideFrom, start)
      osc.frequency.exponentialRampToValueAtTime(targetHz, start + glide)
      osc.connect(noteGain)
    }
    saw.detune.setValueAtTime(cents, start)
    pulse.detune.setValueAtTime(cents + 7, start)
    pulse.connect(pulseGain)
    pulseGain.connect(noteGain)

    noteGain.connect(formants[0])
    noteGain.connect(formants[1])
    noteGain.connect(formants[2])
    noteGain.connect(body)

    const peak = 0.5
    const releaseStart = Math.max(start + 0.05, end - 0.05)
    const stop = end + (legato ? 0.03 : 0.1)
    noteGain.gain.setValueAtTime(0, start)
    noteGain.gain.linearRampToValueAtTime(peak, start + 0.035)
    noteGain.gain.linearRampToValueAtTime(peak * 0.78, start + Math.min(0.16, duration * 0.5))
    noteGain.gain.setValueAtTime(peak * 0.78, releaseStart)
    noteGain.gain.linearRampToValueAtTime(0, stop)

    // 长音后段才出现的自然颤音：5–6 Hz，约 ±20–28 音分
    if (duration >= VIBRATO_MIN_SECONDS) {
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 5.1 + noise01(index + 17) * 0.8
      const depth = ctx.createGain()
      const delay = Math.min(0.5, duration * 0.45)
      const fade = 0.28
      const depthCents = VIBRATO_CENTS * (0.85 + noise01(index + 31) * 0.3)
      depth.gain.setValueAtTime(0, start)
      depth.gain.setValueAtTime(0, start + delay)
      depth.gain.linearRampToValueAtTime(depthCents, start + delay + fade)
      lfo.connect(depth)
      depth.connect(saw.detune)
      depth.connect(pulse.detune)
      lfo.start(start)
      lfo.stop(stop + 0.02)
    }

    saw.start(start)
    pulse.start(start)
    saw.stop(stop + 0.02)
    pulse.stop(stop + 0.02)

    previous = note
    previousEnd = end
  })
}

function schedulePad(
  ctx: OfflineAudioContext,
  bus: AudioNode,
  chord: ChordSpec,
  start: number,
  end: number,
): void {
  const pans: readonly [number, number, number] = [-0.65, 0.1, 0.65]

  chord.tones.forEach((midi, index) => {
    const gain = ctx.createGain()
    const level = 0.04
    const attack = 0.2
    const release = 0.45
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(level, start + attack)
    gain.gain.setValueAtTime(level, Math.max(start + attack, end - 0.1))
    gain.gain.linearRampToValueAtTime(0, end + release)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1000
    filter.Q.value = 0.5
    const panner = ctx.createStereoPanner()
    panner.pan.value = pans[index]
    filter.connect(gain)
    gain.connect(panner)
    panner.connect(bus)

    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = midiToHz(midi)
      osc.detune.value = detune
      osc.connect(filter)
      osc.start(start)
      osc.stop(end + release + 0.02)
    }
  })
}

function scheduleBass(
  ctx: OfflineAudioContext,
  bus: AudioNode,
  chord: ChordSpec,
  start: number,
  end: number,
  index: number,
): void {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = midiToHz(chord.bass)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(0.13, start + 0.025)
  gain.gain.linearRampToValueAtTime(0.08, Math.min(start + 0.3, end - 0.05))
  gain.gain.linearRampToValueAtTime(0, end + 0.12)
  const panner = ctx.createStereoPanner()
  // 低音左右交替，避免和居中人声抢中置声道
  panner.pan.value = index % 2 === 0 ? -0.45 : 0.45
  osc.connect(gain)
  gain.connect(panner)
  panner.connect(bus)
  osc.start(start)
  osc.stop(end + 0.16)
}

function makeNoiseBuffer(ctx: OfflineAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.12)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let seed = 0x1234567
  for (let i = 0; i < length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    data[i] = (seed / 0x100000000) * 2 - 1
  }
  return buffer
}

function schedulePercussion(
  ctx: OfflineAudioContext,
  bus: AudioNode,
  spec: DemoSongSpec,
  beatSec: number,
  noise: AudioBuffer,
): void {
  const totalBeats = Math.round(spec.totalBeats)

  for (let beat = 0; beat < totalBeats; beat++) {
    const time = beat * beatSec
    const downbeat = beat % spec.beatsPerBar === 0

    // 高位置噪声，像轻微的闭镲；左右交替
    const hat = ctx.createBufferSource()
    hat.buffer = noise
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 6500
    const hatGain = ctx.createGain()
    hatGain.gain.setValueAtTime(downbeat ? 0.04 : 0.026, time)
    hatGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06)
    const hatPan = ctx.createStereoPanner()
    hatPan.pan.value = beat % 2 === 0 ? -0.55 : 0.55
    hat.connect(highpass)
    highpass.connect(hatGain)
    hatGain.connect(hatPan)
    hatPan.connect(bus)
    hat.start(time, 0, 0.08)

    // 节拍器式轻点击，重拍略高、反向声像
    const click = ctx.createOscillator()
    click.type = 'sine'
    click.frequency.value = downbeat ? 1760 : 1175
    const clickGain = ctx.createGain()
    clickGain.gain.setValueAtTime(downbeat ? 0.038 : 0.024, time)
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05)
    const clickPan = ctx.createStereoPanner()
    clickPan.pan.value = downbeat ? 0.35 : -0.35
    click.connect(clickGain)
    clickGain.connect(clickPan)
    clickPan.connect(bus)
    click.start(time)
    click.stop(time + 0.06)
  }
}

function normalize(buffer: AudioBuffer): void {
  const channels: Float32Array[] = []
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    channels.push(data)
    for (let i = 0; i < data.length; i++) {
      const value = Math.abs(data[i])
      if (value > peak) peak = value
    }
  }
  if (peak < 1e-4) return

  const scale = Math.min(MIX_PEAK / peak, 6)
  if (Math.abs(scale - 1) < 0.001) return
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) data[i] *= scale
  }
}

export async function renderSong(
  spec: DemoSongSpec,
  sampleRate: number = SAMPLE_RATE,
): Promise<AudioBuffer> {
  const length = Math.ceil(songDurationSec(spec) * sampleRate)
  const ctx = new OfflineAudioContext(2, length, sampleRate)
  const master = ctx.createGain()
  master.gain.value = 1
  master.connect(ctx.destination)

  const vocalBus = ctx.createGain()
  vocalBus.gain.value = 1
  vocalBus.connect(master)

  const bandBus = ctx.createGain()
  bandBus.gain.value = BAND_GAIN
  bandBus.connect(master)

  const beatSec = 60 / spec.bpm
  scheduleVocal(ctx, vocalBus, spec.melody, beatSec)

  const noise = makeNoiseBuffer(ctx)
  spec.chords.forEach((chord, index) => {
    const start = chord.beat * beatSec
    const end = (chord.beat + chord.beats) * beatSec
    schedulePad(ctx, bandBus, chord, start, end)
    scheduleBass(ctx, bandBus, chord, start, end, index)
  })
  schedulePercussion(ctx, bandBus, spec, beatSec, noise)

  const buffer = await ctx.startRendering()
  normalize(buffer)
  return buffer
}
