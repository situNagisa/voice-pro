import { useEffect } from 'react'
import type { PrivacyChoice } from '../state/privacy'
import { MicIcon } from './icons'

interface PrivacyDialogProps {
  choice: PrivacyChoice | null
  onAccept: () => void
  onDecline: () => void
}

/**
 * 首次启动的隐私说明；也用于用户拒绝后重新阅读。
 * 不同意时不会退出应用，只会关闭录音相关功能，仍可浏览歌曲与记录。
 */
export function PrivacyDialog({ choice, onAccept, onDecline }: PrivacyDialogProps) {
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <div className="privacy-layer" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
      <div className="privacy-card">
        <div className="privacy-icon" aria-hidden="true">
          <MicIcon />
        </div>
        <p className="eyebrow">开始之前</p>
        <h1 id="privacy-title">关于麦克风与你的数据</h1>
        <p className="privacy-lead">
          音准镜需要在你主动开始练唱或使用音准仪时访问麦克风。请先了解这些：
        </p>
        <ul className="privacy-points">
          <li>
            <strong>麦克风用途</strong>
            <span>只在练唱、单句循环和音准仪里启用，用于实时音高检测与本地录音。</span>
          </li>
          <li>
            <strong>本机处理，不上传</strong>
            <span>音频、录音、分轨与练习记录都在设备上处理，不会发送到服务器，也不收集个人信息。</span>
          </li>
          <li>
            <strong>本地存储</strong>
            <span>歌曲缓存与练习记录保存在本机浏览器 / App 存储中，可在设置里随时删除。</span>
          </li>
        </ul>
        <p className="privacy-policy-line">
          完整说明见
          <a href="/privacy.html" target="_blank" rel="noreferrer">隐私政策</a>
          。
        </p>
        <div className="privacy-actions">
          <button type="button" className="btn ghost" onClick={onDecline}>
            不同意，仅浏览
          </button>
          <button type="button" className="btn primary" onClick={onAccept}>
            同意并继续
          </button>
        </div>
        {choice === 'declined' && (
          <p className="privacy-current">
            当前为仅浏览模式。重新选择“同意并继续”即可开启录音与练唱。
          </p>
        )}
        {choice === 'accepted' && (
          <p className="privacy-current">你已同意隐私说明，可以随时在设置里重新查看。</p>
        )}
      </div>
    </div>
  )
}
