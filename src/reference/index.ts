import type { ExtractProgress, ReferenceMelody } from '../core/types';
import type { ExtractRequest, WorkerResponse } from './protocol';

/**
 * 从用户导入的歌曲（含伴奏）提取人声旋律。全部在本地运行。
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

  // 必须复制：AudioBuffer 的内部 buffer 属于调用方，直接 transfer 会让播放数据失效。
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    channels.push(new Float32Array(audio.getChannelData(channel)));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

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
        try {
          onProgress?.(message.stage, message.ratio);
        } catch {
          // UI 回调抛错不应中断提取。
        }
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

    try {
      onProgress?.('准备音频', 0);
    } catch {
      // 同上。
    }

    const request: ExtractRequest = {
      type: 'extract',
      sampleRate: audio.sampleRate,
      duration: audio.duration,
      channels,
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
