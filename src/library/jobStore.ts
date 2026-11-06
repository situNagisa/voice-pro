import {
  ANALYSIS_JOB_STORE,
  openAppDb,
  requestToPromise,
  transactionDone,
} from '../state/db'

/**
 * 未完成的分析任务。文件本体也存进来，刷新/重开 App 后可以继续分析；
 * 完成、取消或用户放弃后删除，不长期占用空间。
 */
export interface StoredAnalysisJob {
  id: string
  fileName: string
  fileType: string
  songName: string
  file: Blob
  stage: string
  ratio: number
  startedAt: number
  updatedAt: number
  status: 'running' | 'error'
}

export async function saveAnalysisJob(job: StoredAnalysisJob): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(ANALYSIS_JOB_STORE, 'readwrite')
  tx.objectStore(ANALYSIS_JOB_STORE).put(job)
  await transactionDone(tx)
}

export async function loadLatestAnalysisJob(): Promise<StoredAnalysisJob | null> {
  try {
    const db = await openAppDb()
    const tx = db.transaction(ANALYSIS_JOB_STORE, 'readonly')
    const items = await requestToPromise(tx.objectStore(ANALYSIS_JOB_STORE).getAll())
    const jobs = (items as StoredAnalysisJob[]).sort((a, b) => b.updatedAt - a.updatedAt)
    return jobs[0] ?? null
  } catch (error) {
    console.warn('[voice-pro] 读取未完成的分析任务失败', error)
    return null
  }
}

export async function deleteAnalysisJob(id: string): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(ANALYSIS_JOB_STORE, 'readwrite')
  tx.objectStore(ANALYSIS_JOB_STORE).delete(id)
  await transactionDone(tx)
}

export async function clearAnalysisJobs(): Promise<void> {
  const db = await openAppDb()
  const tx = db.transaction(ANALYSIS_JOB_STORE, 'readwrite')
  tx.objectStore(ANALYSIS_JOB_STORE).clear()
  await transactionDone(tx)
}
