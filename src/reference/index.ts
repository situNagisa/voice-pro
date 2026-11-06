import type { ExtractProgress, ReferenceMelody } from '../core/types';
import { isSyntheticAudio } from '../core/audioFlags';
import { separateVocals } from '../separation';
import type { ExtractRequest, WorkerResponse } from './protocol';

/**
 * 从用户导入的歌曲（含伴奏）提取人声旋律。全部在本地运行。
 * 先做人声分离，再对干净人声跑原有提取；分离不可用时回退到整曲直接提取。
 * 由 reference 模块实现；UI 侧只依赖这个签名。
 */
export async function extractReferenceMelody(
  audio: AudioBuffer,
  onProgress?: ExtractProgress,
  signal?: AbortSignal,
): Promise<ReferenceMelody> {
  if (signal?.aborted) {
    throw new DOMException('提取已取消', 'AbortError');
  }
  if (audio.numberOfChannels === 0) {
    throw new Error('音频没有可用声道');
  }

  const notify = (stage: string, ratio: number): void => {
    try {
      onProgress?.(stage, ratio);
    } catch {
      // UI 回调抛错不应中断提取。
    }
  };

  let source = audio;
  let cleanVocals = false;
  if (isSyntheticAudio(audio)) {
    // 合成示例歌本身已经是“人声居中 + 伴奏避开中置”，直接走原提取效果最好。
    notify('示例歌直接提取', 0.02);
  } else {
    try {
      const separated = await separateVocals(
        audio,
        (stage, ratio) => notify(stage, ratio * 0.8),
        signal,
      );
      source = separated.vocals;
      cleanVocals = true;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new DOMException('提取已取消', 'AbortError');
      }
      console.warn('人声分离失败，回退到直接提取：', error);
      notify('人声分离不可用，直接提取', 0.02);
    }
  }

  if (signal?.aborted) {
    throw new DOMException('提取已取消', 'AbortError');
  }

  // 必须复制：AudioBuffer 的内部 buffer 属于调用方，直接 transfer 会让播放数据失效。
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    channels.push(new Float32Array(source.getChannelData(channel)));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  const workerProgressBase = cleanVocals ? 0.8 : 0.02;
  const workerProgressSpan = 1 - workerProgressBase;

  return new Promise<ReferenceMelody>((resolve, reject) => {
    let settled = false;

    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    }

    function fail(error: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function onAbort(): void {
      fail(new DOMException('提取已取消', 'AbortError'));
    }

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (settled) return;
      const message = event.data;
      if (message.type === 'progress') {
        notify(
          message.stage,
          workerProgressBase + message.ratio * workerProgressSpan,
        );
        return;
      }
      if (message.type === 'done') {
        settled = true;
        cleanup();
        resolve(message.melody);
        return;
      }
      fail(new Error(message.message || '旋律提取失败'));
    };

    worker.onerror = (event: ErrorEvent) => {
      fail(new Error(event.message || '旋律提取 Worker 出错'));
    };
    worker.onmessageerror = () => {
      fail(new Error('旋律提取结果无法反序列化'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    notify('准备音频', workerProgressBase);

    const request: ExtractRequest = {
      type: 'extract',
      sampleRate: source.sampleRate,
      duration: source.duration,
      channels,
      cleanVocals,
    };
    if (settled) return;
    try {
      const transfer = channels.map((channel) => channel.buffer as ArrayBuffer);
      worker.postMessage(request, transfer);
    } catch (error) {
      fail(error);
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
