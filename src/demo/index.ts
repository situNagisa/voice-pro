/** 内置示例歌曲：本地合成（"人声"旋律 + 伴奏），让没有音频文件的用户也能马上体验。 */
export interface DemoSong {
  id: string;
  title: string;
  /** 一句话说明，例如"慢速 · C 大调 · 适合入门" */
  desc: string;
  durationSec: number;
}

export function listDemoSongs(): DemoSong[] {
  return [];
}

/** 合成指定示例歌曲的完整音频（原唱 + 伴奏混合），返回可直接播放和提取旋律的 AudioBuffer。 */
export async function renderDemoSong(_id: string): Promise<AudioBuffer> {
  throw new Error('未实现');
}
