import * as ort from 'onnxruntime-web/webgpu';
import { chunkTensorShape, separateChunked } from './chunking';

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

  const model = await fetchModel(options.modelUrl, options.report);
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
