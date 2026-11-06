import { useEffect, useMemo, useRef, useState } from 'react'
import { hasCalibration, latestProfile, profileSummary } from '../audio/calibration'
import type { InputSource } from '../audio/capture'
import { adviseKey } from '../audio/keyAdvisor'
import { formatTime } from '../audio/pitch'
import { loadVoiceStats } from '../state/records'
import type { VoiceRangeSummary } from '../state/records'
import type { LoadedSong } from '../state/session'
import type { Settings } from '../state/settings'
import { Notice, SourcePicker, Stepper, TopBar } from '../ui/controls'
import { HeadphonesIcon, PlayIcon, SongIcon } from '../ui/icons'

interface PrepViewProps {
  song: LoadedSong
  settings: Settings
  recordingAllowed: boolean
  onBack: () => void
  onStart: (source: InputSource) => void
  onPatchSettings: (patch: Partial<Settings>) => void
  onOpenPrivacy: () => void
  onOpenCalibration: () => void
}

export function PrepView({
  song,
  settings,
  recordingAllowed,
  onBack,
  onStart,
  onPatchSettings,
  onOpenPrivacy,
  onOpenCalibration,
}: PrepViewProps) {
  const [source, setSource] = useState<InputSource>('mic')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [voiceStats, setVoiceStats] = useState<VoiceRangeSummary | null>(null)
  const [voiceLoading, setVoiceLoading] = useState(true)
  const startedRef = useRef(false)

  useEffect(() => {
    let active = true
    void loadVoiceStats()
      .then((stats) => {
        if (active) setVoiceStats(stats)
      })
      .catch(() => {
        if (active) setVoiceStats(null)
      })
      .finally(() => {
        if (active) setVoiceLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const advice = useMemo(
    () => adviseKey(voiceStats, song.melody.notes),
    [voiceStats, song.melody.notes],
  )

  useEffect(() => {
    if (!recordingAllowed) {
      if (countdown != null) setCountdown(null)
      return
    }
    if (countdown == null) return
    if (countdown <= 0) {
      if (startedRef.current) return
      startedRef.current = true
      onStart(source)
      return
    }
    const timer = window.setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown, onStart, source, recordingAllowed])

  const seconds = song.buffer.duration
  const noteCount = song.melody.notes.length
  const lastCalibration = latestProfile(settings.latencyProfiles)
  const calibrated = hasCalibration(settings.latencyMs, settings.latencyProfiles)

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
              <span className="tag">{song.accompaniment ? '伴奏已就绪' : '仅原曲'}</span>
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

        {(song.temporary || song.warning) && (
          <div className="notice warn">
            {song.warning ?? '参考旋律来自简易检测，可能把伴奏误判成旋律，报告仅供粗略参考。'}
          </div>
        )}

        {!recordingAllowed && (
          <Notice tone="warn">
            <div className="notice-line">
              <span>当前为仅浏览模式：你还没有同意隐私说明，麦克风、录音与练唱不会启用。</span>
            </div>
            <div className="notice-actions">
              <button type="button" className="text-btn" onClick={onOpenPrivacy}>
                查看隐私说明并同意
              </button>
            </div>
          </Notice>
        )}

        <section
          className={`card key-advice ${advice.sufficient && advice.semitones !== 0 ? 'has-suggestion' : ''}`}
        >
          <div className="key-advice-head">
            <div>
              <p className="eyebrow">为你推荐调性</p>
              <h2>{voiceLoading ? '正在统计你唱过的音高…' : advice.headline}</h2>
              <p>
                {voiceLoading
                  ? '只统计本机练习记录，不上传声音。'
                  : advice.detail}
              </p>
            </div>
            {!voiceLoading && advice.sufficient && (
              <div className="key-advice-value" aria-hidden="true">
                {advice.semitones > 0 ? '+' : ''}
                {advice.semitones}
                <span>半音</span>
              </div>
            )}
          </div>
          <div className="key-advice-foot">
            {voiceLoading ? (
              <span className="tiny-note">正在读取历史练习记录…</span>
            ) : advice.sufficient ? (
              <>
                <span className="tiny-note">
                  推荐会同时作用在参考旋律与伴奏上，保持速度不变。
                </span>
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={settings.transpose === advice.semitones}
                  onClick={() => onPatchSettings({ transpose: advice.semitones })}
                >
                  {settings.transpose === advice.semitones
                    ? '已应用这个调'
                    : `用 ${advice.semitones > 0 ? '+' : ''}${advice.semitones} 练`}
                </button>
              </>
            ) : (
              <span className="tiny-note">
                还不用急着定调。完成两三次练唱后，这里会根据你实际唱出的高音和低音给出建议。
              </span>
            )}
          </div>
        </section>

        <section className="card prep-card">
          <SourcePicker
            value={source}
            onChange={setSource}
            disabled={!recordingAllowed}
          />
          <Stepper
            label="移调"
            value={settings.transpose}
            min={-6}
            max={6}
            onChange={(value) => onPatchSettings({ transpose: value })}
            format={(value) => `${value > 0 ? '+' : ''}${value} 半音`}
            hint="参考旋律、伴奏与原曲一起变调，速度不变；练唱中也能随时再改。"
          />
          <div className={`prep-calib-row ${calibrated ? 'is-ready' : ''}`}>
              <div>
                <strong>
                  {settings.latencyMs != null
                    ? `手动补偿 ${settings.latencyMs} ms`
                    : calibrated
                      ? '延迟已校准'
                      : '还没校准延迟'}
                </strong>
                <span>
                  {settings.latencyMs != null
                    ? '当前用手动值；校准后会改用按输出设备自动套用的结果。'
                    : lastCalibration
                      ? `${profileSummary(lastCalibration)}。换耳机或外放后可以再测。`
                      : '第一次用这副耳机 / 这个外放？花 20 秒测一次，起音和节奏判定会更准。'}
                </span>
              </div>
              <button type="button" className="btn secondary small" onClick={onOpenCalibration}>
                {calibrated ? '重新校准' : '校准延迟'}
              </button>
            </div>
            <div className="prep-tip">
            <HeadphonesIcon />
            <div>
              <strong>戴耳机，听清自己</strong>
              <span>
                {song.accompaniment
                  ? '练唱页默认播放去人声伴奏，需要参考时可以切到原唱人声。外放时麦克风仍会收到伴奏，曲线容易跟着跑。'
                  : '这首歌没有可用的伴奏分离结果，会直接播放原曲。外放时麦克风会收到原曲，曲线容易跟着跑。'}
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
            disabled={!recordingAllowed}
            onClick={() => {
              if (!recordingAllowed) {
                onOpenPrivacy()
                return
              }
              setCountdown(3)
            }}
          >
            <PlayIcon />
            {recordingAllowed ? '开始练唱' : '请先同意隐私说明'}
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
          <p className="countdown-hint">准备好，跟着{song.accompaniment ? '伴奏' : '原曲'}开口</p>
        </div>
      )}
    </div>
  )
}
