import type { QuickRequest, SeparateRequest, SeparateResponse } from './protocol';
import { createChunkSeparator, separateWithModel } from './engine';
import type { ChunkSeparator } from './engine';
import { MODEL_RATE } from './stft';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';

interface WorkerScope {
  onmessage: ((event: MessageEvent<SeparateRequest | QuickRequest>) => void) | null;
  postMessage(message: SeparateResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let busy = false;
let separator: ChunkSeparator | null = null;

function absolute(url: string): string {
  return new URL(url, self.location.href).href;
}

scope.onmessage = (event: MessageEvent<SeparateRequest | QuickRequest>) => {
  const request = event.data;
  if (!request) return;
  if (request.type === 'separate') {
    void runSeparate(request);
    return;
  }
  if (request.type === 'init') {
    void runInit(request);
    return;
  }
  if (request.type === 'chunk') {
    void runChunk(request);
  }
};

async function runSeparate(request: SeparateRequest): Promise<void> {
  if (busy) return;
  busy = true;

  let lastPost = 0;
  const report = (stage: string, ratio: number): void => {
    const now = performance.now();
    if (ratio < 1 && now - lastPost < 80) return;
    lastPost = now;
    scope.postMessage({ type: 'progress', stage, ratio });
  };

  try {
    const result = await separateWithModel(request.channels, {
      modelUrl: request.modelUrl,
      wasmPaths: { wasm: absolute(wasmUrl), mjs: absolute(mjsUrl) },
      preferWebGPU: request.preferWebGPU,
      report,
      onRuntime: (runtime) => {
        if (runtime === 'wasm' && request.preferWebGPU) {
          console.warn('人声分离使用 WASM 推理（WebGPU 不可用）');
        }
      },
    });
    scope.postMessage(
      {
        type: 'done',
        sampleRate: MODEL_RATE,
        vocals: result.vocals,
        accompaniment: result.accompaniment,
      },
      [
        ...result.vocals.map((channel) => channel.buffer as ArrayBuffer),
        ...result.accompaniment.map((channel) => channel.buffer as ArrayBuffer),
      ],
    );
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy = false;
  }
}

async function runInit(request: Extract<QuickRequest, { type: 'init' }>): Promise<void> {
  try {
    separator = await createChunkSeparator(request.model, {
      modelUrl: '',
      wasmPaths: { wasm: absolute(wasmUrl), mjs: absolute(mjsUrl) },
      preferWebGPU: request.preferWebGPU,
      report: () => undefined,
    });
    scope.postMessage({ type: 'ready', runtime: separator.runtime });
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runChunk(request: Extract<QuickRequest, { type: 'chunk' }>): Promise<void> {
  if (!separator) {
    scope.postMessage({ type: 'error', message: '快速分离 Worker 尚未初始化' });
    return;
  }
  try {
    const [vocalsL, vocalsR] = await separator.process(request.left, request.right);
    scope.postMessage(
      { type: 'chunk', id: request.id, vocalsL, vocalsR },
      [vocalsL.buffer as ArrayBuffer, vocalsR.buffer as ArrayBuffer],
    );
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
