import type { Note, PitchFrame, ReferenceMelody } from '../core/types';
import { ANALYSIS_RATE, HOP_SECONDS } from './protocol';
import { Radix2Fft, hannWindow, resample } from './dsp';

/**
 * v0.1 的纯 DSP 参考旋律提取：
 * 中置声道 → 16 kHz → STFT → 对数频率谐波求和 → Viterbi → 发声过滤 → 音符切分。
 * 该模块不依赖 DOM，便于在 Worker 和离线脚本中复用。
 */

const FFT_SIZE = 1024; // 64 ms @ 16 kHz：兼顾 80 Hz 低音的谐波分辨率和颤音跟踪
const HOP_SAMPLES = Math.round(ANALYSIS_RATE * HOP_SECONDS);
const MIN_F0 = 80;
const MAX_F0 = 1100;
const CENTS_STEP = 10;
const MAX_HARMONIC_HZ = 6200;
const MAX_HARMONICS = 12;
const MAX_CANDIDATES = 12;
const UNVOICED = MAX_CANDIDATES;
const STATE_STRIDE = MAX_CANDIDATES + 1;
const VOICING_COST = 0.12;
const MIN_VOICED_RUN = 3; // 30 ms
const MAX_GAP_FILL = 4; // 40 ms
const MIN_NOTE_SECONDS = 0.08;
const NOTE_SMOOTH_RADIUS = 9; // 190 ms 中值滤波：压掉宽颤音，又不抹平音符台阶

export interface ExtractionInput {
  sampleRate: number;
  duration: number;
  channels: Float32Array[];
}

export type ProgressReporter = (stage: string, ratio: number) => void;

interface SpectrumGrid {
  binCount: number;
  offsets: Int32Array;
  entryBin: Int32Array;
  entryFrac: Float32Array;
  entryWeight: Float32Array;
}

interface AnalysisFrames {
  count: number;
  quality: Float32Array;
  candidateCount: Uint8Array;
  candidateFreq: Float32Array;
  candidateMidi: Float32Array;
  candidateScore: Float32Array;
}

export function runExtraction(
  input: ExtractionInput,
  report: ProgressReporter,
): ReferenceMelody {
  const { channels, sampleRate } = input;
  if (channels.length === 0 || !(sampleRate > 0)) {
    throw new Error('无法提取：音频没有可用声道');
  }

  let sampleCount = channels[0].length;
  for (let c = 1; c < channels.length; c++) {
    sampleCount = Math.min(sampleCount, channels[c].length);
  }
  const duration =
    Number.isFinite(input.duration) && input.duration > 0
      ? input.duration
      : sampleCount / sampleRate;
  const frameCount = Math.max(0, Math.floor(duration / HOP_SECONDS) + 1);

  if (sampleCount === 0 || frameCount === 0) {
    return emptyMelody(duration, frameCount);
  }

  report('准备音频', 0.01);
  const { mid, side } = downmix(channels, sampleCount);

  report('降采样', 0.05);
  const mid16k = resample(mid, sampleRate, ANALYSIS_RATE);
  let peak = 0;
  for (let i = 0; i < mid16k.length; i++) {
    const v = Math.abs(mid16k[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-5) {
    report('完成', 1);
    return emptyMelody(duration, frameCount);
  }

  // 在归一化之前用同一带宽比较 mid/side 能量；mid16k 已低通，不能直接比。
  let widthRatio: Float32Array | null = null;
  if (side) {
    const midInputRms = smooth(
      rmsBlocks(mid, sampleRate, frameCount, HOP_SECONDS),
      2,
    );
    const sideRms = smooth(
      rmsBlocks(side, sampleRate, frameCount, HOP_SECONDS),
      2,
    );
    widthRatio = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      widthRatio[i] = sideRms[i] / (midInputRms[i] + 1e-9);
    }
  }

  // 统一到峰值 0.9，后续能量阈值与绝对响度无关；限制放大倍数，
  // 避免把近乎静音的底噪放大成“满幅信号”。
  const gain = Math.min(0.9 / peak, 30);
  for (let i = 0; i < mid16k.length; i++) mid16k[i] *= gain;

  const frameEnergy = smooth(
    rmsBlocks(mid16k, ANALYSIS_RATE, frameCount, HOP_SECONDS),
    1,
  );

  report('分析频谱', 0.08);
  const analysis = analyzeFrames(
    mid16k,
    frameCount,
    frameEnergy,
    widthRatio,
    report,
  );

  report('跟踪主旋律', 0.84);
  const rawPitch = trackPitch(analysis);

  report('判断发声', 0.9);
  const melodyFrames = refineVoicing(rawPitch, analysis.quality, frameCount);

  report('生成音符', 0.95);
  const notes = buildNotes(
    melodyFrames.midi,
    frameCount,
    duration,
  );

  const frames: PitchFrame[] = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    frames[i] = {
      t: i * HOP_SECONDS,
      f0: melodyFrames.f0[i],
      clarity: melodyFrames.clarity[i],
    };
  }

  report('完成', 1);
  return { duration, hop: HOP_SECONDS, frames, notes };
}

function emptyMelody(duration: number, frameCount: number): ReferenceMelody {
  const frames: PitchFrame[] = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    frames[i] = { t: i * HOP_SECONDS, f0: null, clarity: 0 };
  }
  return { duration, hop: HOP_SECONDS, frames, notes: [] };
}

/**
 * 中置提取：mid=(L+R)/2 能抵消反相的宽声场内容；side 只用于给“声场很宽”的帧
 * 降一点置信度，不做昂贵的频谱域声道抵消。
 */
function downmix(
  channels: Float32Array[],
  sampleCount: number,
): { mid: Float32Array; side: Float32Array | null } {
  if (channels.length === 1) {
    return { mid: channels[0].subarray(0, sampleCount), side: null };
  }

  const mid = channels[0];
  const side = channels[1];
  if (channels.length === 2) {
    for (let i = 0; i < sampleCount; i++) {
      const l = mid[i];
      const r = side[i];
      mid[i] = (l + r) * 0.5;
      side[i] = (l - r) * 0.5;
    }
    return { mid, side };
  }

  // 多声道常见布局（5.1/7.1）前两声道是 L/R、第三声道是 center；
  // 忽略 LFE 和环绕，避免低频与宽声场稀释人声。
  const center = channels.length >= 3 ? channels[2] : null;
  for (let i = 0; i < sampleCount; i++) {
    const l = mid[i];
    const r = side[i];
    mid[i] = (l + r) * 0.5 + (center ? center[i] * 0.5 : 0);
    side[i] = (l - r) * 0.5;
  }
  return { mid, side };
}

function rmsBlocks(
  samples: Float32Array,
  rate: number,
  frameCount: number,
  hopSeconds: number,
): Float32Array {
  const out = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const start = Math.round(i * rate * hopSeconds);
    if (start >= samples.length) break;
    const end = Math.min(
      samples.length,
      Math.round((i + 1) * rate * hopSeconds),
    );
    let sum = 0;
    for (let j = start; j < end; j++) {
      const v = samples[j];
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return out;
}

function smooth(values: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return values;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius);
    const to = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += values[j];
    out[i] = sum / (to - from + 1);
  }
  return out;
}

function buildSpectrumGrid(): SpectrumGrid {
  const binCount =
    Math.floor(
      (1200 * Math.log2(MAX_F0 / MIN_F0)) / CENTS_STEP,
    ) + 1;
  const offsets = new Int32Array(binCount + 1);
  const bins: number[] = [];
  const fracs: number[] = [];
  const weights: number[] = [];

  for (let k = 0; k < binCount; k++) {
    offsets[k] = bins.length;
    const f0 = MIN_F0 * Math.pow(2, (k * CENTS_STEP) / 1200);
    for (let h = 1; h <= MAX_HARMONICS; h++) {
      const harmonic = f0 * h;
      if (harmonic > MAX_HARMONIC_HZ) break;
      const binPos = (harmonic * FFT_SIZE) / ANALYSIS_RATE;
      if (binPos >= FFT_SIZE / 2 - 1) break;
      const bin = Math.floor(binPos);
      bins.push(bin);
      fracs.push(binPos - bin);
      weights.push(1 / Math.sqrt(h));
    }
  }
  offsets[binCount] = bins.length;

  return {
    binCount,
    offsets,
    entryBin: Int32Array.from(bins),
    entryFrac: Float32Array.from(fracs),
    entryWeight: Float32Array.from(weights),
  };
}

function analyzeFrames(
  samples: Float32Array,
  frameCount: number,
  frameEnergy: Float32Array,
  widthRatio: Float32Array | null,
  report: ProgressReporter,
): AnalysisFrames {
  const grid = buildSpectrumGrid();
  const fft = new Radix2Fft(FFT_SIZE);
  const window = hannWindow(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const magnitude = new Float32Array(FFT_SIZE / 2 + 1);
  const salience = new Float32Array(grid.binCount);
  const maxMagBin = Math.min(
    FFT_SIZE / 2,
    Math.ceil((MAX_HARMONIC_HZ * FFT_SIZE) / ANALYSIS_RATE) + 1,
  );
  const topIndex = new Int32Array(MAX_CANDIDATES);
  const acceptedIndex = new Int32Array(MAX_CANDIDATES);

  const candidateFreq = new Float32Array(frameCount * MAX_CANDIDATES);
  const candidateMidi = new Float32Array(frameCount * MAX_CANDIDATES);
  const candidateScore = new Float32Array(frameCount * MAX_CANDIDATES);
  const candidateCount = new Uint8Array(frameCount);
  const quality = new Float32Array(frameCount);

  for (let t = 0; t < frameCount; t++) {
    const center = t * HOP_SAMPLES;
    const start = center - (FFT_SIZE >> 1);
    re.fill(0);
    im.fill(0);
    const from = Math.max(0, -start);
    const to = Math.min(FFT_SIZE, samples.length - start);
    for (let j = from; j < to; j++) {
      re[j] = samples[start + j] * window[j];
    }

    fft.transform(re, im);

    let magMax = 0;
    for (let b = 1; b <= maxMagBin; b++) {
      const value = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      magnitude[b] = value;
      if (value > magMax) magMax = value;
    }
    const magScale = magMax > 1e-20 ? 1 / magMax : 0;
    for (let b = 1; b <= maxMagBin; b++) {
      magnitude[b] = Math.sqrt(magnitude[b] * magScale);
    }

    let salMax = 0;
    let salSum = 0;
    for (let k = 0; k < grid.binCount; k++) {
      let sum = 0;
      const end = grid.offsets[k + 1];
      for (let e = grid.offsets[k]; e < end; e++) {
        const bin = grid.entryBin[e];
        const frac = grid.entryFrac[e];
        const lo = magnitude[bin];
        sum +=
          grid.entryWeight[e] * (lo + (magnitude[bin + 1] - lo) * frac);
      }
      salience[k] = sum;
      salSum += sum;
      if (sum > salMax) salMax = sum;
    }

    // 谐波显著性的峰/均值比：噪声帧的谱峰平坦，这个比值会明显偏低。
    const prominence = salienceProminence(salMax, salSum, grid.binCount);
    const promScore = clamp(
      Math.log(prominence / 2) / Math.log(6),
      0,
      1,
    );

    const energyDb = 20 * Math.log10(frameEnergy[t] + 1e-9);
    const energyScore = clamp((energyDb + 52) / 27, 0, 1);
    let widthScore = 1;
    if (widthRatio) {
      const ratio = widthRatio[t];
      widthScore = clamp(
        1 / (1 + 0.45 * Math.max(0, ratio - 0.4)),
        0.5,
        1,
      );
    }
    const q =
      promScore *
      (0.35 + 0.65 * energyScore) *
      (0.6 + 0.4 * widthScore);
    quality[t] = q;

    let topCount = 0;
    if (salMax > 1e-9) {
      const threshold = salMax * 0.35;
      for (let k = 1; k < grid.binCount - 1; k++) {
        const value = salience[k];
        if (value < threshold) continue;
        if (value < salience[k - 1] || value <= salience[k + 1]) continue;
        if (topCount < MAX_CANDIDATES) {
          let pos = topCount++;
          while (pos > 0 && salience[topIndex[pos - 1]] < value) {
            topIndex[pos] = topIndex[pos - 1];
            pos--;
          }
          topIndex[pos] = k;
        } else if (value > salience[topIndex[MAX_CANDIDATES - 1]]) {
          let pos = MAX_CANDIDATES - 1;
          while (pos > 0 && salience[topIndex[pos - 1]] < value) {
            topIndex[pos] = topIndex[pos - 1];
            pos--;
          }
          topIndex[pos] = k;
        }
      }
    }

    if (topCount === 0 && salMax > 1e-9) {
      let best = 0;
      for (let k = 1; k < grid.binCount; k++) {
        if (salience[k] > salience[best]) best = k;
      }
      topIndex[0] = best;
      topCount = 1;
    }

    let accepted = 0;
    const base = t * MAX_CANDIDATES;
    for (let p = 0; p < topCount; p++) {
      const idx = topIndex[p];
      let separated = true;
      for (let a = 0; a < accepted; a++) {
        if (Math.abs(idx - acceptedIndex[a]) < 3) {
          separated = false;
          break;
        }
      }
      if (!separated) continue;

      const k = idx;
      const left = salience[k - 1];
      const centerValue = salience[k];
      const right = salience[k + 1];
      const denom = left - 2 * centerValue + right;
      let delta =
        Math.abs(denom) > 1e-12
          ? (0.5 * (left - right)) / denom
          : 0;
      if (!Number.isFinite(delta) || Math.abs(delta) > 0.5) delta = 0;

      const midi =
        69 +
        12 *
          Math.log2(
            (MIN_F0 * Math.pow(2, ((k + delta) * CENTS_STEP) / 1200)) /
              440,
          );
      candidateFreq[base + accepted] =
        440 * Math.pow(2, (midi - 69) / 12);
      candidateMidi[base + accepted] = midi;
      candidateScore[base + accepted] = clamp(centerValue / salMax, 0, 1);
      acceptedIndex[accepted] = idx;
      accepted++;
    }
    candidateCount[t] = accepted;

    if ((t & 127) === 0) {
      report('分析频谱', 0.08 + 0.74 * ((t + 1) / frameCount));
    }
  }

  return {
    count: frameCount,
    quality,
    candidateCount,
    candidateFreq,
    candidateMidi,
    candidateScore,
  };
}

function salienceProminence(
  max: number,
  sum: number,
  count: number,
): number {
  if (max <= 1e-9) return 1;
  const mean = sum / count;
  return max / (mean + 1e-9);
}

/**
 * Viterbi：候选峰为观测状态，另有一个 unvoiced 状态。
 * 转移代价惩罚大跳和八度跳，避免在相邻帧的谐波峰之间来回切换。
 */
function trackPitch(analysis: AnalysisFrames): Float32Array {
  const count = analysis.count;
  const prev = new Float64Array(STATE_STRIDE);
  const cur = new Float64Array(STATE_STRIDE);
  const back = new Int16Array(count * STATE_STRIDE);
  back.fill(-1);

  for (let t = 0; t < count; t++) {
    const candidates = analysis.candidateCount[t];
    const base = t * MAX_CANDIDATES;
    const q = analysis.quality[t];

    const localUnvoiced = 0.5 - 0.25 * q;
    if (t === 0) {
      for (let k = 0; k < candidates; k++) {
        prev[k] =
          0.25 +
          0.75 * analysis.candidateScore[base + k] * q;
      }
      prev[UNVOICED] = localUnvoiced;
      continue;
    }

    const prevCandidates = analysis.candidateCount[t - 1];
    const prevBase = (t - 1) * MAX_CANDIDATES;
    const backBase = t * STATE_STRIDE;

    for (let k = 0; k < candidates; k++) {
      let best = prev[UNVOICED] - VOICING_COST;
      let bestState = UNVOICED;
      const midi = analysis.candidateMidi[base + k];
      for (let j = 0; j < prevCandidates; j++) {
        const score =
          prev[j] -
          transitionCost(midi - analysis.candidateMidi[prevBase + j]);
        if (score > best) {
          best = score;
          bestState = j;
        }
      }
      cur[k] = best + 0.25 + 0.75 * analysis.candidateScore[base + k] * q;
      back[backBase + k] = bestState;
    }

    let bestUnvoiced = prev[UNVOICED];
    let bestUnvoicedState = UNVOICED;
    for (let j = 0; j < prevCandidates; j++) {
      const score = prev[j] - VOICING_COST;
      if (score > bestUnvoiced) {
        bestUnvoiced = score;
        bestUnvoicedState = j;
      }
    }
    cur[UNVOICED] = bestUnvoiced + localUnvoiced;
    back[backBase + UNVOICED] = bestUnvoicedState;

    prev.set(cur);
  }

  let bestState = UNVOICED;
  let bestScore = prev[UNVOICED];
  const lastCandidates = analysis.candidateCount[count - 1];
  for (let k = 0; k < lastCandidates; k++) {
    if (prev[k] > bestScore) {
      bestScore = prev[k];
      bestState = k;
    }
  }

  const out = new Float32Array(count);
  const chosen = new Int16Array(count);
  let state = bestState;
  for (let t = count - 1; t >= 0; t--) {
    chosen[t] = state;
    if (t > 0) state = back[t * STATE_STRIDE + state];
  }
  for (let t = 0; t < count; t++) {
    const k = chosen[t];
    if (k === UNVOICED || k < 0) continue;
    out[t] = analysis.candidateFreq[t * MAX_CANDIDATES + k];
  }
  return out;
}

function transitionCost(deltaSemitones: number): number {
  const distance = Math.abs(deltaSemitones);
  if (distance < 0.2) return 0;
  let cost = 0.045 * Math.min(distance, 12) + 0.025 * Math.max(0, distance - 12);
  if (distance >= 10.5 && distance <= 13.5) cost += 0.2;
  else if (distance >= 22.5 && distance <= 25.5) cost += 0.28;
  return cost;
}

interface RefinedFrames {
  midi: Float32Array;
  f0: (number | null)[];
  clarity: Float32Array;
}

/**
 * 清理 Viterbi 轨迹：去掉过短的 voiced 段、补上辅音造成的小缺口，
 * 再根据每帧质量生成对外 f0/clarity。
 */
function refineVoicing(
  rawPitch: Float32Array,
  quality: Float32Array,
  frameCount: number,
): RefinedFrames {
  const midi = new Float32Array(frameCount);
  const clarity = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    if (rawPitch[i] > 0) {
      midi[i] = 69 + 12 * Math.log2(rawPitch[i] / 440);
      clarity[i] = quality[i];
    } else {
      midi[i] = Number.NaN;
      clarity[i] = 0;
    }
  }

  let i = 0;
  while (i < frameCount) {
    if (Number.isNaN(midi[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < frameCount && !Number.isNaN(midi[end])) end++;
    if (end - i < MIN_VOICED_RUN) {
      for (let j = i; j < end; j++) {
        midi[j] = Number.NaN;
        clarity[j] = 0;
      }
    }
    i = end;
  }

  i = 0;
  while (i < frameCount) {
    if (!Number.isNaN(midi[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < frameCount && Number.isNaN(midi[end])) end++;
    const gap = end - i;
    if (
      i > 0 &&
      end < frameCount &&
      gap <= MAX_GAP_FILL &&
      Math.abs(midi[end] - midi[i - 1]) <= 1.5
    ) {
      const from = midi[i - 1];
      const to = midi[end];
      for (let j = 0; j < gap; j++) {
        const ratio = (j + 1) / (gap + 1);
        midi[i + j] = from + (to - from) * ratio;
        clarity[i + j] = Math.min(clarity[i - 1], clarity[end]) * 0.7;
      }
    }
    i = end;
  }

  const f0: (number | null)[] = new Array(frameCount);
  for (let j = 0; j < frameCount; j++) {
    f0[j] = Number.isNaN(midi[j])
      ? null
      : 440 * Math.pow(2, (midi[j] - 69) / 12);
    if (f0[j] === null) clarity[j] = 0;
  }
  return { midi, f0, clarity };
}

/**
 * 用 50 ms 左右的两侧中位数检测音高台阶；短于 80 ms 的碎片并入相邻音符或丢弃。
 */
function buildNotes(
  midi: Float32Array,
  frameCount: number,
  duration: number,
): Note[] {
  const smoothed = medianSmooth(midi, frameCount, NOTE_SMOOTH_RADIUS);
  const scratch = new Float64Array(5);
  const notes: Note[] = [];
  let i = 0;

  while (i < frameCount) {
    while (i < frameCount && Number.isNaN(midi[i])) i++;
    if (i >= frameCount) break;
    const runStart = i;
    while (i < frameCount && !Number.isNaN(midi[i])) i++;
    const runEnd = i;

    const segments: Array<{ start: number; end: number }> = [];
    let segmentStart = runStart;
    for (let j = runStart + 5; j <= runEnd - 5; j++) {
      if (j - segmentStart < 6) continue;
      const left = median5(smoothed, j - 5, scratch);
      const right = median5(smoothed, j, scratch);
      if (Math.abs(right - left) > 0.6) {
        segments.push({ start: segmentStart, end: j });
        segmentStart = j;
      }
    }
    segments.push({ start: segmentStart, end: runEnd });

    for (const segment of segments) {
      const start = segment.start;
      const end = segment.end;
      const noteStart = start * HOP_SECONDS;
      const noteEnd = Math.min(duration, end * HOP_SECONDS);
      if (noteEnd <= noteStart) continue;

      const from = start + (end - start >= 6 ? 1 : 0);
      const to = end - (end - start >= 6 ? 1 : 0);
      const noteMidi = medianRange(midi, from, to);

      if (noteEnd - noteStart < MIN_NOTE_SECONDS) {
        const last = notes[notes.length - 1];
        if (last && noteStart - last.end < 0.06) {
          last.end = Math.max(last.end, noteEnd);
        }
        continue;
      }

      const last = notes[notes.length - 1];
      if (
        last &&
        noteStart - last.end < 0.03 &&
        Math.abs(last.midi - noteMidi) < 0.35
      ) {
        last.end = Math.max(last.end, noteEnd);
        continue;
      }

      notes.push({ start: noteStart, end: noteEnd, midi: noteMidi });
    }
  }

  // 被短碎片延长后仍可能出现重叠，统一裁掉。
  for (let n = 1; n < notes.length; n++) {
    if (notes[n].start < notes[n - 1].end) {
      notes[n].start = notes[n - 1].end;
    }
  }
  return notes.filter((note) => note.end > note.start);
}

function median5(values: Float32Array, start: number, scratch: Float64Array): number {
  for (let j = 0; j < 5; j++) scratch[j] = values[start + j];
  for (let a = 1; a < 5; a++) {
    const value = scratch[a];
    let b = a - 1;
    while (b >= 0 && scratch[b] > value) {
      scratch[b + 1] = scratch[b];
      b--;
    }
    scratch[b + 1] = value;
  }
  return scratch[2];
}

/** 仅在 voiced 段内做中值滤波，保留 NaN 缺口和音符台阶的位置。 */
function medianSmooth(
  values: Float32Array,
  frameCount: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(frameCount);
  out.fill(Number.NaN);
  const scratch = new Float64Array(radius * 2 + 1);
  let i = 0;
  while (i < frameCount) {
    while (i < frameCount && Number.isNaN(values[i])) i++;
    if (i >= frameCount) break;
    const start = i;
    while (i < frameCount && !Number.isNaN(values[i])) i++;
    const end = i;
    for (let j = start; j < end; j++) {
      const from = Math.max(start, j - radius);
      const to = Math.min(end - 1, j + radius);
      const length = to - from + 1;
      for (let k = 0; k < length; k++) scratch[k] = values[from + k];
      for (let a = 1; a < length; a++) {
        const value = scratch[a];
        let b = a - 1;
        while (b >= 0 && scratch[b] > value) {
          scratch[b + 1] = scratch[b];
          b--;
        }
        scratch[b + 1] = value;
      }
      const mid = length >> 1;
      out[j] =
        length % 2 === 0
          ? (scratch[mid - 1] + scratch[mid]) * 0.5
          : scratch[mid];
    }
  }
  return out;
}

function medianRange(
  values: Float32Array,
  start: number,
  end: number,
): number {
  const length = end - start;
  const copy = new Float64Array(length);
  for (let i = 0; i < length; i++) copy[i] = values[start + i];
  copy.sort();
  const mid = length >> 1;
  return length % 2 === 0 ? (copy[mid - 1] + copy[mid]) * 0.5 : copy[mid];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
