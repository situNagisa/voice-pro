/** 纯 TypeScript 的 DSP 基础件：重采样、窗函数、radix-2 FFT。 */

const RESAMPLE_HALF_TAPS = 64;
const RESAMPLE_PHASES = 1024;
const MAX_RESAMPLE_CUTOFF = 6300;
const kernelCache = new Map<string, Float32Array>();

/**
 * 带低通的 windowed-sinc 重采样。同时完成抗混叠滤波和采样率变换。
 * 每个输出点只计算需要的抽头，代价约 O(输出长度 * 128)。
 */
export function resample(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
  cutoffHz = MAX_RESAMPLE_CUTOFF,
): Float32Array {
  if (inputRate === outputRate) return input;
  const n = input.length;
  if (n === 0) return new Float32Array(0);

  const cutoff = Math.min(cutoffHz, inputRate * 0.45, outputRate * 0.45);
  const kernel = getKernel(cutoff, inputRate);
  const taps = RESAMPLE_HALF_TAPS * 2;
  const step = inputRate / outputRate;
  const outLen = Math.max(1, Math.floor((n - 1) / step) + 1);
  const out = new Float32Array(outLen);

  for (let o = 0; o < outLen; o++) {
    const pos = o * step;
    const base = Math.floor(pos);
    const phase = Math.min(
      RESAMPLE_PHASES - 1,
      Math.round((pos - base) * RESAMPLE_PHASES),
    );
    const offset = phase * taps;
    let acc = 0;
    for (let t = 0; t < taps; t++) {
      let idx = base - RESAMPLE_HALF_TAPS + 1 + t;
      if (idx < 0) idx = 0;
      else if (idx >= n) idx = n - 1;
      acc += input[idx] * kernel[offset + t];
    }
    out[o] = acc;
  }

  return out;
}

function getKernel(cutoff: number, inputRate: number): Float32Array {
  const key = `${cutoff}|${inputRate}`;
  const cached = kernelCache.get(key);
  if (cached) return cached;

  const taps = RESAMPLE_HALF_TAPS * 2;
  const kernel = new Float32Array(RESAMPLE_PHASES * taps);
  const scale = (2 * cutoff) / inputRate;

  for (let p = 0; p < RESAMPLE_PHASES; p++) {
    const frac = p / RESAMPLE_PHASES;
    const offset = p * taps;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const d = -RESAMPLE_HALF_TAPS + 1 + t - frac;
      const x = scale * d;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = d / RESAMPLE_HALF_TAPS;
      const win =
        Math.abs(u) >= 1
          ? 0
          : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const w = sinc * win;
      kernel[offset + t] = w;
      sum += w;
    }
    // 每个相位单独归一化，避免直流增益随 fractional delay 波动。
    const inv = sum !== 0 ? 1 / sum : 0;
    for (let t = 0; t < taps; t++) kernel[offset + t] *= inv;
  }

  kernelCache.set(key, kernel);
  return kernel;
}

/** periodic Hann 窗，适合 STFT 的 overlap-add 分析。 */
export function hannWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return win;
}

/**
 * 原地 radix-2 复数 FFT（DIT）。表在构造时预计算，分析循环里可反复调用。
 */
export class Radix2Fft {
  readonly size: number;
  private readonly reversed: Uint32Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    const bits = Math.round(Math.log2(size));
    const reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let value = i;
      let result = 0;
      for (let b = 0; b < bits; b++) {
        result = (result << 1) | (value & 1);
        value >>= 1;
      }
      reversed[i] = result;
    }
    const half = size >> 1;
    const cosTable = new Float64Array(half);
    const sinTable = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const angle = (2 * Math.PI * k) / size;
      cosTable[k] = Math.cos(angle);
      sinTable[k] = Math.sin(angle);
    }
    this.reversed = reversed;
    this.cosTable = cosTable;
    this.sinTable = sinTable;
  }

  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    const reversed = this.reversed;
    const cosTable = this.cosTable;
    const sinTable = this.sinTable;

    for (let i = 0; i < n; i++) {
      const j = reversed[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const twiddleStep = n / len;
      for (let start = 0; start < n; start += len) {
        for (let j = 0, k = 0; j < half; j++, k += twiddleStep) {
          const wr = cosTable[k];
          const wi = -sinTable[k];
          const a = start + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
