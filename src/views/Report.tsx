import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { evaluateSession } from '../audio/analysis'
import { formatCents, formatTime } from '../audio/pitch'
import { recordMelody } from '../audio/review'
import type { PracticeRecord } from '../state/records'
import { TopBar } from '../ui/controls'
import { ChevronRightIcon, PlayIcon, RefreshIcon } from '../ui/icons'

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

  return (
    <div className="screen report-screen">
      <TopBar
        title="练习报告"
        subtitle={record.songName}
        onBack={onBack}
        right={<span className={`score-chip ${scoreTone(record.score)}`}>{record.score ?? '—'} 分</span>}
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

        <section className="section-block report-phrases">
          <div className="section-head">
            <div>
              <h2>逐句回看</h2>
              <p>点任意一句，跳到那一刻的音高曲线与录音</p>
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
                      className={`phrase-row ${isFocus ? 'focus' : ''}`}
                      onClick={() => onReview(phrase.start)}
                      aria-label={`回看第 ${phrase.index + 1} 句`}
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
                        回看这句
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
