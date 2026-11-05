import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { evaluateSession } from '../audio/analysis'
import type { PhraseReport } from '../audio/analysis'
import { formatCents, formatTime } from '../audio/pitch'
import type { LoopRange } from '../audio/player'
import type { PracticeSession } from '../state/session'
import { Notice, TopBar } from '../ui/controls'
import { PlayIcon, StopIcon } from '../ui/icons'

interface ReportViewProps {
  session: PracticeSession
  onHome: () => void
  onRestart: () => void
  onPracticeLoop: (range: LoopRange, label: string) => void
}

interface PreviewHandle {
  ctx: AudioContext
  gain: GainNode
  source: AudioBufferSourceNode | null
}

function gradeFor(score: number | null): { title: string; desc: string } {
  if (score == null) {
    return {
      title: '这次没有有效数据',
      desc: '没有检测到可对齐的音高。确认麦克风有声音、戴着耳机、并且跟着原曲唱后再试一次。',
    }
  }
  if (score >= 90) {
    return { title: '非常稳', desc: '大部分音都落在容忍范围内，可以挑战更严格的 ±25 音分了。' }
  }
  if (score >= 75) {
    return { title: '唱得不错', desc: '整体音准在线，下面是几处还可以再稳一点的地方。' }
  }
  if (score >= 60) {
    return { title: '已经找到感觉', desc: '重点练最前面的几句，把音头和长音都稳定下来。' }
  }
  if (score >= 40) {
    return { title: '还需要多练几遍', desc: '先放慢速度、跟着参考条块逐句练习，再回到整首。' }
  }
  return {
    title: '先从单句开始',
    desc: '别急着唱完整首。用“只练这句”循环慢练，听清原曲再跟唱。',
  }
}

function centsDescriptor(cents: number | null): string {
  if (cents == null) return ''
  if (Math.abs(cents) < 5) return '几乎居中'
  return cents > 0 ? '偏高' : '偏低'
}

export function ReportView({
  session,
  onHome,
  onRestart,
  onPracticeLoop,
}: ReportViewProps) {
  const report = useMemo(
    () =>
      evaluateSession(session.points, session.song.melody, {
        transpose: session.settings.transpose,
        octaveAlign: session.settings.octaveAlign,
        tolerance: session.settings.tolerance,
      }),
    [session],
  )
  const grade = gradeFor(report.score)
  const scoreStyle = { '--score': report.score ?? 0 } as CSSProperties
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const previewRef = useRef<PreviewHandle | null>(null)

  useEffect(() => {
    return () => {
      const handle = previewRef.current
      previewRef.current = null
      if (!handle) return
      if (handle.source) {
        handle.source.onended = null
        try {
          handle.source.stop()
        } catch {
          // 已结束
        }
        handle.source.disconnect()
      }
      handle.gain.disconnect()
      if (handle.ctx.state !== 'closed') void handle.ctx.close().catch(() => undefined)
    }
  }, [])

  function stopPreview(): void {
    const handle = previewRef.current
    if (!handle) return
    const source = handle.source
    handle.source = null
    if (source) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // 已结束
      }
      source.disconnect()
    }
    setPlayingIndex(null)
  }

  async function togglePreview(phrase: PhraseReport): Promise<void> {
    if (playingIndex === phrase.index) {
      stopPreview()
      return
    }
    stopPreview()

    let handle = previewRef.current
    if (!handle) {
      const ctx = new AudioContext({ latencyHint: 'playback' })
      const gain = ctx.createGain()
      gain.gain.value = 0.85
      gain.connect(ctx.destination)
      handle = { ctx, gain, source: null }
      previewRef.current = handle
    }

    try {
      await handle.ctx.resume()
    } catch {
      // 某些浏览器即使 resume 失败也允许开始播放；继续尝试
    }

    const buffer = session.song.buffer
    const start = Math.min(
      Math.max(0, phrase.start - 0.25),
      Math.max(0, buffer.duration - 0.06),
    )
    const playDuration = Math.max(
      0.08,
      Math.min(buffer.duration - start, phrase.end + 0.3 - start),
    )
    const source = handle.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(handle.gain)
    source.onended = () => {
      if (handle.source === source) {
        handle.source = null
        setPlayingIndex(null)
      }
    }
    handle.source = source
    source.start(0, start, playDuration)
    setPlayingIndex(phrase.index)
  }

  function practicePhrase(phrase: PhraseReport): void {
    const duration = session.song.buffer.duration
    const start = Math.max(0, phrase.start - 0.3)
    const end = Math.min(duration, phrase.end + 0.35)
    if (end - start < 0.2) return
    onPracticeLoop({ start, end }, `第 ${phrase.index + 1} 句`)
  }

  const focusIndex = report.phrases.find(
    (phrase) => phrase.samples >= 5 && phrase.hitRate != null,
  )?.index
  const hitPercent = report.hitRate == null ? null : Math.round(report.hitRate * 100)

  return (
    <div className="screen report">
      <TopBar
        title="练习报告"
        subtitle={session.song.name}
        onBack={onHome}
        right={
          report.transpose !== 0 ? (
            <span className="mini-tag">
              移调 {report.transpose > 0 ? '+' : ''}
              {report.transpose}
            </span>
          ) : undefined
        }
      />

      <main className="report-main">
        <section className="card report-hero">
          <div className="score-ring" style={scoreStyle}>
            <div className="score-ring-inner">
              <strong>{report.score ?? '—'}</strong>
              <span>总分</span>
            </div>
          </div>
          <div className="report-headline">
            <div className="eyebrow">本次结果</div>
            <h2>{grade.title}</h2>
            <p>{grade.desc}</p>
            <div className="report-badges">
              <span>容忍度 ±{report.tolerance} 音分</span>
              <span>参考 {report.phraseCount} 句</span>
              {report.octaveAlign && <span>八度已对齐</span>}
            </div>
          </div>
        </section>

        <section className="report-stats">
          <div className="stat-card">
            <span>命中率</span>
            <strong>{hitPercent == null ? '—' : `${hitPercent}%`}</strong>
            <small>落在容忍度内的音高帧</small>
          </div>
          <div className="stat-card">
            <span>平均偏差</span>
            <strong className={report.avgCents == null ? '' : report.avgCents > 0 ? 'sharp' : 'flat'}>
              {report.avgCents == null ? '—' : `${formatCents(report.avgCents)} 音分`}
            </strong>
            <small>{centsDescriptor(report.avgCents) || '正数 = 偏高，负数 = 偏低'}</small>
          </div>
          <div className="stat-card">
            <span>有效音高</span>
            <strong>{report.validFrames}</strong>
            <small>{report.hits} 个落在容忍范围</small>
          </div>
        </section>

        {session.song.temporary && (
          <Notice tone="warn">
            {session.song.warning ??
              '这首歌的参考旋律来自临时简易检测，条块可能包含伴奏误判，报告仅供开发预览。'}
          </Notice>
        )}

        {report.validFrames === 0 && (
          <Notice tone="warn">
            没有检测到能和参考旋律对齐的有效音高。可以检查：麦克风是否真的在收音、是否戴了耳机、
            音量是否太小，或者先关掉循环完整唱一遍。
          </Notice>
        )}

        <section className="card phrase-section">
          <div className="card-head">
            <div>
              <h3>逐句表现</h3>
              <p className="muted">参考旋律间隔超过 0.6 秒自动断句，最差的句子排在最前。</p>
            </div>
            {focusIndex != null && (
              <span className="focus-hint">标有“最需要练”的是优先项</span>
            )}
          </div>

          {report.phrases.length === 0 ? (
            <p className="muted">没有提取到可断句的参考音符。</p>
          ) : (
            <ul className="phrase-list">
              {report.phrases.map((phrase) => {
                const rate = phrase.hitRate == null ? null : Math.round(phrase.hitRate * 100)
                const isPlaying = playingIndex === phrase.index
                const isFocus = focusIndex === phrase.index
                return (
                  <li key={`${phrase.index}-${phrase.start}`} className={`phrase-item ${isFocus ? 'focus' : ''}`}>
                    <div className="phrase-head">
                      <div className="phrase-title">
                        <span className="phrase-index">第 {phrase.index + 1} 句</span>
                        <span className="phrase-time">
                          {formatTime(phrase.start)} – {formatTime(phrase.end)}
                        </span>
                        {isFocus && <span className="worst-badge">最需要练</span>}
                      </div>
                      <span className={`phrase-score ${rate == null ? 'none' : rate >= 75 ? 'good' : rate >= 50 ? 'warn' : 'bad'}`}>
                        {rate == null ? '无数据' : `${rate}%`}
                      </span>
                    </div>

                    <div className="phrase-notes">
                      {phrase.noteLabels.length > 0
                        ? phrase.noteLabels.join(' · ')
                        : '—'}
                      <span className="phrase-note-count">共 {phrase.noteCount} 个音符</span>
                    </div>

                    <div className="phrase-metrics">
                      <div>
                        <span>命中率</span>
                        <strong>{rate == null ? '—' : `${rate}%`}</strong>
                      </div>
                      <div>
                        <span>平均偏差</span>
                        <strong className={phrase.avgCents == null ? '' : phrase.avgCents > 0 ? 'sharp' : 'flat'}>
                          {phrase.avgCents == null
                            ? '—'
                            : `${formatCents(phrase.avgCents)} 音分`}
                        </strong>
                      </div>
                      <div>
                        <span>有效音高</span>
                        <strong>{phrase.samples}</strong>
                      </div>
                    </div>

                    <div className="hit-bar">
                      <i
                        className={rate == null ? '' : rate >= 75 ? 'good' : rate >= 50 ? 'warn' : 'bad'}
                        style={{ width: `${rate ?? 0}%` }}
                      />
                    </div>

                    {phrase.lowConfidence && (
                      <p className="tiny-note">这句录到的有效音高较少，结果不太可靠。</p>
                    )}

                    <div className="phrase-actions">
                      <button
                        type="button"
                        className={`btn small ${isPlaying ? 'primary' : ''}`}
                        onClick={() => void togglePreview(phrase)}
                      >
                        {isPlaying ? <StopIcon /> : <PlayIcon />}
                        {isPlaying ? '停止回放' : '回放这句'}
                      </button>
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={() => practicePhrase(phrase)}
                      >
                        只练这句（A-B 循环）
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="tiny-note">
            回放的是原曲这段，不是你的录音（v0.1 不录人声）。平均偏差正数表示整体偏高，负数表示偏低。
          </p>
        </section>

        <p className="score-formula">
          总分 = 命中率 70% + 音准稳定度 30%（稳定度按平均绝对偏差计算）。
        </p>

        <div className="report-actions">
          <button type="button" className="btn primary" onClick={onRestart}>
            再练一次
          </button>
          <button type="button" className="btn" onClick={onHome}>
            换一首歌
          </button>
        </div>
      </main>
    </div>
  )
}
