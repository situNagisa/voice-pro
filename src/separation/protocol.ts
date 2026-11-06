export interface SeparateRequest {
  type: 'separate';
  /** 44.1 kHz、双声道、可直接 transfer 的 PCM。 */
  channels: Float32Array[];
  modelUrl: string;
  preferWebGPU: boolean;
}

export type SeparateResponse =
  | { type: 'progress'; stage: string; ratio: number }
  | {
      type: 'done';
      sampleRate: number;
      vocals: Float32Array[];
      accompaniment: Float32Array[];
    }
  | { type: 'error'; message: string };
