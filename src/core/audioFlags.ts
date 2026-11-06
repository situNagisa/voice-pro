/**
 * 合成示例歌的标记。
 * 示例歌的人声固定居中、伴奏刻意避开中置，现有中置提取已经是最优输入；
 * MDX 人声分离模型对合成音色反而会削掉一部分旋律，所以这类音频跳过分离。
 * 只对内存中的同一个 AudioBuffer 生效，用户导入的歌曲永远不会命中。
 */
const syntheticAudio = new WeakSet<AudioBuffer>();

export function markSyntheticAudio(buffer: AudioBuffer): AudioBuffer {
  syntheticAudio.add(buffer);
  return buffer;
}

export function isSyntheticAudio(buffer: AudioBuffer): boolean {
  return syntheticAudio.has(buffer);
}
