export interface SeparateRequest {
  type: 'separate';
  /** 44.1 kHz、双声道、可直接 transfer 的 PCM。 */
  channels: Float32Array[];
  modelUrl: string;
  preferWebGPU: boolean;
}

/** 快速模式：主线程先下载模型，再让每个 Worker 建自己的会话。 */
export type QuickRequest =
  | {
      type: 'init';
      /** 模型字节；每个 Worker 拿一份副本。 */
      model: ArrayBuffer;
      preferWebGPU: boolean;
    }
  | {
      type: 'chunk';
      id: number;
      left: Float32Array;
      right: Float32Array;
    };

export type SeparateResponse =
  | { type: 'progress'; stage: string; ratio: number }
  | {
      type: 'done';
      sampleRate: number;
      vocals: Float32Array[];
      accompaniment: Float32Array[];
    }
  | { type: 'error'; message: string }
  | { type: 'ready'; runtime: 'webgpu' | 'wasm' }
  | {
      type: 'chunk';
      id: number;
      vocalsL: Float32Array;
      vocalsR: Float32Array;
    };
