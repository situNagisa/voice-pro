import { markSyntheticAudio } from '../core/audioFlags'
import { DEMO_SONG_SPECS, songDurationSec } from './songs'
import { renderSong, renderSongStems } from './synth'

export { demoLyricSong } from './lyrics'

/** 内置示例歌曲：本地合成（"人声"旋律 + 伴奏），让没有音频文件的用户也能马上体验。 */
export interface DemoSong {
  id: string
  title: string
  /** 一句话说明，例如"慢速 · C 大调 · 适合入门" */
  desc: string
  durationSec: number
}

const CATALOG: readonly DemoSong[] = DEMO_SONG_SPECS.map((spec) => ({
  id: spec.id,
  title: spec.title,
  desc: spec.desc,
  durationSec: Math.round(songDurationSec(spec) * 10) / 10,
}))

/** 同一首歌只合成一次，之后的调用直接复用内存里的 AudioBuffer */
const cache = new Map<string, Promise<AudioBuffer>>()

/** 分轨单独缓存，供伴奏/原唱人声播放模式使用。 */
const stemCache = new Map<
  string,
  Promise<{ vocals: AudioBuffer; accompaniment: AudioBuffer }>
>()

export function listDemoSongs(): DemoSong[] {
  return CATALOG.map((song) => ({ ...song }))
}

/** 合成指定示例歌曲的完整音频（原唱 + 伴奏混合），返回可直接播放和提取旋律的 AudioBuffer。 */
export async function renderDemoSong(id: string): Promise<AudioBuffer> {
  const spec = DEMO_SONG_SPECS.find((song) => song.id === id)
  if (!spec) {
    throw new Error(`未找到示例歌曲：${id}`)
  }

  const cached = cache.get(id)
  if (cached) return cached

  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('当前环境不支持离线音频合成')
  }

  // 先占位再合成，避免同时点两次触发两遍渲染；失败时清掉缓存以便重试。
  const task = renderSong(spec)
    .then((buffer) => markSyntheticAudio(buffer))
    .catch((error: unknown) => {
      cache.delete(id)
      throw error
    })
  cache.set(id, task)
  return task
}

/** 合成示例歌的人声/伴奏分轨；与 renderDemoSong 共用同一份乐谱。 */
export async function renderDemoStems(
  id: string,
): Promise<{ vocals: AudioBuffer; accompaniment: AudioBuffer }> {
  const spec = DEMO_SONG_SPECS.find((song) => song.id === id)
  if (!spec) {
    throw new Error(`未找到示例歌曲：${id}`)
  }

  const cached = stemCache.get(id)
  if (cached) return cached

  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('当前环境不支持离线音频合成')
  }

  // 分轨体积约为原曲的两倍，只保留最近一首，避免手机内存被示例歌占满。
  for (const key of stemCache.keys()) {
    if (key !== id) stemCache.delete(key)
  }
  const task = renderSongStems(spec).catch((error: unknown) => {
    stemCache.delete(id)
    throw error
  })
  stemCache.set(id, task)
  return task
}
