import processorSource from './stretchProcessor.js?raw'

/**
 * 实时变调节点。所有 AudioContext 共用同一次模块加载失败结果，
 * 不支持 AudioWorklet 的 WebView 会返回 null，由调用方回退离线处理。
 */

const FRAME = 2048
const SEARCH = 512
const RENDER_QUANTUM = 128

interface ModuleState {
  promise: Promise<boolean>
}

const modules = new WeakMap<BaseAudioContext, ModuleState>()

function loadProcessor(ctx: BaseAudioContext): Promise<boolean> {
  const cached = modules.get(ctx)
  if (cached) return cached.promise
  const state: ModuleState = {
    promise: (async () => {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false
      const blob = new Blob([processorSource], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        await ctx.audioWorklet.addModule(url)
        return true
      } catch (error) {
        console.warn('[voice-pro] 实时变调 Worklet 加载失败，回退离线处理', error)
        return false
      } finally {
        URL.revokeObjectURL(url)
      }
    })(),
  }
  modules.set(ctx, state)
  return state.promise
}

export class RealtimeStretcher {
  readonly node: AudioWorkletNode
  /** 算法本身引入的延迟（秒）；播放位置需要减掉它才能和听感同步。 */
  readonly latency: number
  private disposed = false

  constructor(ctx: BaseAudioContext) {
    this.node = new AudioWorkletNode(ctx, 'voice-stretch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })
    this.latency = (FRAME + SEARCH + RENDER_QUANTUM) / ctx.sampleRate
  }

  setParams(semitones: number, speed: number): void {
    if (this.disposed) return
    this.node.port.postMessage({ type: 'params', semitones, speed })
  }

  reset(): void {
    if (this.disposed) return
    this.node.port.postMessage({ type: 'reset' })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.node.port.close()
    } catch {
      // 已经关闭
    }
    this.node.disconnect()
  }
}

export async function createRealtimeStretcher(
  ctx: BaseAudioContext,
): Promise<RealtimeStretcher | null> {
  const ready = await loadProcessor(ctx)
  if (!ready) return null
  try {
    return new RealtimeStretcher(ctx)
  } catch (error) {
    console.warn('[voice-pro] 实时变调节点创建失败，回退离线处理', error)
    return null
  }
}
