import { useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { evaluateSession } from '../audio/analysis'
import { formatCents, formatTime, midiToNoteName } from '../audio/pitch'
import { readingAt, recordMelody } from '../audio/review'
import type { PracticeRecord } from '../state/records'
import { TopBar } from '../ui/controls'
import { ChevronRightIcon, PlayIcon, RefreshIcon } from '../ui/icons'
import { PitchRoll } from '../ui/PitchRoll'
import { useIsDesktop } from '../ui/useMediaQuery'

interface ReportViewProps {
  record: PracticeRecord
  onBack: () => void
  onReview: (startAt: number) => void
  onRestart: () => void
}

function gradeFor(score: number | null): { title: string; desc: string } {
  if (score == null) {
    return {
      title: '这次没有有效数据',
      desc: '没有检测到能和参考旋律对齐的音高。确认麦克风有声音、戴着耳机、跟着原曲唱，再试一次。',
    }
  }
  if (score >= 90) return { title: '非常稳', desc: '大部分音都落在容忍范围内，可以挑战更严格的判定。' }
  if (score >= 75) return { title: '唱得不错', desc: '整体音准在线，下面标出了还可以再稳一点的地方。' }
  if (score >= 60) return { title: '已经找到感觉', desc: '先回看最需要练的句子，把音头和长音稳定下来。' }
  if (score >= 40) return { title: '还需要多练几遍', desc: '别急着唱完整首，逐句听、逐句跟，会更快进步。' }
  return { title: '先从一句开始', desc: '先挑一句最短的，回看曲线，再慢慢跟着唱。' }
}

function scoreTone(score: number | null): string {
  if (score == null) return 'none'
  if (score >= 80) return 'good'
  if (score >= 60) return 'warn'
  return 'low'
}

export function ReportView({ record, onBack, onReview, onRestart }: ReportViewProps) {
  const melody = useMemo(() => recordMelody(record), [record])
  const report = useMemo(
    () =>
      evaluateSession(record.points, melody, {
        transpose: record.transpose,
        octaveAlign: record.octaveAlign,
        tolerance: record.tolerance,
      }),
    [record, melody],
  )
  const grade = gradeFor(record.score)
  const scoreStyle = { '--score': record.score ?? 0 } as CSSProperties
  const hitPercent = report.hitRate == null ? null : Math.round(report.hitRate * 100)
  const focusIndex = report.phrases.find(
    (phrase) => phrase.samples >= 5 && phrase.hitRate != null,
  )?.index

  const isDesktop = useIsDesktop()
  const sortedPoints = useMemo(
    () => record.points.slice().sort((a, b) => a.t - b.t),
    [record.points],
  )
  const pointsRef = useRef(sortedPoints)
  const [activePhraseIndex, setActivePhraseIndex] = useState<number | null>(null)
  const [previewCursor, setPreviewCursor] = useState<number | null>(null)
  const activeIndex = activePhraseIndex ?? focusIndex ?? report.phrases[0]?.index ?? null
  const activePhrase = report.phrases.find((phrase) => phrase.index === activeIndex) ?? null
  const previewCenterRef = useRef(
    activePhrase ? activePhrase.start + (activePhrase.end - activePhrase.start) / 2 : 0,
  )
  const previewDuration = melody.duration || record.duration
  const previewTime = previewCursor ?? activePhrase?.start ?? 0
  const previewReading = readingAt(sortedPoints, previewTime, melody, {
    transpose: record.transpose,
    octaveAlign: record.octaveAlign,
    tolerance: record.tolerance,
  })
  const previewNote = previewReading ? midiToNoteName(previewReading.point.midi) : null
  const previewCents = previewReading?.comparison?.cents ?? null
  const previewSeverity =
    previewCents == null
      ? 'neutral'
      : Math.abs(previewCents) <= record.tolerance
        ? 'good'
        : previewCents > 0
          ? 'sharp'
          : 'flat'

  function selectPhrase(phrase: { index: number; start: number; end: number }): void {
    setActivePhraseIndex(phrase.index)
    setPreviewCursor(phrase.start + 0.02)
    previewCenterRef.current = Math.max(0, phrase.start + (phrase.end - phrase.start) / 2)
  }

  return (
    <div className="screen report-screen">
      <TopBar
        title="练习报告"
        subtitle={record.songName}
        onBack={onBack}
        right={
          <div className="topbar-tools">
            <span className="key-hints desktop-only">Esc 返回</span>
            <span className={`score-chip ${scoreTone(record.score)}`}>{record.score ?? '—'} 分</span>
          </div>
        }
      />

      <main className="page report-page">
        <section className="card report-hero">
          <div className="score-ring" style={scoreStyle}>
            <div className="score-ring-inner">
              <strong>{record.score ?? '—'}</strong>
              <span>总分</span>
            </div>
          </div>
          <div className="report-headline">
            <p className="eyebrow">本次结果</p>
            <h1>{grade.title}</h1>
            <p>{grade.desc}</p>
            <div className="tag-row">
              <span className="tag">±{record.tolerance} 音分</span>
              <span className="tag">{record.loop ? '循环练习' : `${formatTime(record.duration)} 完整练习`}</span>
              {record.transpose !== 0 && (
                <span className="tag warn">移调 {record.transpose > 0 ? '+' : ''}{record.transpose}</span>
              )}
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
            <small>正数偏高 · 负数偏低</small>
          </div>
          <div className="stat-card">
            <span>有效音高</span>
            <strong>{report.validFrames}</strong>
            <small>{report.hits} 个落在范围内</small>
          </div>
        </section>

        {report.validFrames === 0 && (
          <div className="notice warn">
            这次没有检测到有效音高。检查麦克风是否在收音、是否戴耳机、声音是否太小。
          </div>
        )}

        <div className="report-review-grid">
        <section className="section-block report-phrases">
          <div className="section-head">
            <div>
              <h2>逐句回看</h2>
              <p>{isDesktop ? '选中一句，右侧同时查看音高卷帘' : '点任意一句，跳到那一刻的音高曲线与录音'}</p>
            </div>
            <button type="button" className="text-btn" onClick={() => onReview(0)}>
              完整回看
            </button>
          </div>

          {report.phrases.length === 0 ? (
            <p className="muted">没有提取到可断句的参考音符。</p>
          ) : (
            <ul className="phrase-list">
              {report.phrases.map((phrase) => {
                const rate = phrase.hitRate == null ? null : Math.round(phrase.hitRate * 100)
                const tone = rate == null ? 'none' : rate >= 75 ? 'good' : rate >= 50 ? 'warn' : 'bad'
                const isFocus = focusIndex === phrase.index
                return (
                  <li key={`${phrase.index}-${phrase.start}`}>
                    <button
                      type="button"
                      className={`phrase-row ${isFocus ? 'focus' : ''} ${isDesktop && activePhrase?.index === phrase.index ? 'active' : ''}`}
                      onClick={() => {
                        if (isDesktop) selectPhrase(phrase)
                        else onReview(phrase.start)
                      }}
                      aria-label={isDesktop ? `选中第 ${phrase.index + 1} 句` : `回看第 ${phrase.index + 1} 句`}
                    >
                      <div className="phrase-row-top">
                        <span className="phrase-title">
                          第 {phrase.index + 1} 句
                          {isFocus && <em>最需要练</em>}
                        </span>
                        <span className={`phrase-rate ${tone}`}>
                          {rate == null ? '无数据' : `${rate}%`}
                        </span>
                      </div>
                      <div className="phrase-row-meta">
                        <span>{formatTime(phrase.start)} – {formatTime(phrase.end)}</span>
                        <span>{phrase.noteLabels.join(' · ') || '—'}</span>
                        <span className={phrase.avgCents == null ? '' : phrase.avgCents > 0 ? 'sharp' : 'flat'}>
                          {phrase.avgCents == null ? '—' : `${formatCents(phrase.avgCents)} 音分`}
                        </span>
                      </div>
                      <div className="hit-bar">
                        <i
                          className={tone === 'none' ? '' : tone}
                          style={{ width: `${rate ?? 0}%` }}
                        />
                      </div>
                      <span className="phrase-row-action">
                        {isDesktop ? '在右侧查看' : '回看这句'}
                        <ChevronRightIcon />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="tiny-note">
            回看时会显示你当时的音高曲线；示例歌可以同时听原唱，导入歌只能回放录音。
          </p>
        </section>

        {isDesktop && activePhrase && (
          <aside className="report-preview card">
            <div className="preview-head">
              <div className="preview-title">
                <span className="eyebrow">选中句子</span>
                <strong>第 {activePhrase.index + 1} 句</strong>
                <span>
                  {formatTime(activePhrase.start)} – {formatTime(activePhrase.end)}
                  {activePhrase.hitRate != null && ` · 命中 ${Math.round(activePhrase.hitRate * 100)}%`}
                </span>
              </div>
              <button
                type="button"
                className="btn small secondary"
                onClick={() => onReview(activePhrase.start)}
              >
                打开完整回看
                <ChevronRightIcon />
              </button>
            </div>
            <div className="preview-roll">
              <PitchRoll
                melody={melody}
                pointsRef={pointsRef}
                duration={previewDuration}
                transpose={record.transpose}
                octaveAlign={record.octaveAlign}
                tolerance={record.tolerance}
                mode="practice"
                interactive
                active={false}
                getPlayhead={() => previewCursor ?? previewTime}
                getCenter={() => previewCenterRef.current}
                getCursor={() => previewCursor}
                highlight={{ start: activePhrase.start, end: activePhrase.end }}
                onPick={(time) => setPreviewCursor(Math.max(0, Math.min(previewDuration, time)))}
                onPan={(delta) => {
                  previewCenterRef.current = Math.max(
                    0,
                    Math.min(previewDuration, previewCenterRef.current + delta),
                  )
                }}
                ariaLabel="报告中的音高卷帘预览"
                playheadLabel="选中"
              />
            </div>
            <div className="preview-foot">
              <span className={`preview-readout severity-${previewSeverity}`}>
                {previewReading ? (
                  <>
                    <strong>{previewNote?.label ?? '—'}</strong>
                    <span className={`preview-cents ${previewSeverity}`}>
                      {previewCents == null ? '暂无参考' : `${formatCents(previewCents)} 音分`}
                    </span>
                    <span>{formatTime(previewTime)}</span>
                  </>
                ) : (
                  <span>{formatTime(previewTime)} 附近没有检测到人声</span>
                )}
              </span>
              <span className="key-hints">点按定位 · 滚轮缩放 · 拖动平移</span>
            </div>
          </aside>
        )}
        </div>

        <p className="score-formula">总分 = 命中率 70% + 音准稳定度 30%。</p>

        <div className="report-actions">
          <button type="button" className="btn primary" onClick={() => onReview(0)}>
            <PlayIcon />
            查看完整回看
          </button>
          <button type="button" className="btn secondary" onClick={onRestart}>
            <RefreshIcon />
            再练一次
          </button>
          <button type="button" className="btn ghost" onClick={onBack}>
            回到练歌
          </button>
        </div>
      </main>
    </div>
  )
}
