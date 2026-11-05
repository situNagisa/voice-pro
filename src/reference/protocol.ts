import type { ReferenceMelody } from '../core/types';

/** 16 kHz 足够覆盖人声基频与约 8 kHz 以内的谐波，同时让 FFT 开销可控。 */
export const ANALYSIS_RATE = 16000;
/** 对外输出的帧间隔（秒）。 */
export const HOP_SECONDS = 0.01;

export interface ExtractRequest {
  type: 'extract';
  sampleRate: number;
  duration: number;
  /** 已复制、可 transfer 的声道数据（不能直接 transfer AudioBuffer 的内部 buffer）。 */
  channels: Float32Array[];
}

export type WorkerResponse =
  | { type: 'progress'; stage: string; ratio: number }
  | { type: 'done'; melody: ReferenceMelody }
  | { type: 'error'; message: string };
