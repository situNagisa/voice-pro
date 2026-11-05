import type { InputSource } from '../audio/capture'
import { canCaptureDisplayAudio, clamp } from '../audio/pitch'
import {
  ChevronLeftIcon,
  DisplayIcon,
  MicIcon,
} from './icons'
import type { ReactNode } from 'react'

export function TopBar({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  right?: ReactNode
}) {
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="icon-btn" aria-label="返回" onClick={onBack}>
          <ChevronLeftIcon />
        </button>
      )}
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {right && <div className="topbar-right">{right}</div>}
    </header>
  )
}

export interface SegmentOption<T extends string | number> {
  value: T
  label: string
  sub?: string
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
}: {
  label?: string
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  hint?: ReactNode
}) {
  return (
    <div className="field">
      {label && <div className="field-label">{label}</div>}
      <div className="segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={option.value === value ? 'active' : ''}
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {option.sub && <small>{option.sub}</small>}
          </button>
        ))}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  hint,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  format?: (value: number) => string
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="field">
      <span className="field-label slider-label">
        <span>{label}</span>
        <output>{format ? format(value) : value}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="toggle-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-copy">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <span className={`switch ${checked ? 'on' : ''}`} aria-hidden="true" />
    </button>
  )
}

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  format,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  format?: (value: number) => string
  hint?: ReactNode
}) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="stepper">
        <button
          type="button"
          aria-label={`${label}减小`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - 1, min, max))}
        >
          −
        </button>
        <output>{format ? format(value) : value}</output>
        <button
          type="button"
          aria-label={`${label}增大`}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + 1, min, max))}
        >
          +
        </button>
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

export function SourcePicker({
  value,
  onChange,
  disabled,
}: {
  value: InputSource
  onChange: (value: InputSource) => void
  disabled?: boolean
}) {
  const canDisplay = canCaptureDisplayAudio()
  return (
    <div className="field">
      <div className="field-label">输入来源</div>
      <div className={`source-options ${canDisplay ? 'two' : 'one'}`}>
        <button
          type="button"
          className={`source-option ${value === 'mic' ? 'active' : ''}`}
          aria-pressed={value === 'mic'}
          disabled={disabled}
          onClick={() => onChange('mic')}
        >
          <MicIcon />
          <span>
            <strong>麦克风</strong>
            <small>唱自己的声音</small>
          </span>
        </button>
        {canDisplay && (
          <button
            type="button"
            className={`source-option ${value === 'display' ? 'active' : ''}`}
            aria-pressed={value === 'display'}
            disabled={disabled}
            onClick={() => onChange('display')}
          >
            <DisplayIcon />
            <span>
              <strong>标签页 / 系统声音</strong>
              <small>分析其他软件正在播放的音频</small>
            </span>
          </button>
        )}
      </div>
      <p className="field-hint">
        {canDisplay ? (
          <>
            练唱请选麦克风。捕获来源用于分析外部播放的声音，不会包含你的歌声。
            外放时建议戴耳机，否则原曲会被麦克风收进去。
          </>
        ) : (
          <>
            当前设备或浏览器不支持捕获其他应用的声音（手机系统限制，部分桌面浏览器也未实现），
            已隐藏该来源。这里只能使用麦克风；外放会串音，建议戴耳机。
          </>
        )}
      </p>
    </div>
  )
}

export function ProgressBar({
  stage,
  ratio,
  onCancel,
}: {
  stage: string
  ratio: number
  onCancel?: () => void
}) {
  const percent = Math.round(clamp(ratio, 0, 1) * 100)
  return (
    <div className="extract-progress">
      <div className="progress-head">
        <span>{stage}</span>
        <span>{percent}%</span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <i style={{ width: `${percent}%` }} />
      </div>
      {onCancel && (
        <button type="button" className="btn ghost small" onClick={onCancel}>
          取消
        </button>
      )}
    </div>
  )
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success'
  children: ReactNode
}) {
  return <div className={`notice ${tone}`}>{children}</div>
}
