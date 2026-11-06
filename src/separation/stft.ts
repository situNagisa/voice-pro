import { Radix2Fft } from '../reference/dsp';

/**
 * MDX-Net（kuielab_a_vocals）的复数频谱前端。
 * 模型固定使用 44.1 kHz、n_fft=6144、hop=1024，一段 512 帧（约 11.87 s）。
 * 6144 = 3 × 2048，用三次 2048 点 FFT 组合，避免为 6144 写一套通用 FFT。
 */

export const MODEL_RATE = 44100;
export const N_FFT = 6144;
export const HOP = 1024;
export const FRAMES = 512;
/** 模型只保留 0–2047 号频点（约 14.7 kHz 以下） */
export const FREQ_BINS = 2048;
export const CHUNK_SAMPLES = HOP * (FRAMES - 1);
const PAD = N_FFT >> 1;
const PARTS = 3;
const SUB_SIZE = N_FFT / PARTS;
const OLA_LENGTH = (FRAMES - 1) * HOP + N_FFT;
const TWO_PI = Math.PI * 2;

/** periodic Hann，和 torch.stft / torch.istft 的默认窗一致 */
function hann(size: number): Float32Array {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / size);
  }
  return out;
}

class Fft6144 {
  private readonly fft = new Radix2Fft(SUB_SIZE);
  private readonly cosTable = new Float64Array(N_FFT);
  private readonly sinTable = new Float64Array(N_FFT);
  private readonly partRe: Float64Array[] = [];
  private readonly partIm: Float64Array[] = [];

  constructor() {
    for (let r = 0; r < PARTS; r++) {
      this.partRe.push(new Float64Array(SUB_SIZE));
      this.partIm.push(new Float64Array(SUB_SIZE));
    }
    for (let i = 0; i < N_FFT; i++) {
      const angle = (TWO_PI * i) / N_FFT;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }
  }

  /** 正变换；re/im 长度 6144，limit 指定需要计算的前多少个频点。 */
  forward(re: Float64Array, im: Float64Array, limit = N_FFT): void {
    for (let r = 0; r < PARTS; r++) {
      const pr = this.partRe[r];
      const pi = this.partIm[r];
      for (let m = 0; m < SUB_SIZE; m++) {
        pr[m] = re[PARTS * m + r];
        pi[m] = im[PARTS * m + r];
      }
      this.fft.transform(pr, pi);
    }

    for (let k = 0; k < limit; k++) {
      const q = k % SUB_SIZE;
      let sr = 0;
      let si = 0;
      for (let r = 0; r < PARTS; r++) {
        const angle = (r * k) % N_FFT;
        const c = this.cosTable[angle];
        const s = this.sinTable[angle];
        const pr = this.partRe[r][q];
        const pi = this.partIm[r][q];
        // (pr + i·pi) · (cos - i·sin)
        sr += pr * c + pi * s;
        si += pi * c - pr * s;
      }
      re[k] = sr;
      im[k] = si;
    }
  }

  /** 逆变换；调用前需保证 re/im 已按共轭对称补全到 6144 点。 */
  inverse(re: Float64Array, im: Float64Array): void {
    const outRe = this.partRe;
    const outIm = this.partIm;

    for (let q = 0; q < SUB_SIZE; q++) {
      for (let r = 0; r < PARTS; r++) {
        let sr = 0;
        let si = 0;
        for (let s = 0; s < PARTS; s++) {
          const k = q + SUB_SIZE * s;
          const angle = (r * k) % N_FFT;
          const c = this.cosTable[angle];
          const sn = this.sinTable[angle];
          const xr = re[k];
          const xi = im[k];
          // (xr + i·xi) · (cos + i·sin)
          sr += xr * c - xi * sn;
          si += xr * sn + xi * c;
        }
        outRe[r][q] = sr;
        outIm[r][q] = si;
      }
    }

    // IFFT_2048(Y) = conj(FFT_2048(conj(Y))) / 2048；
    // 再乘 2048/6144，得到 1/6144 的完整逆变换。
    for (let r = 0; r < PARTS; r++) {
      const pr = outRe[r];
      const pi = outIm[r];
      for (let m = 0; m < SUB_SIZE; m++) pi[m] = -pi[m];
      this.fft.transform(pr, pi);
      for (let m = 0; m < SUB_SIZE; m++) {
        re[PARTS * m + r] = pr[m] / N_FFT;
        im[PARTS * m + r] = -pi[m] / N_FFT;
      }
    }
  }
}

/** 一段音频的 STFT / ISTFT 工作区，复用以减少长音频的分配开销。 */
export class ChunkSpectrogram {
  private readonly fft = new Fft6144();
  private readonly window = hann(N_FFT);
  private readonly paddedL = new Float32Array(CHUNK_SAMPLES + N_FFT);
  private readonly paddedR = new Float32Array(CHUNK_SAMPLES + N_FFT);
  private readonly frameRe = new Float64Array(N_FFT);
  private readonly frameIm = new Float64Array(N_FFT);
  private readonly ola = new Float32Array(OLA_LENGTH);
  private readonly norm = new Float32Array(OLA_LENGTH);

  constructor() {
    for (let t = 0; t < FRAMES; t++) {
      const offset = t * HOP;
      for (let i = 0; i < N_FFT; i++) {
        const w = this.window[i];
        this.norm[offset + i] += w * w;
      }
    }
  }

  stft(left: Float32Array, right: Float32Array): Float32Array {
    const paddedL = this.paddedL;
    const paddedR = this.paddedR;
    paddedL.fill(0);
    paddedR.fill(0);
    paddedL.set(left.subarray(0, Math.min(left.length, CHUNK_SAMPLES)), PAD);
    paddedR.set(right.subarray(0, Math.min(right.length, CHUNK_SAMPLES)), PAD);

    const tensor = new Float32Array(4 * FREQ_BINS * FRAMES);
    const channelSize = FREQ_BINS * FRAMES;
    const re = this.frameRe;
    const im = this.frameIm;
    const window = this.window;

    for (let t = 0; t < FRAMES; t++) {
      const offset = t * HOP;

      // 左声道
      for (let i = 0; i < N_FFT; i++) {
        re[i] = paddedL[offset + i] * window[i];
      }
      im.fill(0);
      this.fft.forward(re, im, FREQ_BINS);
      for (let k = 0; k < FREQ_BINS; k++) {
        tensor[k * FRAMES + t] = re[k];
        tensor[channelSize + k * FRAMES + t] = im[k];
      }

      // 右声道
      for (let i = 0; i < N_FFT; i++) {
        re[i] = paddedR[offset + i] * window[i];
      }
      im.fill(0);
      this.fft.forward(re, im, FREQ_BINS);
      for (let k = 0; k < FREQ_BINS; k++) {
        tensor[2 * channelSize + k * FRAMES + t] = re[k];
        tensor[3 * channelSize + k * FRAMES + t] = im[k];
      }
    }
    return tensor;
  }

  /** 从模型输出的张量还原一个声道（长度 CHUNK_SAMPLES）。 */
  istft(tensor: Float32Array, channel: number): Float32Array {
    const ola = this.ola;
    const re = this.frameRe;
    const im = this.frameIm;
    const window = this.window;
    const channelSize = FREQ_BINS * FRAMES;
    const base = channel * 2 * channelSize;
    const imagBase = base + channelSize;
    ola.fill(0);

    for (let t = 0; t < FRAMES; t++) {
      // 模型输出只有前 2048 个频点，其余按 0 处理并补共轭对称。
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < FREQ_BINS; k++) {
        re[k] = tensor[base + k * FRAMES + t];
        im[k] = tensor[imagBase + k * FRAMES + t];
      }
      for (let k = FREQ_BINS; k <= N_FFT / 2; k++) {
        re[k] = 0;
        im[k] = 0;
      }
      for (let k = N_FFT / 2 + 1; k < N_FFT; k++) {
        re[k] = re[N_FFT - k];
        im[k] = -im[N_FFT - k];
      }

      this.fft.inverse(re, im);
      const offset = t * HOP;
      for (let i = 0; i < N_FFT; i++) {
        ola[offset + i] += re[i] * window[i];
      }
    }

    const out = new Float32Array(CHUNK_SAMPLES);
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const weight = this.norm[PAD + i];
      out[i] = weight > 1e-6 ? ola[PAD + i] / weight : 0;
    }
    return out;
  }
}
