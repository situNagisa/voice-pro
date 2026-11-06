import type { QuickRequest, SeparateResponse } from './protocol'
import { CHUNK_SAMPLES, MODEL_RATE } from './stft'

/** 快速模式的分段重叠。比标准模式少一半，拼接处的交叉淡化更短。 */
export const QUICK_OVERLAP_SECONDS = 0.5

export interface QuickOptions {
  /** 已下载好的模型字节；每个 Worker 会拿一份副本。 */
  model: ArrayBuffer
  preferWebGPU: boolean
  workerCount: number
  onProgress?: (stage: string, ratio: number) => void
  signal?: AbortSignal
}

interface ChunkResult {
  id: number
  vocalsL: Float32Array
  vocalsR: Float32Array
}

class QuickWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, { resolve: (value: ChunkResult) => void; reject: (error: Error) => void }>()
  private ready: { resolve: () => void; reject: (error: Error) => void } | null = null
  private disposed = false
  private readonly preferWebGPU: boolean

  constructor(preferWebGPU: boolean) {
    this.preferWebGPU = preferWebGPU
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<SeparateResponse>) => {
      const message = event.data
      if (!message) return
      if (message.type === 'ready') {
        const ready = this.ready
        this.ready = null
        ready?.resolve()
        return
      }
      if (message.type === 'chunk') {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        entry?.resolve(message)
        return
      }
      if (message.type === 'error') {
        this.fail(new Error(message.message || '快速分离失败'))
      }
    }
    this.worker.onerror = (event: ErrorEvent) => {
      this.fail(new Error(event.message || '快速分离 Worker 出错'))
    }
    this.worker.onmessageerror = () => {
      this.fail(new Error('快速分离结果无法反序列化'))
    }
  }

  init(model: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('快速分离已取消'))
        return
      }
      this.ready = { resolve, reject }
      const copy = model.slice(0)
      const request: QuickRequest = {
        type: 'init',
        model: copy,
        preferWebGPU: this.preferWebGPU,
      }
      this.worker.postMessage(request, [copy])
    })
  }

  process(id: number, left: Float32Array, right: Float32Array): Promise<ChunkResult> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('快速分离已取消'))
        return
      }
      this.pending.set(id, { resolve, reject })
      const request: QuickRequest = { type: 'chunk', id, left, right }
      this.worker.postMessage(request, [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer])
    })
  }

  dispose(reason = '快速分离已取消'): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.terminate()
    this.ready?.reject(new Error(reason))
    this.ready = null
    for (const entry of this.pending.values()) entry.reject(new Error(reason))
    this.pending.clear()
  }

  private fail(error: Error): void {
    this.ready?.reject(error)
    this.ready = null
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}

/**
 * 快速模式：把整首歌切成 11.87 s 的段，N 个 Worker 各跑自己的 ORT 会话，
 * 主线程只做分发与交叉淡入淡出。没有 SharedArrayBuffer 时每个 WASM 仍是单线程，
 * 但多核手机可以同时跑 2 段。与标准模式相比只有 0.5 s/1 s 重叠的差别。
 */
export async function separateQuick(
  channels: Float32Array[],
  options: QuickOptions,
): Promise<{ vocals: Float32Array[]; accompaniment: Float32Array[] }> {
  const left = channels[0]
  const right = channels[1] ?? channels[0]
  const total = Math.min(left.length, right.length)
  if (total === 0) throw new Error('音频为空，无法分离')

  const sampleRate = MODEL_RATE
  const overlap = Math.round(QUICK_OVERLAP_SECONDS * sampleRate)
  const step = CHUNK_SAMPLES - overlap
  const chunkCount = Math.max(1, Math.ceil((total - overlap) / step))
  const workerCount = Math.max(1, Math.min(options.workerCount, chunkCount))
  const vocalsL = new Float32Array(total)
  const vocalsR = new Float32Array(total)
  const weights = new Float32Array(total)
  const clients = Array.from({ length: workerCount }, () => new QuickWorkerClient(options.preferWebGPU))

  const onAbort = (): void => {
    for (const client of clients) client.dispose('快速分离已取消')
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  try {
    options.onProgress?.('初始化分离模型', 0.02)
    await Promise.all(clients.map((client) => client.init(options.model)))
    if (options.signal?.aborted) throw abortError()

    let next = 0
    let completed = 0
    const drain = async (client: QuickWorkerClient): Promise<void> => {
      for (;;) {
        if (options.signal?.aborted) throw abortError()
        const index = next++
        if (index >= chunkCount) return
        const start = index * step
        const valid = Math.min(CHUNK_SAMPLES, total - start)
        if (valid <= 0) return

        const chunkL = new Float32Array(CHUNK_SAMPLES)
        const chunkR = new Float32Array(CHUNK_SAMPLES)
        chunkL.set(left.subarray(start, start + valid))
        chunkR.set(right.subarray(start, start + valid))
        const result = await client.process(index, chunkL, chunkR)
        mixChunk(
          start,
          valid,
          total,
          overlap,
          result.vocalsL,
          result.vocalsR,
          vocalsL,
          vocalsR,
          weights,
        )
        completed++
        options.onProgress?.(
          `分离人声（快速 ${workerCount} 路） ${completed}/${chunkCount}`,
          completed / chunkCount,
        )
      }
    }

    await Promise.all(clients.map((client) => drain(client)))
    if (options.signal?.aborted) throw abortError()

    for (let i = 0; i < total; i++) {
      const weight = weights[i]
      if (weight > 1e-6) {
        vocalsL[i] /= weight
        vocalsR[i] /= weight
      }
    }

    const accompanimentL = new Float32Array(total)
    const accompanimentR = new Float32Array(total)
    for (let i = 0; i < total; i++) {
      accompanimentL[i] = left[i] - vocalsL[i]
      accompanimentR[i] = right[i] - vocalsR[i]
    }
    return {
      vocals: [vocalsL, vocalsR],
      accompaniment: [accompanimentL, accompanimentR],
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    for (const client of clients) client.dispose()
  }
}

function mixChunk(
  start: number,
  valid: number,
  total: number,
  overlap: number,
  sourceL: Float32Array,
  sourceR: Float32Array,
  targetL: Float32Array,
  targetR: Float32Array,
  weights: Float32Array,
): void {
  const fadeInChunk = start > 0
  const fadeOutChunk = start + CHUNK_SAMPLES < total
  const fadeOutStart = CHUNK_SAMPLES - overlap
  for (let i = 0; i < valid; i++) {
    let weight = 1
    if (fadeInChunk && i < overlap) weight *= 0.5 - 0.5 * Math.cos((Math.PI * i) / overlap)
    if (fadeOutChunk && i >= fadeOutStart) {
      weight *= 1 - (0.5 - 0.5 * Math.cos((Math.PI * (i - fadeOutStart)) / overlap))
    }
    targetL[start + i] += sourceL[i] * weight
    targetR[start + i] += sourceR[i] * weight
    weights[start + i] += weight
  }
}

function abortError(): DOMException {
  return new DOMException('人声分离已取消', 'AbortError')
}
