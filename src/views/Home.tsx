import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { extractMelodyWithFallback } from '../audio/extract'
import { formatDuration, isSecureAudioContext } from '../audio/pitch'
import type { LoadedSong } from '../state/session'
import type { RecentSong } from '../state/library'
import type { Settings } from '../state/settings'
import { Notice, ProgressBar } from '../ui/controls'
import {
  HeadphonesIcon,
  MicIcon,
  MusicIcon,
  SettingsIcon,
} from '../ui/icons'

interface HomeProps {
  settings: Settings
  recent: RecentSong[]
  onReady: (song: LoadedSong) => void
  onFree: () => void
  onSettings: () => void
  onRemoveRecent: (id: string) => void
  onClearRecent: () => void
}

const ACCEPTED_EXTENSIONS = ['mp3', 'm4a', 'wav', 'flac', 'ogg']

type BusyStage = 'decode' | 'extract' | null

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `song-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function Home({
  settings,
  recent,
  onReady,
  onFree,
  onSettings,
  onRemoveRecent,
  onClearRecent,
}: HomeProps) {
  const [busy, setBusy] = useState<BusyStage>(null)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const fileRef = useRef<HTMLInputElement | null>(null)
  const runRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const decodeCtxRef = useRef<AudioContext | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      const ctx = decodeCtxRef.current
      decodeCtxRef.current = null
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    }
  }, [])

  const secure = isSecureAudioContext()

  function cancel(): void {
    runRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    const ctx = decodeCtxRef.current
    decodeCtxRef.current = null
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    setBusy(null)
    setProgress(0)
    setStage('')
  }

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file || busy) return
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

    const runId = runRef.current + 1
    runRef.current = runId
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setBusy('decode')
    setStage('读取文件…')
    setProgress(0.02)

    const ctx = new AudioContext({ latencyHint: 'playback' })
    decodeCtxRef.current = ctx

    try {
      const data = await file.arrayBuffer()
      if (runId !== runRef.current) return
      setStage('解码音频…')
      setProgress(0.1)

      let buffer: AudioBuffer
      try {
        buffer = await ctx.decodeAudioData(data)
      } catch {
        throw new Error('无法解码这个音频文件。请确认它是 mp3 / m4a / wav / flac / ogg，且文件没有损坏。')
      }
      if (runId !== runRef.current) return
      if (buffer.duration < 1) throw new Error('这首歌太短了，请选择至少 1 秒的音频。')

      setBusy('extract')
      setStage('分析参考旋律…')
      setProgress(0.28)

      const result = await extractMelodyWithFallback(
        buffer,
        (nextStage, ratio) => {
          if (runId !== runRef.current) return
          setStage(nextStage)
          setProgress(0.28 + Math.max(0, Math.min(1, ratio)) * 0.7)
        },
        controller.signal,
      )
      if (runId !== runRef.current) return

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
      onReady(song)
    } catch (err) {
      if (runId !== runRef.current || controller.signal.aborted) return
      const message = err instanceof Error ? err.message : '导入失败，请重试。'
      setError(message)
      setBusy(null)
    } finally {
      if (decodeCtxRef.current === ctx) decodeCtxRef.current = null
      if (ctx.state !== 'closed') void ctx.close().catch(() => undefined)
      if (abortRef.current === controller) abortRef.current = null
      if (runId === runRef.current && mountedRef.current) {
        setBusy(null)
      }
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    if (!busy) setDragging(true)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }

  function handleDropzoneKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!busy) fileRef.current?.click()
    }
  }

  return (
    <div className="screen home">
      <header className="home-header">
        <div className="brand">
          <img src="/icon.svg" alt="" width={46} height={46} />
          <div>
            <h1>音准镜</h1>
            <p>唱得准不准，一眼看见</p>
          </div>
        </div>
        <button type="button" className="btn ghost settings-link" onClick={onSettings}>
          <SettingsIcon />
          设置
        </button>
      </header>

      <main className="home-grid">
        <section className="card import-card">
          <div className="eyebrow">本地人声分析</div>
          <h2>跟着歌，找到不准的那一句</h2>
          <p className="lead">
            导入一首你正在练的歌，实时对照原曲旋律。音频只在你的设备上处理，不会上传。
          </p>
          <div className="feature-chips" aria-label="功能">
            <span>实时音高</span>
            <span>偏差着色</span>
            <span>逐句报告</span>
          </div>

          {!secure && (
            <Notice tone="warn">
              当前页面不是 HTTPS。手机通过局域网访问时需要 HTTPS 才能使用麦克风。
            </Notice>
          )}

          <div
            className={`dropzone ${dragging ? 'drag' : ''} ${busy ? 'disabled' : ''}`}
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-disabled={busy ? 'true' : undefined}
            onClick={() => {
              if (!busy) fileRef.current?.click()
            }}
            onKeyDown={handleDropzoneKey}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <span className="drop-icon">
              <MusicIcon />
            </span>
            <span className="drop-title">选择歌曲文件，或拖放到这里</span>
            <span className="drop-sub">mp3 · m4a · wav · flac · ogg</span>
            <span className="btn primary">选择歌曲</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".mp3,.m4a,.wav,.flac,.ogg,audio/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              void handleFile(file)
            }}
          />

          {busy && (
            <ProgressBar stage={stage} ratio={progress} onCancel={cancel} />
          )}

          {error && (
            <Notice tone="error">
              {error}
            </Notice>
          )}

          <div className="headphone-hint">
            <HeadphonesIcon />
            <span>练唱时建议戴耳机：v0.1 没有伴奏分离，原曲就是伴奏，外放会被麦克风收进去。</span>
          </div>
        </section>

        <div className="home-side">
          <section className="card free-card">
            <div className="free-icon">
              <MicIcon />
            </div>
            <div>
              <div className="eyebrow">不需要歌曲</div>
              <h3>自由练习 / 调音器</h3>
              <p>不导入歌曲，只看自己的音高、音名和偏差，也可以给乐器调音。</p>
            </div>
            <button type="button" className="btn secondary block" onClick={onFree}>
              打开自由练习
            </button>
          </section>

          <section className="card recent-card">
            <div className="card-head">
              <h3>最近导入</h3>
              {recent.length > 0 && (
                <button type="button" className="text-btn" onClick={onClearRecent}>
                  清空
                </button>
              )}
            </div>
            {recent.length === 0 ? (
              <p className="muted">还没有记录。导入歌曲后会显示在这里。</p>
            ) : (
              <>
                <ul className="recent-list">
                  {recent.map((song) => (
                    <li key={song.id} className="recent-item">
                      <span className="recent-icon">
                        <MusicIcon />
                      </span>
                      <span className="recent-info">
                        <strong>{song.name}</strong>
                        <small>
                          {formatDuration(song.duration)} · {song.noteCount} 个参考音符 ·{' '}
                          {new Date(song.importedAt).toLocaleDateString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                          })}
                        </small>
                        {song.temporary && <em className="mini-tag">临时旋律</em>}
                      </span>
                      <button
                        type="button"
                        className="icon-btn tiny"
                        aria-label={`移除 ${song.name}`}
                        onClick={() => onRemoveRecent(song.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="tiny-note">v0.1 只保存歌曲信息，不保存音频文件；再次练习请重新导入。</p>
              </>
            )}
          </section>

          <section className="home-tip">
            <div className="tip-title">当前默认设置</div>
            <div className="tip-row">
              <span>偏差容忍度</span>
              <strong>±{settings.tolerance} 音分</strong>
            </div>
            <div className="tip-row">
              <span>八度自动对齐</span>
              <strong>{settings.octaveAlign ? '已开启' : '关闭'}</strong>
            </div>
            <div className="tip-row">
              <span>参考旋律移调</span>
              <strong>{settings.transpose === 0 ? '原调' : `${settings.transpose > 0 ? '+' : ''}${settings.transpose} 半音`}</strong>
            </div>
          </section>
        </div>
      </main>

      <footer className="home-footer">
        <span>音准镜 v0.1</span>
        <span>所有音频处理都在本机完成</span>
      </footer>
    </div>
  )
}
