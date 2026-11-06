import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent } from 'react'
import { formatDuration, formatTime, isSecureAudioContext } from '../audio/pitch'
import { listDemoSongs } from '../demo'
import {
  acknowledgeLibraryJob,
  cancelLibraryImport,
  deleteLibrarySong,
  findLibrarySong,
  formatBytes,
  getLibraryJobSnapshot,
  hashFile,
  listLibrarySongs,
  loadLibrarySong,
  renameLibrarySong,
  startLibraryImport,
  subscribeLibraryJob,
} from '../library'
import type { LibrarySongMeta } from '../library'
import { loadDemoSong } from '../state/demo'
import type { PracticeRecordMeta } from '../state/records'
import type { LoadedSong } from '../state/session'
import type { Settings } from '../state/settings'
import { Notice, ProgressBar } from '../ui/controls'
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  HeadphonesIcon,
  MusicIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
  UploadIcon,
} from '../ui/icons'

interface SongsHomeProps {
  settings: Settings
  records: PracticeRecordMeta[]
  /** 设置里清空歌曲库后递增，用来让首页重新读取列表 */
  libraryRevision: number
  onSong: (song: LoadedSong) => void
  onOpenSettings: () => void
}

const ACCEPTED_EXTENSIONS = ['mp3', 'm4a', 'wav', 'flac', 'ogg']

function looksLikeAudio(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return file.type.startsWith('audio/') || ACCEPTED_EXTENSIONS.includes(extension)
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function SongsHome({
  settings,
  records,
  libraryRevision,
  onSong,
  onOpenSettings,
}: SongsHomeProps) {
  const demos = listDemoSongs()
  const [demoBusy, setDemoBusy] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [windowDragging, setWindowDragging] = useState(false)
  const [librarySongs, setLibrarySongs] = useState<LibrarySongMeta[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const mountedRef = useRef(true)
  const secure = isSecureAudioContext()

  const job = useSyncExternalStore(
    subscribeLibraryJob,
    getLibraryJobSnapshot,
    getLibraryJobSnapshot,
  )
  const jobRunning = job?.status === 'running'

  const refreshLibrary = useCallback(async (): Promise<void> => {
    const songs = await listLibrarySongs()
    if (!mountedRef.current) return
    setLibrarySongs(songs)
    setLibraryLoading(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    setLibraryLoading(true)
    void refreshLibrary()
  }, [refreshLibrary, libraryRevision])

  useEffect(() => {
    if (job?.status !== 'done') return
    void refreshLibrary()
  }, [job?.status, job?.finishedAt, job?.songId, refreshLibrary])

  const lastRecordBySong = useMemo(() => {
    const map = new Map<string, PracticeRecordMeta>()
    // App 里的记录已按时间倒序，第一条就是最近一次练习。
    for (const record of records) {
      if (!map.has(record.songId)) map.set(record.songId, record)
    }
    return map
  }, [records])

  async function chooseDemo(id: string): Promise<void> {
    if (demoBusy || checking || jobRunning) return
    setError(null)
    setDemoBusy(id)
    try {
      const song = await loadDemoSong(id)
      if (mountedRef.current) onSong(song)
    } catch (err) {
      setError(errorMessage(err, '示例歌加载失败，请重试。'))
    } finally {
      setDemoBusy(null)
    }
  }

  async function openLibrary(id: string): Promise<void> {
    if (openingId) return
    if (jobRunning) {
      setError('正在后台分析另一首歌，完成后再打开。')
      return
    }
    if (job != null && job.status === 'done' && job.songId === id) {
      acknowledgeLibraryJob()
    }
    setError(null)
    setOpeningId(id)
    try {
      const song = await loadLibrarySong(id)
      if (!song) {
        setError('这首歌的缓存已经不存在了，请重新导入。')
        await refreshLibrary()
        return
      }
      if (mountedRef.current) onSong(song)
    } catch (err) {
      setError(errorMessage(err, '打开歌曲失败，缓存可能已损坏。'))
      await refreshLibrary()
    } finally {
      setOpeningId(null)
    }
  }

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file) return
    if (jobRunning) {
      setError('已有歌曲正在分析，请等它完成后再导入。')
      return
    }
    if (checking || openingId || demoBusy) return
    if (!looksLikeAudio(file)) {
      setError('请选择 mp3、m4a、wav、flac 或 ogg 音频文件。')
      return
    }
    if (file.size === 0) {
      setError('这个文件是空的，请换一个音频文件。')
      return
    }

    setError(null)
    setChecking(true)
    try {
      // 先算内容哈希，命中缓存就只解码、不重新分离，秒开。
      const hash = await hashFile(file)
      const existing = await findLibrarySong(hash)
      if (existing) {
        if (job != null && job.status === 'done' && job.songId === existing.id) {
          acknowledgeLibraryJob()
        }
        setChecking(false)
        setOpeningId(existing.id)
        const song = await loadLibrarySong(existing.id)
        if (!song) {
          setError('歌曲缓存不完整，请删除后重新导入。')
          await refreshLibrary()
          return
        }
        if (mountedRef.current) onSong(song)
        return
      }
      const started = startLibraryImport(file, hash)
      if (!started) setError('已有歌曲正在分析，请等它完成。')
    } catch (err) {
      setError(errorMessage(err, '导入失败，请重试。'))
    } finally {
      setChecking(false)
      setOpeningId(null)
    }
  }

  async function removeSong(song: LibrarySongMeta): Promise<void> {
    if (
      !window.confirm(
        `从歌曲库删除「${song.name}」？\n原曲、伴奏和分析结果都会删除；练习记录会保留，但回看时只能听录音。`,
      )
    ) {
      return
    }
    try {
      await deleteLibrarySong(song.id)
      setError(null)
      await refreshLibrary()
    } catch (err) {
      setError(errorMessage(err, '删除歌曲失败，请重试。'))
    }
  }

  function startRename(song: LibrarySongMeta): void {
    setRenameId(song.id)
    setRenameValue(song.name)
  }

  async function commitRename(song: LibrarySongMeta): Promise<void> {
    if (renameId !== song.id) return
    const name = renameValue.trim().slice(0, 60)
    setRenameId(null)
    if (!name || name === song.name) return
    try {
      await renameLibrarySong(song.id, name)
      await refreshLibrary()
    } catch (err) {
      setError(errorMessage(err, '重命名失败，请重试。'))
    }
  }

  function cancelRename(): void {
    setRenameId(null)
    setRenameValue('')
  }

  function cancelImport(): void {
    if (!window.confirm('取消这次分析？未完成的部分不会保存。')) return
    cancelLibraryImport()
  }

  function onDrop(event: ReactDragEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setWindowDragging(false)
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }

  function onDropKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!jobRunning && !checking && !openingId && !demoBusy) fileRef.current?.click()
    }
  }

  useEffect(() => {
    // 桌面端：把音频拖到窗口任意位置都能导入
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepthRef.current += 1
      setWindowDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setWindowDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepthRef.current = 0
      setWindowDragging(false)
      setDragging(false)
      const file = event.dataTransfer?.files?.[0]
      if (file) void handleFile(file)
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  })

  const showJobDone = job != null && job.status === 'done' && !job.acknowledged
  const showJobError = job != null && job.status === 'error' && !job.acknowledged
  const importBusy = checking || jobRunning || openingId != null || demoBusy != null

  return (
    <div className="screen home-screen">
      <header className="tab-header">
        <div className="brand">
          <img src="/icon.svg" alt="" width={38} height={38} />
          <div>
            <span className="brand-name">音准镜</span>
            <span className="brand-sub">看见每一个音</span>
          </div>
        </div>
        <button type="button" className="icon-btn" aria-label="打开设置" onClick={onOpenSettings}>
          <SettingsIcon />
        </button>
      </header>

      <header className="home-desktop-head">
        <div>
          <p className="eyebrow">桌面工作区</p>
          <h1>练歌</h1>
          <p>选一首歌开始跟唱，或者把音频文件直接拖进窗口。</p>
        </div>
        <button
          type="button"
          className="btn secondary"
          disabled={importBusy || demoBusy != null}
          onClick={() => fileRef.current?.click()}
        >
          <UploadIcon />
          导入音频
        </button>
      </header>

      <main className="page">
        <section className="hero-guide">
          <p className="eyebrow">开始练习</p>
          <h1>选一首歌，<br />戴上耳机跟唱</h1>
          <p className="hero-sub">实时看见每个音偏高还是偏低；唱完可以停下来，逐句回看。</p>
          <div className="hero-tags">
            <span className="tag">±{settings.tolerance} 音分判定</span>
            <span className="tag">伴奏跟唱</span>
            <span className="tag">离线可用</span>
          </div>
        </section>

        {!secure && (
          <Notice tone="warn">
            当前页面不是 HTTPS，手机浏览器会拒绝麦克风。请用 https 或 localhost 打开。
          </Notice>
        )}

        <section className="section-block library-section">
          <div className="section-head">
            <div>
              <h2>我的歌</h2>
              <p>导入并分析过的歌保存在本机，再次打开不用重新分离</p>
            </div>
            <div className="section-head-side">
              <span className="count-badge">{librarySongs.length} 首</span>
              <button
                type="button"
                className="text-btn"
                disabled={importBusy}
                onClick={() => fileRef.current?.click()}
              >
                导入
              </button>
            </div>
          </div>

          {jobRunning && job && (
            <>
              <ProgressBar
                stage={job.stage}
                ratio={job.ratio}
                onCancel={cancelImport}
              />
              <p className="tiny-note">
                可以切到音准仪练耳，分析会在后台继续；完成后这里会提示。
              </p>
            </>
          )}

          {showJobDone && job && (
            <Notice tone="success">
              <div className="notice-line">
                <span><CheckIcon />《{job.songName}》已分析完成，保存在我的歌里。</span>
              </div>
              <div className="notice-actions">
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    acknowledgeLibraryJob()
                    if (job.songId) void openLibrary(job.songId)
                  }}
                >
                  现在打开
                </button>
                <button
                  type="button"
                  className="text-btn muted"
                  onClick={acknowledgeLibraryJob}
                >
                  知道了
                </button>
              </div>
            </Notice>
          )}

          {showJobError && job && (
            <Notice tone="error">
              <div className="notice-line">
                <span>《{job.songName}》分析失败：{job.error ?? '请重试。'}</span>
              </div>
              <div className="notice-actions">
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    acknowledgeLibraryJob()
                    fileRef.current?.click()
                  }}
                >
                  重新选择文件
                </button>
                <button
                  type="button"
                  className="text-btn muted"
                  onClick={acknowledgeLibraryJob}
                >
                  知道了
                </button>
              </div>
            </Notice>
          )}

          {libraryLoading ? (
            <div className="record-skeletons" aria-label="正在读取歌曲库">
              {[0, 1].map((index) => (
                <div key={index} className="record-skeleton" />
              ))}
            </div>
          ) : librarySongs.length === 0 ? (
            <div className="library-empty">
              <MusicIcon />
              <div>
                <strong>还没有导入的歌</strong>
                <span>导入一次后，原曲、伴奏和旋律都会存在这里，下次秒开。</span>
              </div>
            </div>
          ) : (
            <ul className="library-list">
              {librarySongs.map((song) => {
                const lastRecord = lastRecordBySong.get(song.id)
                const lastScore = lastRecord?.score ?? null
                const lastText = !lastRecord
                  ? '还没练过'
                  : lastScore == null
                    ? '上次无有效得分'
                    : `上次 ${lastScore} 分`
                const renaming = renameId === song.id
                return (
                  <li key={song.id} className="library-song">
                    {renaming ? (
                      <form
                        className="library-rename"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void commitRename(song)
                        }}
                      >
                        <input
                          autoFocus
                          className="library-rename-input"
                          value={renameValue}
                          maxLength={60}
                          aria-label="歌曲名称"
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelRename()
                            }
                          }}
                        />
                        <button type="submit" className="icon-btn tiny" aria-label="保存名称">
                          <CheckIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn tiny"
                          aria-label="取消重命名"
                          onClick={cancelRename}
                        >
                          <CloseIcon />
                        </button>
                      </form>
                    ) : (
                      <>
                        <div
                          className="library-open"
                          role="button"
                          tabIndex={0}
                          aria-label={`打开 ${song.name}`}
                          onClick={() => void openLibrary(song.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void openLibrary(song.id)
                            }
                          }}
                        >
                          <span className="library-cover" aria-hidden="true">
                            <MusicIcon />
                          </span>
                          <span className="library-copy">
                            <strong>{song.name}</strong>
                            <span className="library-meta">
                              {formatTime(song.duration)} · {song.hasStems ? '伴奏已就绪' : '仅原曲'} · {lastText}
                            </span>
                            <span className="library-sub">
                              {formatBytes(song.sourceBytes + song.audioBytes + song.melodyBytes)}
                              {song.temporary ? ' · 临时检测' : ''}
                            </span>
                          </span>
                          <span className="library-open-icon">
                            {openingId === song.id ? <i className="spinner" /> : <ChevronRightIcon />}
                          </span>
                        </div>
                        <div className="library-actions">
                          <button
                            type="button"
                            className="icon-btn tiny"
                            aria-label={`重命名 ${song.name}`}
                            onClick={() => startRename(song)}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            type="button"
                            className="icon-btn tiny danger"
                            aria-label={`删除 ${song.name}`}
                            onClick={() => void removeSong(song)}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <div
            className={`import-card ${dragging ? 'dragging' : ''} ${importBusy ? 'busy' : ''}`}
            role="button"
            tabIndex={importBusy ? -1 : 0}
            aria-disabled={importBusy ? 'true' : undefined}
            onClick={() => {
              if (!importBusy) fileRef.current?.click()
            }}
            onKeyDown={onDropKey}
            onDragOver={(event) => {
              event.preventDefault()
              if (!importBusy) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <span className="import-icon">
              {importBusy ? <i className="spinner" /> : <UploadIcon />}
            </span>
            <span className="import-copy">
              <strong>
                {jobRunning
                  ? job?.stage ?? '正在分析…'
                  : checking
                    ? '正在查找歌曲缓存…'
                    : openingId
                      ? '正在打开歌曲…'
                      : demoBusy
                        ? '正在打开示例歌…'
                        : '导入音频文件'}
              </strong>
              <small>
                mp3 · m4a · wav · flac · ogg，桌面也可拖进来；分析结果会保存在本机
              </small>
            </span>
            <span className="import-plus"><PlusIcon /></span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".mp3,.m4a,.wav,.flac,.ogg,audio/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void handleFile(file)
            }}
          />
          {checking && <ProgressBar stage="正在查找歌曲缓存…" ratio={0.25} />}
          {error && <Notice tone="error">{error}</Notice>}
        </section>

        <section className="section-block">
          <div className="section-head">
            <div>
              <h2>示例歌</h2>
              <p>本地合成，不用找文件，点开就能唱</p>
            </div>
            <span className="count-badge">{demos.length} 首</span>
          </div>

          <div className="demo-list">
            {demos.map((demo, index) => (
              <button
                key={demo.id}
                type="button"
                className={`demo-card demo-${index % 3}`}
                disabled={demoBusy != null || checking || jobRunning || openingId != null}
                onClick={() => void chooseDemo(demo.id)}
              >
                <span className="demo-cover" aria-hidden="true">
                  <MusicIcon />
                  <i className="demo-cover-shine" />
                </span>
                <span className="demo-copy">
                  <strong>{demo.title}</strong>
                  <small>{demo.desc}</small>
                  <span className="demo-meta">
                    {formatDuration(demo.durationSec)} · 跟着旋律唱
                  </span>
                </span>
                <span className="demo-action">
                  {demoBusy === demo.id ? <i className="spinner" /> : <ChevronRightIcon />}
                </span>
              </button>
            ))}
          </div>
        </section>

        <aside className="headphone-note">
          <HeadphonesIcon />
          <div>
            <strong>建议戴耳机</strong>
            <span>
              外放时，伴奏会被麦克风收进去，音高检测容易跟着伴奏跑。导入歌默认播放去人声伴奏，
              需要参考时可在练唱页切到原唱人声。
            </span>
          </div>
        </aside>

        <p className="tiny-note privacy-note">
          所有音频、分轨与录音都在本机处理，不会上传。歌曲库和练习记录保存在设备的 IndexedDB 中。
        </p>
      </main>

      {windowDragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">
            <span className="drop-overlay-icon"><UploadIcon /></span>
            <strong>松开即可导入歌曲</strong>
            <span>mp3 · m4a · wav · flac · ogg</span>
          </div>
        </div>
      )}
    </div>
  )
}
