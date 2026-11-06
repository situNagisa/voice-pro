import { useEffect, useState } from 'react'
import type { SessionReport } from '../audio/analysis'
import type { PracticeRecord } from '../state/records'
import {
  canvasToBlob,
  downloadScoreCard,
  renderScoreCard,
  scoreCardFileName,
  shareScoreCard,
  shareSupportsFile,
} from '../share/scoreCard'
import { CloseIcon, DownloadIcon, ShareIcon } from './icons'

interface ShareCardDialogProps {
  open: boolean
  record: PracticeRecord
  report: SessionReport
  grade: string
  onClose: () => void
}

type Phase = 'rendering' | 'ready' | 'error'

export function ShareCardDialog({
  open,
  record,
  report,
  grade,
  onClose,
}: ShareCardDialogProps) {
  const [phase, setPhase] = useState<Phase>('rendering')
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let active = true
    let url: string | null = null
    setPhase('rendering')
    setMessage(null)
    setBusy(false)
    setImageUrl(null)
    setBlob(null)
    setFile(null)

    void renderScoreCard(record, { grade, report })
      .then((canvas) => canvasToBlob(canvas))
      .then((nextBlob) => {
        if (!active) return
        const fileName = scoreCardFileName(record)
        const nextFile = new File([nextBlob], fileName, { type: 'image/png' })
        url = URL.createObjectURL(nextBlob)
        setBlob(nextBlob)
        setFile(nextFile)
        setImageUrl(url)
        setPhase('ready')
      })
      .catch((error: unknown) => {
        console.warn('[voice-pro] 成绩卡生成失败', error)
        if (active) setPhase('error')
      })

    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [open, attempt, record, report, grade])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  const fileName = scoreCardFileName(record)
  const shareable = file != null && shareSupportsFile(file)
  const hitText = report.hitRate == null ? '' : `，命中率 ${Math.round(report.hitRate * 100)}%`
  const shareText = `我在音准镜唱了《${record.songName}》，${record.score ?? '—'} 分${hitText}。`

  async function handleShare(): Promise<void> {
    if (!file) return
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await shareScoreCard(file, '我的音准成绩卡', shareText)
      setMessage(outcome === 'shared' ? '已分享' : '已取消分享')
    } catch (error) {
      console.warn('[voice-pro] 分享成绩卡失败', error)
      if (blob) {
        downloadScoreCard(blob, fileName)
        setMessage('系统分享不可用，已改为下载图片。')
      } else {
        setMessage('分享失败，请改存图片。')
      }
    } finally {
      setBusy(false)
    }
  }

  function handleDownload(): void {
    if (!blob) return
    downloadScoreCard(blob, fileName)
    setMessage('已保存 PNG 图片。')
  }

  return (
    <div className="sheet-layer share-layer">
      <button type="button" className="sheet-backdrop" aria-label="关闭成绩卡" onClick={onClose} />
      <section
        className="share-card-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="分享成绩卡"
      >
        <header className="share-card-head">
          <div>
            <p className="eyebrow">分享</p>
            <h2>我的成绩卡</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="share-card-preview">
          {phase === 'rendering' && (
            <div className="share-card-loading">
              <i className="spinner" />
              <span>正在生成成绩卡…</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="share-card-loading">
              <strong>成绩卡生成失败</strong>
              <span>浏览器没有成功绘制图片，可以重试或先关闭。</span>
              <button type="button" className="btn small secondary" onClick={() => setAttempt((value) => value + 1)}>
                重试
              </button>
            </div>
          )}
          {phase === 'ready' && imageUrl && (
            <img src={imageUrl} alt={`${record.songName} 的成绩卡预览`} />
          )}
        </div>

        <div className="share-card-actions">
          {shareable && (
            <button
              type="button"
              className="btn primary"
              disabled={phase !== 'ready' || busy}
              onClick={() => void handleShare()}
            >
              <ShareIcon />
              {busy ? '正在分享…' : '分享图片'}
            </button>
          )}
          <button
            type="button"
            className={`btn ${shareable ? 'secondary' : 'primary'}`}
            disabled={phase !== 'ready'}
            onClick={handleDownload}
          >
            <DownloadIcon />
            保存 PNG
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        {message && <p className="share-card-message">{message}</p>}
        <p className="tiny-note center">
          成绩卡在本机生成，图片只会通过你选择的分享方式发出，不会上传到服务器。
        </p>
      </section>
    </div>
  )
}
