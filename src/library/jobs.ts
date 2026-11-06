import { analyzeSongAudio } from './analyze'
import { encodeAccompaniment, encodeVocals } from './audioStore'
import {
  estimateMelodyBytes,
  findLibrarySong,
  saveLibrarySong,
} from './db'
import { hashFile } from './hash'
import {
  deleteAnalysisJob,
  loadLatestAnalysisJob,
  saveAnalysisJob,
} from './jobStore'

export type LibraryJobStatus =
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'pending'

/** 后台导入任务快照。组件卸载、切到音准仪都不会中止任务。 */
export interface LibraryJobSnapshot {
  status: LibraryJobStatus
  fileName: string
  songName: string
  stage: string
  /** 0..1 总进度 */
  ratio: number
  /** 分离阶段估算的剩余秒数，其他阶段为 null */
  etaSec: number | null
  startedAt: number
  finishedAt: number | null
  songId: string | null
  error: string | null
  /** 首页提示是否已被用户确认；确认后再次回到首页不再弹出 */
  acknowledged: boolean
  /** 原文件在本机，可以继续/重试分析 */
  resumable: boolean
}

type Listener = () => void

const listeners = new Set<Listener>()
let currentJob: LibraryJobSnapshot | null = null
let activeController: AbortController | null = null
let activeFile: File | null = null
let activeSongId: string | null = null
let staleJobId: string | null = null

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // 单个订阅者出错不影响任务。
    }
  }
}

export function subscribeLibraryJob(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLibraryJobSnapshot(): LibraryJobSnapshot | null {
  return currentJob
}

/** 用户已经看到完成/失败提示，之后回到首页不再重复弹出。 */
export function acknowledgeLibraryJob(): void {
  if (
    !currentJob ||
    currentJob.status === 'running' ||
    currentJob.status === 'pending' ||
    currentJob.acknowledged
  ) {
    return
  }
  currentJob = { ...currentJob, acknowledged: true }
  emit()
}

function update(patch: Partial<LibraryJobSnapshot>): void {
  if (!currentJob) return
  currentJob = { ...currentJob, ...patch }
  emit()
}

export function cancelLibraryImport(): void {
  if (!activeController || currentJob?.status !== 'running') return
  update({ stage: '正在取消…' })
  activeController.abort()
}

/**
 * 启动一次新的导入。已有任务在跑，或还有一个“上次未完成”等着用户决定时，
 * 不允许覆盖，避免把原文件从 IndexedDB 里挤掉。
 */
export function startLibraryImport(
  file: File,
  precomputedHash?: string,
): boolean {
  if (currentJob?.status === 'running' || currentJob?.status === 'pending') {
    return false
  }
  staleJobId = currentJob?.status === 'error' ? activeSongId : null
  const songName =
    (file.name.replace(/\.[^.]+$/, '').trim() || '未命名歌曲').slice(0, 60)
  currentJob = {
    status: 'running',
    fileName: file.name,
    songName,
    stage: '正在读取文件…',
    ratio: 0.01,
    etaSec: null,
    startedAt: Date.now(),
    finishedAt: null,
    songId: null,
    error: null,
    acknowledged: false,
    resumable: true,
  }
  activeFile = file
  activeSongId = precomputedHash ?? null
  emit()
  const controller = new AbortController()
  activeController = controller
  void runImport(file, songName, controller, precomputedHash)
  return true
}

/** 重新打开 App 后，把 IndexedDB 里未完成的任务恢复成“待继续”。 */
export async function restoreLibraryJob(): Promise<void> {
  if (currentJob) return
  const stored = await loadLatestAnalysisJob()
  if (!stored || currentJob) return
  try {
    const existing = await findLibrarySong(stored.id)
    if (currentJob) return
    if (existing) {
      await deleteAnalysisJob(stored.id).catch(() => undefined)
      return
    }
  } catch {
    // 读取歌曲库失败时仍然允许继续分析
  }
  if (currentJob) return
  let file: File
  try {
    file = new File([stored.file], stored.fileName, { type: stored.fileType })
  } catch (error) {
    console.warn('[voice-pro] 无法还原上次的音频文件', error)
    await deleteAnalysisJob(stored.id).catch(() => undefined)
    return
  }
  activeFile = file
  activeSongId = stored.id
  currentJob = {
    status: 'pending',
    fileName: stored.fileName,
    songName: stored.songName,
    stage: '上次分析未完成',
    ratio: stored.ratio ?? 0,
    etaSec: null,
    startedAt: stored.startedAt,
    finishedAt: null,
    songId: null,
    error: null,
    acknowledged: false,
    resumable: true,
  }
  emit()
}

/** 继续（或重试）上次没做完的分析。 */
export function resumeLibraryImport(): boolean {
  if (!activeFile || !currentJob) return false
  if (currentJob.status !== 'pending' && currentJob.status !== 'error') return false
  const file = activeFile
  const songName = currentJob.songName
  const id = activeSongId ?? undefined
  currentJob = {
    ...currentJob,
    status: 'running',
    stage: '正在继续上次的分析…',
    ratio: 0.02,
    etaSec: null,
    finishedAt: null,
    error: null,
    acknowledged: false,
    resumable: true,
  }
  emit()
  const controller = new AbortController()
  activeController = controller
  void runImport(file, songName, controller, id)
  return true
}

/** 用户放弃未完成的分析：删除原文件，不再提示。 */
export function discardLibraryJob(): boolean {
  if (currentJob?.status === 'running') return false
  const id = activeSongId
  currentJob = null
  activeFile = null
  activeSongId = null
  if (id) void deleteAnalysisJob(id).catch(() => undefined)
  emit()
  return true
}

async function persistCurrentFile(id: string, file: File, songName: string): Promise<void> {
  if (!currentJob) return
  try {
    await saveAnalysisJob({
      id,
      fileName: file.name,
      fileType: file.type,
      songName,
      file,
      stage: currentJob.stage,
      ratio: currentJob.ratio,
      startedAt: currentJob.startedAt,
      updatedAt: Date.now(),
      status: 'running',
    })
  } catch (error) {
    // 存储配额不足时不阻断本次分析，只是刷新后无法续跑
    console.warn('[voice-pro] 保存未完成分析任务失败，刷新后无法继续', error)
  }
}

async function finishWithSavedSong(id: string, songName: string): Promise<void> {
  await deleteAnalysisJob(id).catch(() => undefined)
  activeFile = null
  activeSongId = null
  finishDone(id, songName)
}

async function runImport(
  file: File,
  songName: string,
  controller: AbortController,
  precomputedHash?: string,
): Promise<void> {
  let separationStartedAt = 0
  let id: string | null = precomputedHash ?? activeSongId
  try {
    if (!id) {
      id = await hashFile(file)
    }
    activeSongId = id
    if (staleJobId && staleJobId !== id) {
      await deleteAnalysisJob(staleJobId).catch(() => undefined)
    }
    staleJobId = null
    throwIfAborted(controller.signal)

    // 先把原文件和“未完成”状态落盘，刷新/重开 App 后可以继续。
    await persistCurrentFile(id, file, songName)

    // 另一个入口可能刚好先把同一首歌写进了库。
    const existing = await findLibrarySong(id)
    if (existing) {
      await finishWithSavedSong(existing.id, existing.name)
      return
    }

    update({ stage: '正在解码音频…', ratio: 0.05 })
    const data = await file.arrayBuffer()
    throwIfAborted(controller.signal)
    const ctx = new AudioContext({ latencyHint: 'playback' })
    let buffer: AudioBuffer | null = null
    try {
      buffer = await ctx.decodeAudioData(data)
    } catch {
      throw new Error(
        '无法解码这个音频文件。请确认它是 mp3 / m4a / wav / flac / ogg，且文件没有损坏。',
      )
    } finally {
      void ctx.close().catch(() => undefined)
    }
    throwIfAborted(controller.signal)
    if (!buffer) throw new Error('无法解码这个音频文件。')
    const decoded = buffer
    if (decoded.duration < 1) {
      throw new Error('这首歌太短了，请选择至少 1 秒的音频。')
    }

    const analysis = await analyzeSongAudio(
      buffer,
      (stage, ratio, phase) => {
        let overall: number
        let etaSec: number | null = null
        if (phase === 'separate') {
          overall = 0.08 + clamp(ratio, 0, 1) * 0.64
          if (stage.startsWith('分离人声')) {
            if (!separationStartedAt) separationStartedAt = performance.now()
            const elapsed = (performance.now() - separationStartedAt) / 1000
            // 分离进度从 0.1 开始（0~0.1 是模型加载），按已处理的部分外推剩余时间。
            const processed = Math.max(0.01, ratio - 0.1)
            if (ratio > 0.02 && elapsed > 1) {
              etaSec = Math.max(1, (elapsed * (1 - ratio)) / processed)
            }
          }
        } else {
          overall = 0.72 + clamp(ratio, 0, 1) * 0.2
        }
        update({
          stage: describeStage(stage, etaSec),
          ratio: clamp(overall, 0, 0.95),
          etaSec,
        })
      },
      controller.signal,
    )
    throwIfAborted(controller.signal)

    let accompaniment: Blob | null = null
    let vocals: Blob | null = null
    let encodeWarning: string | undefined
    if (analysis.accompaniment && analysis.vocals) {
      update({ stage: '正在压缩伴奏（立体声）…', ratio: 0.94, etaSec: null })
      try {
        const accompanimentTrack = await encodeAccompaniment(analysis.accompaniment)
        throwIfAborted(controller.signal)
        update({ stage: '正在压缩人声…', ratio: 0.96, etaSec: null })
        const vocalsTrack = await encodeVocals(analysis.vocals)
        accompaniment = accompanimentTrack.blob
        vocals = vocalsTrack.blob
        if (accompanimentTrack.codec === 'wav' || vocalsTrack.codec === 'wav') {
          encodeWarning =
            '当前设备不支持 Opus 压缩，分轨按 16-bit WAV 保存，占用空间会大一些。'
        }
      } catch (error) {
        console.warn('[voice-pro] 分轨压缩失败，只保存原曲与旋律', error)
        accompaniment = null
        vocals = null
        encodeWarning = '伴奏压缩失败，这首歌暂时只能用原曲跟唱。'
      }
    }
    throwIfAborted(controller.signal)

    const now = Date.now()
    const audioBytes = (accompaniment?.size ?? 0) + (vocals?.size ?? 0)
    const meta = {
      id,
      name: songName,
      duration: decoded.duration,
      noteCount: analysis.melody.notes.length,
      temporary: analysis.temporary,
      warning: [analysis.warning, encodeWarning].filter(Boolean).join(' ') || undefined,
      createdAt: now,
      updatedAt: now,
      sourceName: file.name,
      sourceType: file.type || '',
      sourceSize: file.size,
      hasStems: Boolean(accompaniment && vocals),
      sampleRate: decoded.sampleRate,
      channels: decoded.numberOfChannels,
      sourceBytes: file.size,
      audioBytes,
      melodyBytes: estimateMelodyBytes(analysis.melody),
    }

    update({ stage: '正在写入歌曲库…', ratio: 0.98, etaSec: null })
    await saveLibrarySong(
      meta,
      analysis.melody,
      { id, source: file, accompaniment, vocals },
    )
    await finishWithSavedSong(id, meta.name)
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      if (id) await deleteAnalysisJob(id).catch(() => undefined)
      activeFile = null
      activeSongId = null
      currentJob = {
        ...(currentJob as LibraryJobSnapshot),
        status: 'cancelled',
        stage: '已取消',
        finishedAt: Date.now(),
        ratio: 0,
        etaSec: null,
        resumable: false,
      }
      emit()
      return
    }
    console.warn('[voice-pro] 导入歌曲失败', error)
    currentJob = {
      ...(currentJob as LibraryJobSnapshot),
      status: 'error',
      stage: '分析失败',
      error: importErrorMessage(error),
      finishedAt: Date.now(),
      etaSec: null,
      resumable: activeFile != null,
    }
    emit()
  } finally {
    activeController = null
  }
}

function finishDone(songId: string, songName: string): void {
  if (!currentJob) return
  currentJob = {
    ...currentJob,
    status: 'done',
    stage: '分析完成',
    ratio: 1,
    etaSec: null,
    songId,
    songName,
    finishedAt: Date.now(),
    error: null,
    acknowledged: false,
    resumable: false,
  }
  emit()
}

function describeStage(stage: string, etaSec: number | null): string {
  if (stage.startsWith('分离人声')) {
    return etaSec == null
      ? '正在分离人声…'
      : `正在分离人声（约 ${formatEta(etaSec)}）`
  }
  if (stage.startsWith('加载分离模型')) return '正在加载人声分离模型…'
  if (stage.startsWith('初始化分离模型')) return '正在初始化人声分离模型…'
  if (stage.startsWith('准备人声分离')) return '正在准备人声分离…'
  if (stage.startsWith('整理分离结果')) return '正在整理分离结果…'
  if (stage.startsWith('人声分离完成')) return '正在整理人声分轨…'
  if (stage.includes('简易检测')) return '正在用备用算法提取旋律…'
  if (stage === '准备提取人声旋律' || stage === '准备音频') return '正在提取参考旋律…'
  if (stage === '完成') return '正在整理参考旋律…'
  return `正在提取参考旋律 · ${stage}`
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '不到 1 秒'
  if (seconds < 10) return '不到 10 秒'
  if (seconds < 55) return `${Math.ceil(seconds / 5) * 5} 秒`
  if (seconds < 60) return '约 1 分钟'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round((seconds - minutes * 60) / 10) * 10
  return rest >= 60
    ? `${minutes + 1} 分钟`
    : `${minutes} 分 ${rest > 0 ? `${rest} 秒` : ''}`.trim()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('分析已取消', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function importErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '本机存储空间不足，这首歌没能保存。可以在设置里清空不需要的歌曲缓存后重试。'
  }
  if (error instanceof Error) {
    if (error.name === 'QuotaExceededError') {
      return '本机存储空间不足，这首歌没能保存。可以在设置里清空不需要的歌曲缓存后重试。'
    }
    return error.message || '导入失败，请重试。'
  }
  return '导入失败，请重试。'
}
