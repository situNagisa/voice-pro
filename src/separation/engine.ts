import * as ort from 'onnxruntime-web/webgpu';
import {
  CHUNK_SAMPLES,
  FREQ_BINS,
  FRAMES,
  MODEL_RATE,
  ChunkSpectrogram,
} from './stft';

/** 模型与推理固定使用 44.1 kHz / 双声道。 */
const OVERLAP = MODEL_RATE; // 1 s 重叠，靠交叉淡入淡出拼接

export interface EngineOptions {
  modelUrl: string;
  wasmPaths: { wasm: string; mjs: string };
  preferWebGPU: boolean;
  report: (stage: string, ratio: number) => void;
  onRuntime?: (runtime: 'webgpu' | 'wasm') => void;
}

async function fetchModel(
  url: string,
  report: EngineOptions['report'],
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载人声分离模型失败（HTTP ${response.status}）`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) {
    report('加载分离模型', 0.06);
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      if (total > 0) {
        report('加载分离模型', Math.min(0.08, (0.08 * loaded) / total));
      }
    }
  }

  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}

async function createSession(
  model: ArrayBuffer,
  options: EngineOptions,
): Promise<ort.InferenceSession> {
  ort.env.wasm.wasmPaths = options.wasmPaths;
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 2)
    : 1;
  ort.env.wasm.simd = true;

  if (options.preferWebGPU) {
    try {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      });
      options.onRuntime?.('webgpu');
      return session;
    } catch (error) {
      console.warn('WebGPU 推理不可用，回退到 WASM：', error);
    }
  }

  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  options.onRuntime?.('wasm');
  return session;
}

function fadeIn(x: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/**
 * 对 44.1 kHz 双声道音频做分离。按 11.87 s 一段、1 s 重叠处理，
 * 人声由模型估计，伴奏用原始混音减去人声，保证全频段并减少残留。
 */
export async function separateWithModel(
  channels: Float32Array[],
  options: EngineOptions,
): Promise<{ vocals: Float32Array[]; accompaniment: Float32Array[] }> {
  const left = channels[0];
  const right = channels[1] ?? channels[0];
  const total = Math.min(left.length, right.length);
  if (total === 0) {
    throw new Error('音频为空，无法分离');
  }

  const model = await fetchModel(options.modelUrl, options.report);
  options.report('初始化分离模型', 0.09);
  const session = await createSession(model, options);
  options.report('分离人声', 0.1);

  const step = CHUNK_SAMPLES - OVERLAP;
  const chunkCount = Math.max(1, Math.ceil((total - OVERLAP) / step));
  const vocalsL = new Float32Array(total);
  const vocalsR = new Float32Array(total);
  const weights = new Float32Array(total);
  const spectrogram = new ChunkSpectrogram();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
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

    const input = spectrogram.stft(chunkL, chunkR);
    const tensor = new ort.Tensor('float32', input, [
      1,
      4,
      FREQ_BINS,
      FRAMES,
    ]);
    const feeds: Record<string, ort.Tensor> = {};
    feeds[inputName] = tensor;
    const result = await session.run(feeds);
    const output = result[outputName].data as Float32Array;
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

    options.report(
      `分离人声 ${index + 1}/${chunkCount}`,
      0.1 + (0.86 * (index + 1)) / chunkCount,
    );
  }

  const accompanimentL = new Float32Array(total);
  const accompanimentR = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const weight = weights[i];
    if (weight > 1e-6) {
      vocalsL[i] /= weight;
      vocalsR[i] /= weight;
    }
    accompanimentL[i] = left[i] - vocalsL[i];
    accompanimentR[i] = right[i] - vocalsR[i];
  }

  options.report('整理分离结果', 0.99);
  return {
    vocals: [vocalsL, vocalsR],
    accompaniment: [accompanimentL, accompanimentR],
  };
}
