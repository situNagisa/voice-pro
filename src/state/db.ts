/** 应用共享的 IndexedDB：练习记录 + 歌曲库。版本升级时统一创建所有 store。 */

export const DB_NAME = 'voicepro'
export const DB_VERSION = 4

export const RECORD_STORE = 'records'
export const RECORD_DETAIL_STORE = 'details'
export const SONG_STORE = 'songs'
export const SONG_MELODY_STORE = 'songMelodies'
export const SONG_AUDIO_STORE = 'songAudio'
export const ANALYSIS_JOB_STORE = 'analysisJobs'

let dbPromise: Promise<IDBDatabase> | null = null

export function openAppDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const store = db.createObjectStore(RECORD_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      if (!db.objectStoreNames.contains(RECORD_DETAIL_STORE)) {
        db.createObjectStore(RECORD_DETAIL_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SONG_STORE)) {
        db.createObjectStore(SONG_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SONG_MELODY_STORE)) {
        db.createObjectStore(SONG_MELODY_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SONG_AUDIO_STORE)) {
        db.createObjectStore(SONG_AUDIO_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(ANALYSIS_JOB_STORE)) {
        const store = db.createObjectStore(ANALYSIS_JOB_STORE, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
  })
  return dbPromise
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败'))
  })
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('本地数据库写入失败'))
    tx.onabort = () => reject(tx.error ?? new Error('本地数据库写入被中止'))
  })
}
