import type { SeparateRequest, SeparateResponse } from './protocol';
import { separateWithModel } from './engine';
import { MODEL_RATE } from './stft';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';

interface WorkerScope {
  onmessage: ((event: MessageEvent<SeparateRequest>) => void) | null;
  postMessage(message: SeparateResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let busy = false;

function absolute(url: string): string {
  return new URL(url, self.location.href).href;
}

scope.onmessage = (event: MessageEvent<SeparateRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'separate' || busy) return;
  busy = true;

  let lastPost = 0;
  const report = (stage: string, ratio: number): void => {
    const now = performance.now();
    if (ratio < 1 && now - lastPost < 80) return;
    lastPost = now;
    scope.postMessage({ type: 'progress', stage, ratio });
  };

  separateWithModel(request.channels, {
    modelUrl: request.modelUrl,
    wasmPaths: { wasm: absolute(wasmUrl), mjs: absolute(mjsUrl) },
    preferWebGPU: request.preferWebGPU,
    report,
    onRuntime: (runtime) => {
      if (runtime === 'wasm' && request.preferWebGPU) {
        console.warn('人声分离使用 WASM 推理（WebGPU 不可用）');
      }
    },
  })
    .then((result) => {
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
    })
    .catch((error: unknown) => {
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      busy = false;
    });
};
