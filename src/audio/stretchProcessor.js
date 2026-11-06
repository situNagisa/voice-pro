/*
 * 实时变调 / 变速的核心：WSOLA 时间伸缩 + 三次插值重采样。
 *
 * 输入是已经按 speed 播放的音频流（AudioBufferSourceNode.playbackRate = speed），
 * 所以这里只负责把音高补回 2^(半音/12)：伸缩倍数与重采样倍数都等于
 * q = 2^(半音/12) / speed。
 *
 * 为什么不用相位声码器：WSOLA 对鼓点、辅音这类瞬态更稳，延迟可以压到
 * 一帧多一点；相位声码器在手机上有明显的金属尾音。这里沿用离线版本
 * 的 WSOLA 思路，但改成流式：帧长 2048、输出跳 1024、在 ±512 个采样内
 * 找和上一帧重叠段最相似的起点。
 *
 * 主线程用消息设置参数 / 复位；复位后等待 2048+512 个输入采样才开始出声，
 * 对应约 50ms 的算法延迟，播放器会把这部分从播放位置里扣掉。
 */

const FRAME = 2048
const HOP = 1024
const SEARCH = 512
const SEARCH_STEP = 16
const CORRELATION = 384
const INPUT_RING = 32768
const OUTPUT_RING = 16384

const INPUT_MASK = INPUT_RING - 1
const OUTPUT_MASK = OUTPUT_RING - 1

const WINDOW = new Float32Array(FRAME)
for (let i = 0; i < FRAME; i++) {
  WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
}

class RealtimeStretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.input = [new Float32Array(INPUT_RING), new Float32Array(INPUT_RING)]
    this.output = [new Float32Array(OUTPUT_RING), new Float32Array(OUTPUT_RING)]
    this.targetQ = 1
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'reset') {
        this.reset()
      } else if (data.type === 'params') {
        const semitones = Number(data.semitones) || 0
        const speed = Math.max(0.25, Number(data.speed) || 1)
        this.targetQ = Math.min(4, Math.max(0.25, Math.pow(2, semitones / 12) / speed))
        if (!this.primed) this.q = this.targetQ
      }
    }
    this.reset()
  }

  reset() {
    this.write = 0
    this.nominal = 0
    this.prevStart = -1
    this.previous = null
    this.frameStart = 0
    this.synthEnd = 0
    this.readPos = 0
    this.primed = false
    this.q = this.targetQ
    for (let c = 0; c < 2; c++) {
      this.input[c].fill(0)
      this.output[c].fill(0)
    }
  }

  inputSample(channel, index) {
    if (index < 0 || index >= this.write) return 0
    return this.input[channel][index & INPUT_MASK]
  }

  monoAt(index) {
    return (this.inputSample(0, index) + this.inputSample(1, index)) * 0.5
  }

  score(candidate, reference) {
    if (!reference || reference.energy < 1e-10) return 0
    let dot = 0
    let energy = 0
    for (let i = 0; i < CORRELATION; i++) {
      const value = this.monoAt(candidate + i)
      dot += value * reference.data[i]
      energy += value * value
    }
    if (energy < 1e-10) return 0
    return dot / Math.sqrt(energy * reference.energy)
  }

  canProduce() {
    return this.write >= this.nominal + FRAME + SEARCH
  }

  produce() {
    let start = 0
    if (this.prevStart >= 0) {
      const availableMax = Math.max(0, this.write - FRAME)
      const ideal = Math.min(availableMax, Math.max(0, Math.round(this.nominal)))
      let best = ideal
      let bestScore = this.score(ideal, this.previous)
      const from = Math.max(0, ideal - SEARCH)
      const to = Math.min(availableMax, ideal + SEARCH)
      for (let candidate = from; candidate <= to; candidate += SEARCH_STEP) {
        if (candidate === ideal) continue
        const candidateScore = this.score(candidate, this.previous)
        if (candidateScore > bestScore + 1e-6) {
          bestScore = candidateScore
          best = candidate
        }
      }
      start = best
    }

    const frameStart = this.frameStart
    // 环形输出里，新帧超出上一帧尾部的部分可能还是 16k 个采样前的旧数据，
    // 先清空再叠加，否则每转一圈会出现一次“幽灵回声”。
    const freshStart = frameStart + HOP
    const freshEnd = frameStart + FRAME
    for (let channel = 0; channel < 2; channel++) {
      const out = this.output[channel]
      for (let i = freshStart; i < freshEnd; i++) out[i & OUTPUT_MASK] = 0
    }
    for (let channel = 0; channel < 2; channel++) {
      const out = this.output[channel]
      const input = this.input[channel]
      for (let i = 0; i < FRAME; i++) {
        const index = start + i
        const value = index >= 0 && index < this.write ? input[index & INPUT_MASK] : 0
        out[(frameStart + i) & OUTPUT_MASK] += value * WINDOW[i]
      }
    }

    // 下一帧要和这一帧在输出里重叠，参考的是这一帧从 HOP 处开始的波形。
    const referenceData = new Float32Array(CORRELATION)
    let energy = 0
    for (let i = 0; i < CORRELATION; i++) {
      const value = this.monoAt(start + HOP + i)
      referenceData[i] = value
      energy += value * value
    }
    this.previous = { data: referenceData, energy }
    this.prevStart = start
    this.synthEnd = frameStart + FRAME
    this.frameStart += HOP
    this.nominal += HOP / this.q
    this.primed = true
  }

  ensureOutput(frames) {
    const needed = frames * this.q + HOP
    let guard = 0
    while (this.synthEnd - this.readPos < needed && guard < 64) {
      if (!this.canProduce()) break
      this.produce()
      guard++
    }
  }

  cubic(ring, position) {
    const base = Math.floor(position)
    const frac = position - base
    const y0 = ring[(base - 1) & OUTPUT_MASK]
    const y1 = ring[base & OUTPUT_MASK]
    const y2 = ring[(base + 1) & OUTPUT_MASK]
    const y3 = ring[(base + 2) & OUTPUT_MASK]
    return (
      y1 +
      0.5 *
        frac *
        (y2 -
          y0 +
          frac * (2 * y0 - 5 * y1 + 4 * y2 - y3 + frac * (3 * (y1 - y2) + y3 - y0)))
    )
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const frames = output[0].length
    for (let c = 0; c < output.length; c++) output[c].fill(0)

    if (this.q !== this.targetQ) {
      const next = this.q + (this.targetQ - this.q) * 0.25
      this.q = Math.abs(next - this.targetQ) < 1e-4 ? this.targetQ : next
    }

    const input = inputs[0]
    if (input && input.length > 0 && input[0].length > 0) {
      const count = input[0].length
      const first = input[0]
      const second = input.length > 1 ? input[1] : input[0]
      const left = this.input[0]
      const right = this.input[1]
      for (let i = 0; i < count; i++) {
        const index = (this.write + i) & INPUT_MASK
        left[index] = first[i]
        right[index] = second[i]
      }
      this.write += count
    }

    this.ensureOutput(frames)
    if (!this.primed) return true

    const q = this.q
    for (let c = 0; c < output.length; c++) {
      const out = output[c]
      const ring = this.output[Math.min(c, 1)]
      for (let i = 0; i < frames; i++) {
        out[i] = this.cubic(ring, this.readPos + i * q)
      }
    }
    this.readPos += frames * q
    return true
  }
}

registerProcessor('voice-stretch-processor', RealtimeStretchProcessor)
