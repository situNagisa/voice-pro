import type { ReferenceMelody, ExtractProgress } from '../core/types';

/**
 * 从用户导入的歌曲（含伴奏）提取人声旋律。全部在本地运行。
 * 由 reference 模块实现；UI 侧只依赖这个签名。
 */
export async function extractReferenceMelody(
  _audio: AudioBuffer,
  _onProgress?: ExtractProgress,
  _signal?: AbortSignal,
): Promise<ReferenceMelody> {
  throw new Error('not implemented');
}
