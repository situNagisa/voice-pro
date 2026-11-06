import type { SeparateRequest, SeparateResponse } from './protocol';
import { fetchModelBuffer } from './model';
import { separateQuick } from './quick';
import { MODEL_RATE } from './stft';

export interface SeparationResult {
  vocals: AudioBuffer;
  accompaniment: AudioBuffer;
}

export type SeparationProgress = (stage: string, ratio: number) => void;

const MODEL_PATH = 'models/kuielab_a_vocals.onnx';

function abortError(): DOMException {
  return new DOMException('人声分离已取消', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function reportSafely(
  onProgress: SeparationProgress | undefined,
  stage: string,
  ratio: number,
): void {
  try {
    onProgress?.(stage, ratio);
  } catch {
    // UI 回调抛错不应中断分离。
  }
}

function toStereoChannels(audio: AudioBuffer): Float32Array[] {
  const length = audio.length;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const first = audio.getChannelData(0);
  left.set(first);

  if (audio.numberOfChannels > 1) {
    right.set(audio.getChannelData(1));
  } else {
    right.set(first);
  }

  if (audio.numberOfChannels > 2) {
    const center = audio.getChannelData(2);
    for (let i = 0; i < length; i++) {
      left[i] += center[i] * 0.5;
      right[i] += center[i] * 0.5;
    }
  }

  return [left, right];
}

function linearResample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  length: number,
): Float32Array {
  const out = new Float32Array(length);
  if (input.length === 0) return out;
  const step = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const base = Math.floor(pos);
    const frac = pos - base;
    const a = input[Math.min(base, input.length - 1)] ?? 0;
    const b = input[Math.min(base + 1, input.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

async function resampleChannels(
  channels: Float32Array[],
  fromRate: number,
  toRate: number,
): Promise<Float32Array[]> {
  if (fromRate === toRate) return channels;
  const sourceLength = channels[0]?.length ?? 0;
  const targetLength = Math.max(
    1,
    Math.round((sourceLength * toRate) / fromRate),
  );
  if (typeof OfflineAudioContext === 'undefined') {
    return channels.map((channel) =>
      linearResample(channel, fromRate, toRate, targetLength),
    );
  }

  try {
    const context = new OfflineAudioContext(
      channels.length,
      targetLength,
      toRate,
    );
    const buffer = context.createBuffer(channels.length, sourceLength, fromRate);
    channels.forEach((channel, index) =>
      buffer.getChannelData(index).set(channel),
    );
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    return channels.map(
      (_, index) => new Float32Array(rendered.getChannelData(index)),
    );
  } catch (error) {
    console.warn('浏览器重采样失败，改用线性插值：', error);
    return channels.map((channel) =>
      linearResample(channel, fromRate, toRate, targetLength),
    );
  }
}

function createAudioBuffer(
  channels: Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const length = Math.max(1, channels[0]?.length ?? 0);
  if (typeof AudioBuffer !== 'undefined') {
    try {
      const buffer = new AudioBuffer({
        length,
        numberOfChannels: channels.length,
        sampleRate,
      });
      channels.forEach((channel, index) =>
        buffer.getChannelData(index).set(channel.subarray(0, length)),
      );
      return buffer;
    } catch {
      // 极老的 WebView 没有 AudioBuffer 构造器，走 OfflineAudioContext。
    }
  }
  const context = new OfflineAudioContext(
    channels.length,
    length,
    sampleRate,
  );
  const buffer = context.createBuffer(channels.length, length, sampleRate);
  channels.forEach((channel, index) => {
    const target = buffer.getChannelData(index);
    target.set(channel.subarray(0, length));
  });
  return buffer;
}

/**
 * 本地分离人声与伴奏。音频不会离开设备。
 * 输入可以是任意采样率/声道数，内部统一到 44.1 kHz 双声道推理，
 * 输出保持输入的采样率和时长；单声道输入输出单声道。
 */
export type SeparationSpeed = 'standard' | 'fast'

export interface SeparateOptions {
  /** 快速模式：分段并行 + 0.5 s 重叠；默认标准模式。 */
  speed?: SeparationSpeed
}

export async function separateVocals(
  audio: AudioBuffer,
  onProgress?: SeparationProgress,
  signal?: AbortSignal,
  options: SeparateOptions = {},
): Promise<SeparationResult> {
  throwIfAborted(signal);
  if (audio.numberOfChannels === 0 || audio.length === 0) {
    throw new Error('音频为空，无法分离人声');
  }

  reportSafely(onProgress, '准备人声分离', 0);
  const stereo = toStereoChannels(audio);
  const resampled = await resampleChannels(
    stereo,
    audio.sampleRate,
    MODEL_RATE,
  );
  throwIfAborted(signal);

  const base = import.meta.env.BASE_URL || '/';
  const modelUrl = new URL(`${base}${MODEL_PATH}`, window.location.href).href;
  const preferWebGPU =
    typeof navigator !== 'undefined' && Boolean(navigator.gpu);

  let separated: { vocals: Float32Array[]; accompaniment: Float32Array[] };
  if (options.speed === 'fast') {
    try {
      const model = await fetchModelBuffer(modelUrl, (stage, ratio) =>
        reportSafely(onProgress, stage, Math.min(0.1, ratio)),
      );
      throwIfAborted(signal);
      separated = await separateQuick(resampled, {
        model,
        preferWebGPU,
        workerCount: quickWorkerCount(),
        onProgress: (stage, ratio) =>
          reportSafely(onProgress, stage, 0.1 + 0.86 * ratio),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw abortError();
      console.warn('[voice-pro] 快速分离失败，回退到标准模式', error);
      reportSafely(onProgress, '快速模式不可用，改用标准分离', 0.02);
      separated = await runStandardSeparation(
        resampled,
        modelUrl,
        preferWebGPU,
        onProgress,
        signal,
      );
    }
  } else {
    separated = await runStandardSeparation(
      resampled,
      modelUrl,
      preferWebGPU,
      onProgress,
      signal,
    );
  }

  throwIfAborted(signal);
  reportSafely(onProgress, '整理分离结果', 0.99);

  const mono = audio.numberOfChannels === 1;
  let vocalsChannels = separated.vocals;
  let accompanimentChannels = separated.accompaniment;
  if (mono) {
    const mix = (channels: Float32Array[]): Float32Array => {
      const out = new Float32Array(channels[0].length);
      for (let i = 0; i < out.length; i++) {
        out[i] = (channels[0][i] + channels[1][i]) * 0.5;
      }
      return out;
    };
    vocalsChannels = [mix(separated.vocals)];
    accompanimentChannels = [mix(separated.accompaniment)];
  }

  const [vocalsData, accompanimentData] = await Promise.all([
    resampleChannels(vocalsChannels, MODEL_RATE, audio.sampleRate),
    resampleChannels(accompanimentChannels, MODEL_RATE, audio.sampleRate),
  ]);
  throwIfAborted(signal);
  const vocals = createAudioBuffer(vocalsData, audio.sampleRate);
  const accompaniment = createAudioBuffer(accompanimentData, audio.sampleRate);
  reportSafely(onProgress, '人声分离完成', 1);

  return { vocals, accompaniment };
}

function runStandardSeparation(
  channels: Float32Array[],
  modelUrl: string,
  preferWebGPU: boolean,
  onProgress: SeparationProgress | undefined,
  signal: AbortSignal | undefined,
): Promise<{ vocals: Float32Array[]; accompaniment: Float32Array[] }> {
  throwIfAborted(signal);
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });
  if (signal?.aborted) {
    worker.terminate();
    throw abortError();
  }

  return new Promise<{
    vocals: Float32Array[];
    accompaniment: Float32Array[];
  }>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    function onAbort(): void {
      fail(abortError());
    }

    worker.onmessage = (event: MessageEvent<SeparateResponse>) => {
      if (settled) return;
      const message = event.data;
      if (message.type === 'progress') {
        reportSafely(onProgress, message.stage, message.ratio);
        return;
      }
      if (message.type === 'done') {
        settled = true;
        cleanup();
        resolve({
          vocals: message.vocals,
          accompaniment: message.accompaniment,
        });
        return;
      }
      if (message.type === 'error') {
        fail(new Error(message.message || '人声分离失败'));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      fail(new Error(event.message || '人声分离 Worker 出错'));
    };
    worker.onmessageerror = () => {
      fail(new Error('人声分离结果无法反序列化'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    const request: SeparateRequest = {
      type: 'separate',
      channels,
      modelUrl,
      preferWebGPU,
    };
    try {
      worker.postMessage(
        request,
        channels.map((channel) => channel.buffer as ArrayBuffer),
      );
    } catch (error) {
      fail(error);
    }
  });
}

/** 手机内存有限：6 GB 以上开 2 路，4 GB 级只开 1 路；桌面最多 3 路。 */
function quickWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  // 手机内存有限；拿不到 deviceMemory 时按 2 路试，失败会自动回退标准模式。
  const mobileCap = memory == null ? 2 : memory >= 6 ? 2 : 1;
  const cap = mobile ? mobileCap : 3;
  return Math.max(1, Math.min(cap, Math.max(1, cores - 1)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
