import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent } from 'react'
import { extractMelodyWithFallback } from '../audio/extract'
import { formatDuration, isSecureAudioContext } from '../audio/pitch'
import { listDemoSongs } from '../demo'
import { loadDemoSong } from '../state/demo'
import type { LoadedSong } from '../state/session'
import type { Settings } from '../state/settings'
import { Notice, ProgressBar } from '../ui/controls'
import {
  ChevronRightIcon,
  HeadphonesIcon,
  MusicIcon,
  PlusIcon,
  SettingsIcon,
  UploadIcon,
} from '../ui/icons'

interface SongsHomeProps {
  settings: Settings
  onSong: (song: LoadedSong) => void
  onOpenSettings: () => void
}

const ACCEPTED_EXTENSIONS = ['mp3', 'm4a', 'wav', 'flac', 'ogg']

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `song-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function SongsHome({ settings, onSong, onOpenSettings }: SongsHomeProps) {
  const demos = listDemoSongs()
  const [demoBusy, setDemoBusy] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [windowDragging, setWindowDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const secure = isSecureAudioContext()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  async function chooseDemo(id: string): Promise<void> {
    if (demoBusy || busy) return
    setError(null)
    setDemoBusy(id)
    try {
      const song = await loadDemoSong(id)
      onSong(song)
    } catch (err) {
      setError(err instanceof Error ? err.message : '示例歌加载失败，请重试。')
    } finally {
      setDemoBusy(null)
    }
  }

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file || busy || demoBusy) return
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    const looksAudio = file.type.startsWith('audio/') || ACCEPTED_EXTENSIONS.includes(extension)
    if (!looksAudio) {
      setError('请选择 mp3、m4a、wav、flac 或 ogg 音频文件。')
      return
    }
    if (file.size === 0) {
      setError('这个文件是空的，请换一个音频文件。')
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setBusy(true)
    setStage('读取文件…')
    setProgress(0.02)
    const ctx = new AudioContext({ latencyHint: 'playback' })

    try {
      const data = await file.arrayBuffer()
      setStage('解码音频…')
      setProgress(0.1)
      let buffer: AudioBuffer
      try {
        buffer = await ctx.decodeAudioData(data)
      } catch {
        throw new Error('无法解码这个音频文件。请确认它是 mp3 / m4a / wav / flac / ogg，且文件没有损坏。')
      }
      if (buffer.duration < 1) throw new Error('这首歌太短了，请选择至少 1 秒的音频。')

      setStage('分析参考旋律…')
      setProgress(0.28)
      const result = await extractMelodyWithFallback(
        buffer,
        (nextStage, ratio) => {
          setStage(nextStage)
          setProgress(0.28 + Math.max(0, Math.min(1, ratio)) * 0.7)
        },
        controller.signal,
      )
      const song: LoadedSong = {
        id: newId(),
        name: file.name.replace(/\.[^.]+$/, '') || '未命名歌曲',
        buffer,
        melody: result.melody,
        temporary: result.temporary,
        warning: result.warning,
        importedAt: Date.now(),
      }
      setProgress(1)
      setStage('准备就绪')
      onSong(song)
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : '导入失败，请重试。')
      }
    } finally {
      abortRef.current = null
      setBusy(false)
      void ctx.close().catch(() => undefined)
    }
  }

  function cancelImport(): void {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setProgress(0)
    setStage('')
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
      if (!busy) fileRef.current?.click()
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
          disabled={busy || demoBusy != null}
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
            <span className="tag">本地处理</span>
            <span className="tag">可回放</span>
          </div>
        </section>

        {!secure && (
          <Notice tone="warn">
            当前页面不是 HTTPS，手机浏览器会拒绝麦克风。请用 https 或 localhost 打开。
          </Notice>
        )}

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
                disabled={demoBusy != null || busy}
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

        <section className="section-block">
          <div className="section-head">
            <div>
              <h2>导入我的歌</h2>
              <p>从你的设备选一首歌，本地分析参考旋律</p>
            </div>
          </div>
          <div
            className={`import-card ${dragging ? 'dragging' : ''} ${busy ? 'busy' : ''}`}
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-disabled={busy ? 'true' : undefined}
            onClick={() => {
              if (!busy) fileRef.current?.click()
            }}
            onKeyDown={onDropKey}
            onDragOver={(event) => {
              event.preventDefault()
              if (!busy) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <span className="import-icon">
              <UploadIcon />
            </span>
            <span className="import-copy">
              <strong>{busy ? stage || '处理中…' : '选择音频文件'}</strong>
              <small>mp3 · m4a · wav · flac · ogg，桌面也可拖进来</small>
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
          {busy && <ProgressBar stage={stage} ratio={progress} onCancel={cancelImport} />}
          {error && <Notice tone="error">{error}</Notice>}
        </section>

        <aside className="headphone-note">
          <HeadphonesIcon />
          <div>
            <strong>建议戴耳机</strong>
            <span>外放时，原曲会被麦克风收进去，音高检测容易跟着伴奏跑。没有耳机也可以先用示例歌试试。</span>
          </div>
        </aside>

        <p className="tiny-note privacy-note">
          所有音频与录音都在本机处理，不会上传。练习记录保存在设备的 IndexedDB 中。
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
