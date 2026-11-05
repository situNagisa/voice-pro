import { useEffect } from 'react'
import type { Settings } from '../state/settings'
import { Notice, Segmented, Slider, Stepper, Toggle } from './controls'
import { CloseIcon } from './icons'

interface SettingsSheetProps {
  open: boolean
  settings: Settings
  recordCount: number
  onClose: () => void
  onPatch: (patch: Partial<Settings>) => void
  onReset: () => void
  onClearRecords: () => void
}

export function SettingsSheet({
  open,
  settings,
  recordCount,
  onClose,
  onPatch,
  onReset,
  onClearRecords,
}: SettingsSheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="sheet-layer">
      <button type="button" className="sheet-backdrop" aria-label="关闭设置" onClick={onClose} />
      <aside className="settings-sheet" role="dialog" aria-modal="true" aria-label="设置">
        <header className="sheet-head">
          <div>
            <div className="eyebrow">偏好</div>
            <h2>设置</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭设置" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="sheet-body">
          <section className="sheet-section">
            <h3>音准判定</h3>
            <Segmented
              label="偏差容忍度"
              value={settings.tolerance}
              onChange={(value) => onPatch({ tolerance: value })}
              options={[
                { value: 25, label: '±25', sub: '严格' },
                { value: 50, label: '±50', sub: '标准' },
                { value: 75, label: '±75', sub: '宽松' },
              ]}
              hint="偏差在范围内显示为“准”。严格模式适合抠细节。"
            />
            <Toggle
              label="八度自动对齐"
              checked={settings.octaveAlign}
              onChange={(checked) => onPatch({ octaveAlign: checked })}
              hint="男声唱女歌等整体差八度时，按最近的八度比较。"
            />
            <Stepper
              label="参考旋律移调"
              value={settings.transpose}
              min={-6}
              max={6}
              onChange={(value) => onPatch({ transpose: value })}
              format={(value) => `${value > 0 ? '+' : ''}${value} 半音`}
              hint="只移动参考条块与评分；v0.1 原曲播放不变调。"
            />
            {settings.transpose !== 0 && (
              <Notice tone="warn">
                参考旋律已移调 {settings.transpose > 0 ? '+' : ''}
                {settings.transpose} 半音。跟着原曲唱时请调回 0。
              </Notice>
            )}
          </section>

          <section className="sheet-section">
            <h3>声音</h3>
            <Slider
              label="原曲音量"
              value={Math.round(settings.volume * 100)}
              min={0}
              max={100}
              step={1}
              onChange={(value) => onPatch({ volume: value / 100 })}
              format={(value) => `${value}%`}
              hint="没有伴奏分离，原曲就是伴奏。戴耳机时用能听清自己的音量。"
            />
            <Slider
              label="输入延迟补偿"
              value={settings.latencyMs ?? 60}
              min={0}
              max={300}
              step={5}
              onChange={(value) => onPatch({ latencyMs: value })}
              format={() => (settings.latencyMs == null ? '自动' : `${settings.latencyMs} ms`)}
              hint={
                settings.latencyMs == null
                  ? '自动：开始练唱时按设备延迟估算。拖动后改为手动值。'
                  : '手动值。曲线总比参考条块提前时，把数值调大。'
              }
            />
            {settings.latencyMs != null && (
              <button
                type="button"
                className="text-btn align-left"
                onClick={() => onPatch({ latencyMs: null })}
              >
                恢复自动估算
              </button>
            )}
          </section>

          <section className="sheet-section">
            <h3>本机数据</h3>
            <div className="sheet-data-row">
              <div>
                <strong>练习记录</strong>
                <span>{recordCount} 次 · 保存音高轨迹与录音，仅在本机</span>
              </div>
              <button
                type="button"
                className="btn small ghost-danger"
                disabled={recordCount === 0}
                onClick={() => {
                  if (window.confirm('删除全部练习记录？录音也会一起删除，无法恢复。')) {
                    onClearRecords()
                  }
                }}
              >
                全部删除
              </button>
            </div>
            <button
              type="button"
              className="text-btn align-left"
              onClick={() => {
                if (window.confirm('恢复默认设置？')) onReset()
              }}
            >
              恢复默认设置
            </button>
          </section>

          <section className="sheet-section about">
            <h3>关于音准镜</h3>
            <p>
              本地实时音高对比工具。麦克风和录音都在设备上处理，不会上传。
              示例歌为本地合成，不需要网络。
            </p>
            <p className="muted">v0.1 · React + Web Audio</p>
          </section>
        </div>
      </aside>
    </div>
  )
}
