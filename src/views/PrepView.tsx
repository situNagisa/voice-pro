import { useEffect, useRef, useState } from 'react'
import type { InputSource } from '../audio/capture'
import { formatTime } from '../audio/pitch'
import type { LoadedSong } from '../state/session'
import type { Settings } from '../state/settings'
import { SourcePicker, TopBar } from '../ui/controls'
import { HeadphonesIcon, PlayIcon, SongIcon } from '../ui/icons'

interface PrepViewProps {
  song: LoadedSong
  settings: Settings
  onBack: () => void
  onStart: (source: InputSource) => void
}

export function PrepView({ song, settings, onBack, onStart }: PrepViewProps) {
  const [source, setSource] = useState<InputSource>('mic')
  const [countdown, setCountdown] = useState<number | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (countdown == null) return
    if (countdown <= 0) {
      if (startedRef.current) return
      startedRef.current = true
      onStart(source)
      return
    }
    const timer = window.setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown, onStart, source])

  const seconds = song.buffer.duration
  const noteCount = song.melody.notes.length

  return (
    <div className="screen prep-screen">
      <TopBar
        title="准备练唱"
        subtitle={song.name}
        onBack={onBack}
        right={<span className="key-hints desktop-only">Esc 返回</span>}
      />

      <main className="page prep-page">
        <section className="song-hero">
          <div className="song-cover" aria-hidden="true">
            <SongIcon />
            <span className="cover-ring" />
          </div>
          <div className="song-hero-copy">
            <p className="eyebrow">{song.demoId ? '内置示例歌' : '我的歌曲'}</p>
            <h1>{song.name}</h1>
            <p className="song-meta">
              {formatTime(seconds)} · {noteCount} 个参考音符
              {song.temporary ? ' · 临时检测' : ''}
            </p>
            <div className="tag-row">
              <span className="tag">目标 ±{settings.tolerance} 音分</span>
              <span className="tag">{settings.octaveAlign ? '八度已对齐' : '严格同八度'}</span>
              {settings.transpose !== 0 && (
                <span className="tag warn">
                  移调 {settings.transpose > 0 ? '+' : ''}
                  {settings.transpose}
                </span>
              )}
            </div>
          </div>
        </section>

        {song.temporary && (
          <div className="notice warn">
            {song.warning ?? '参考旋律来自简易检测，可能把伴奏误判成旋律，报告仅供粗略参考。'}
          </div>
        )}

        <section className="card prep-card">
          <SourcePicker value={source} onChange={setSource} />
          <div className="prep-tip">
            <HeadphonesIcon />
            <div>
              <strong>戴耳机，听清自己</strong>
              <span>
                原曲会直接播放，v0.1 还没有伴奏分离。外放时麦克风会收到原曲，曲线会跟着伴奏跑。
              </span>
            </div>
          </div>
          <div className="prep-tip subtle">
            <PlayIcon />
            <div>
              <strong>下方会先倒数 3 秒</strong>
              <span>倒数结束后开始播放与录音。中途随时可以暂停、回看刚才唱的部分。</span>
            </div>
          </div>

          <button
            type="button"
            className="btn primary xl start-button"
            onClick={() => setCountdown(3)}
          >
            <PlayIcon />
            开始练唱
          </button>
          <p className="tiny-note center">建议在安静的环境里，离手机约 20 厘米</p>
        </section>
      </main>

      {countdown != null && (
        <div className="countdown-layer" role="status" aria-live="assertive">
          <p className="countdown-song">{song.name}</p>
          <div key={countdown} className="countdown-number">
            {countdown > 0 ? countdown : '唱'}
          </div>
          <p className="countdown-hint">准备好，跟着原曲开口</p>
        </div>
      )}
    </div>
  )
}
