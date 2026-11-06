import * as ort from 'onnxruntime-web/webgpu';
import { chunkTensorShape, separateChunked } from './chunking';
import { ChunkSpectrogram } from './stft';
import { fetchModelBuffer } from './model';

export interface EngineOptions {
  modelUrl: string;
  wasmPaths: { wasm: string; mjs: string };
  preferWebGPU: boolean;
  report: (stage: string, ratio: number) => void;
  onRuntime?: (runtime: 'webgpu' | 'wasm') => void;
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

/**
 * 对 44.1 kHz 双声道音频做分离。分段与拼接见 chunking.ts，
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

  const model = await fetchModelBuffer(options.modelUrl, options.report);
  options.report('初始化分离模型', 0.09);
  const session = await createSession(model, options);
  options.report('分离人声', 0.1);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const vocals = await separateChunked(
    channels,
    async (input) => {
      const feeds: Record<string, ort.Tensor> = {};
      feeds[inputName] = new ort.Tensor('float32', input, chunkTensorShape());
      const result = await session.run(feeds);
      return result[outputName].data as Float32Array;
    },
    (stage, ratio) => options.report(stage, 0.1 + 0.86 * ratio),
  );

  const accompanimentL = new Float32Array(total);
  const accompanimentR = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    accompanimentL[i] = left[i] - vocals[0][i];
    accompanimentR[i] = right[i] - vocals[1][i];
  }

  options.report('整理分离结果', 0.99);
  return {
    vocals,
    accompaniment: [accompanimentL, accompanimentR],
  };
}


export interface ChunkSeparator {
  runtime: 'webgpu' | 'wasm';
  process(
    left: Float32Array,
    right: Float32Array,
  ): Promise<[Float32Array, Float32Array]>;
}

/**
 * 给快速模式的多 Worker 用：创建一个常驻会话和 STFT 工作区，
 * 每次只接收一段 11.87 s 的 44.1 kHz 双声道 PCM，返回分离后的两个声道。
 */
export async function createChunkSeparator(
  model: ArrayBuffer,
  options: EngineOptions,
): Promise<ChunkSeparator> {
  let runtime: 'webgpu' | 'wasm' = 'wasm';
  const session = await createSession(model, {
    ...options,
    onRuntime: (next) => {
      runtime = next;
      options.onRuntime?.(next);
    },
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const spectrogram = new ChunkSpectrogram();

  return {
    get runtime() {
      return runtime;
    },
    async process(left, right) {
      const input = spectrogram.stft(left, right);
      const feeds: Record<string, ort.Tensor> = {};
      feeds[inputName] = new ort.Tensor('float32', input, chunkTensorShape());
      const result = await session.run(feeds);
      const output = result[outputName].data as Float32Array;
      return [spectrogram.istft(output, 0), spectrogram.istft(output, 1)];
    },
  };
}
