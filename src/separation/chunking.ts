import {
  CHUNK_SAMPLES,
  FREQ_BINS,
  FRAMES,
  MODEL_RATE,
  ChunkSpectrogram,
} from './stft';

/** 相邻两段的默认重叠秒数，靠交叉淡入淡出拼接。 */
export const DEFAULT_OVERLAP_SECONDS = 1;

export interface ChunkOptions {
  overlapSeconds?: number;
}

/** 把 [1,4,FREQ_BINS,FRAMES] 的复数频谱送进模型，返回同形状输出。引擎无关，浏览器和 node 各自实现。 */
export type ChunkRunner = (input: Float32Array) => Promise<Float32Array>;

function fadeIn(x: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

export function chunkTensorShape(): [number, number, number, number] {
  return [1, 4, FREQ_BINS, FRAMES];
}

/**
 * 对 44.1 kHz 双声道音频分段推理并拼接，返回估计的人声。
 * 与具体推理引擎无关：浏览器端 onnxruntime-web、评测脚本里的 onnxruntime-node 共用这一份。
 */
export async function separateChunked(
  channels: Float32Array[],
  runChunk: ChunkRunner,
  report: (stage: string, ratio: number) => void,
  options: ChunkOptions = {},
): Promise<Float32Array[]> {
  const OVERLAP = Math.round(
    (options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS) * MODEL_RATE,
  );
  const left = channels[0];
  const right = channels[1] ?? channels[0];
  const total = Math.min(left.length, right.length);
  if (total === 0) {
    throw new Error('音频为空，无法分离');
  }

  const step = CHUNK_SAMPLES - OVERLAP;
  const chunkCount = Math.max(1, Math.ceil((total - OVERLAP) / step));
  const vocalsL = new Float32Array(total);
  const vocalsR = new Float32Array(total);
  const weights = new Float32Array(total);
  const spectrogram = new ChunkSpectrogram();
  const chunkL = new Float32Array(CHUNK_SAMPLES);
  const chunkR = new Float32Array(CHUNK_SAMPLES);

  for (let index = 0; index < chunkCount; index++) {
    const start = index * step;
    const valid = Math.min(CHUNK_SAMPLES, total - start);
    if (valid <= 0) break;

    chunkL.fill(0);
    chunkR.fill(0);
    chunkL.set(left.subarray(start, start + valid));
    chunkR.set(right.subarray(start, start + valid));

    const output = await runChunk(spectrogram.stft(chunkL, chunkR));
    const separatedL = spectrogram.istft(output, 0);
    const separatedR = spectrogram.istft(output, 1);

    const fadeInChunk = start > 0;
    const fadeOutChunk = start + CHUNK_SAMPLES < total;
    const fadeOutStart = CHUNK_SAMPLES - OVERLAP;
    for (let i = 0; i < valid; i++) {
      let weight = 1;
      if (fadeInChunk && i < OVERLAP) weight *= fadeIn(i / OVERLAP);
      if (fadeOutChunk && i >= fadeOutStart) {
        weight *= 1 - fadeIn((i - fadeOutStart) / OVERLAP);
      }
      vocalsL[start + i] += separatedL[i] * weight;
      vocalsR[start + i] += separatedR[i] * weight;
      weights[start + i] += weight;
    }

    report(
      `分离人声 ${index + 1}/${chunkCount}`,
      (index + 1) / chunkCount,
    );
  }

  for (let i = 0; i < total; i++) {
    const weight = weights[i];
    if (weight > 1e-6) {
      vocalsL[i] /= weight;
      vocalsR[i] /= weight;
    }
  }
  return [vocalsL, vocalsR];
}
