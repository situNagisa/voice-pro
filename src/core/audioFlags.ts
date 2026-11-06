/**
 * 已经准备好的音频标记：这类音频在 reference 提取时不需要再做一次人声分离。
 * - 合成示例歌的人声固定居中、伴奏刻意避开中置，现有中置提取已经是最优输入；
 * - 调用方预先把人声分离好、只把 vocals 交给提取时，也打上同样的标记。
 * MDX 人声分离模型对合成音色反而会削掉一部分旋律，所以合成音频跳过分离。
 * 只对内存中的同一个 AudioBuffer 生效，不会误伤别的歌曲。
 */
const syntheticAudio = new WeakSet<AudioBuffer>();

/** 标记为“无需再做内置人声分离”的音频，返回原 buffer 方便链式调用。 */
export function markSkipSeparation(buffer: AudioBuffer): AudioBuffer {
  syntheticAudio.add(buffer);
  return buffer;
}

export function markSyntheticAudio(buffer: AudioBuffer): AudioBuffer {
  return markSkipSeparation(buffer);
}

export function isSyntheticAudio(buffer: AudioBuffer): boolean {
  return syntheticAudio.has(buffer);
}
