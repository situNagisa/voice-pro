import { useEffect, useRef, useState } from 'react'
import {
  OUTPUT_KIND_LABEL,
  currentOutputInfo,
  deviceProfileKey,
  kindProfileKey,
  measureSpeakerLatency,
  measureTapLatency,
} from '../audio/calibration'
import type {
  CalibrationMethod,
  CalibrationMeasurement,
  LatencyProfile,
  OutputInfo,
  OutputKind,
} from '../audio/calibration'
import type { Settings } from '../state/settings'
import { Notice, ProgressBar, Segmented } from './controls'
import { CloseIcon, HeadphonesIcon, MicIcon } from './icons'

interface LatencyCalibrationDialogProps {
  open: boolean
  recordingAllowed: boolean
  settings: Settings
  onClose: () => void
  onSave: (patch: Partial<Settings>) => void
}

type Phase = 'setup' | 'measuring' | 'done' | 'error'

/**
 * 延迟校准弹窗：外放 click 或戴耳机跟拍。
 * 结果立刻写进设置；下次练唱按当前输出设备自动套用。
 */
export function LatencyCalibrationDialog({
  open,
  recordingAllowed,
  settings,
  onClose,
  onSave,
}: LatencyCalibrationDialogProps) {
  const [method, setMethod] = useState<CalibrationMethod>('speaker')
  const [kind, setKind] = useState<OutputKind>(settings.lastOutputKind)
  const [phase, setPhase] = useState<Phase>('setup')
  const [progress, setProgress] = useState<{ stage: string; ratio: number }>({
    stage: '',
    ratio: 0,
  })
  const [result, setResult] = useState<CalibrationMeasurement | null>(null)
  const [output, setOutput] = useState<OutputInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runRef = useRef(0)
  const openedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      openedRef.current = false
      return
    }
    // 只在弹窗打开时初始化；保存后 settings 变化不能把结果重置掉。
    if (openedRef.current) return
    openedRef.current = true
    setPhase('setup')
    setResult(null)
    setError(null)
    setProgress({ stage: '', ratio: 0 })
    setKind(settings.lastOutputKind)
    setMethod(settings.lastOutputKind === 'speaker' ? 'speaker' : 'tap')
    setOutput(null)
    const infoController = new AbortController()
    void currentOutputInfo().then((info) => {
      if (infoController.signal.aborted) return
      setOutput(info)
      if (info.kind) {
        setKind(info.kind)
        setMethod(info.kind === 'speaker' ? 'speaker' : 'tap')
      }
    })
    return () => {
      infoController.abort()
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [open, settings.lastOutputKind])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase !== 'measuring') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, phase, onClose])

  if (!open) return null

  function chooseMethod(next: CalibrationMethod): void {
    setMethod(next)
    if (next === 'speaker') setKind('speaker')
    else if (kind === 'speaker') setKind('wired')
  }

  async function start(): Promise<void> {
    if (!recordingAllowed) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const run = ++runRef.current
    setPhase('measuring')
    setResult(null)
    setError(null)
    setProgress({ stage: '准备校准…', ratio: 0 })
    try {
      const measurement =
        method === 'speaker'
          ? await measureSpeakerLatency({
              signal: controller.signal,
              onProgress: (stage, ratio) => {
                if (run === runRef.current) setProgress({ stage, ratio })
              },
            })
          : await measureTapLatency({
              signal: controller.signal,
              onProgress: (stage, ratio) => {
                if (run === runRef.current) setProgress({ stage, ratio })
              },
            })
      if (run !== runRef.current) return
      const info = await currentOutputInfo()
      if (run !== runRef.current) return
      setOutput(info)
      setResult(measurement)
      setPhase('done')

      const profile: LatencyProfile = {
        ms: measurement.ms,
        method: measurement.method,
        kind,
        measuredAt: Date.now(),
        spreadMs: measurement.spreadMs,
        samples: measurement.samples,
      }
      const label = info.label.trim()
      if (label) profile.deviceLabel = label
      if (info.id && info.id !== 'default') profile.deviceId = info.id
      const profiles = { ...settings.latencyProfiles, [kindProfileKey(kind)]: profile }
      const deviceKey = deviceProfileKey(label)
      if (deviceKey) profiles[deviceKey] = profile
      onSave({
        latencyProfiles: profiles,
        lastOutputKind: kind,
        // 校准后改用自动套用；之前的手动值不再覆盖结果。
        latencyMs: null,
      })
    } catch (err) {
      if (run !== runRef.current) return
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPhase('setup')
        return
      }
      setError(err instanceof Error ? err.message : '校准失败，请重试。')
      setPhase('error')
    } finally {
      if (run === runRef.current) abortRef.current = null
    }
  }

  function cancel(): void {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase('setup')
    setProgress({ stage: '', ratio: 0 })
  }

  return (
    <div className="calib-layer" role="dialog" aria-modal="true" aria-labelledby="calib-title">
      <div className="calib-card">
        <header className="calib-head">
          <div>
            <p className="eyebrow">延迟自动校准</p>
            <h1 id="calib-title">让你唱准的时候被判准</h1>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭校准"
            onClick={onClose}
            disabled={phase === 'measuring'}
          >
            <CloseIcon />
          </button>
        </header>

        {!recordingAllowed && (
          <Notice tone="warn">
            校准需要麦克风。请先在隐私说明里同意麦克风与本地处理，再回来校准。
          </Notice>
        )}

        {phase === 'setup' || phase === 'error' ? (
          <>
            <p className="calib-lead">
              蓝牙耳机、不同手机的外放，声音进出会差 100–300 ms。校准一次，后续练唱按当前输出设备自动补偿。
            </p>

            <Segmented
              label="校准方式"
              value={method}
              onChange={chooseMethod}
              options={[
                { value: 'speaker', label: '外放 click', sub: '声学测量' },
                { value: 'tap', label: '戴耳机跟拍', sub: '含反应时间' },
              ]}
              hint={
                method === 'speaker'
                  ? '手机外放几声短促的 click，麦克风检测到达时间，取中位数。请把手机放在桌上、不要戴耳机，环境尽量安静。'
                  : '戴上耳机，跟着 10 下节拍拍手或说「嗒」。结果包含你的反应时间（通常 50–150 ms），所以数值会比纯设备延迟大，这是正常的。'
              }
            />

            <Segmented
              label="当前输出设备"
              value={kind}
              onChange={(value) => setKind(value)}
              options={[
                { value: 'speaker', label: '外放' },
                { value: 'wired', label: '有线' },
                { value: 'bluetooth', label: '蓝牙' },
              ]}
              hint={
                output?.label
                  ? `识别到：${output.label}。同名设备会单独保存一份结果。`
                  : '设备名不可用时按这个分类保存；换一副耳机后可以再校准一次。'
              }
            />

            {method === 'speaker' && kind !== 'speaker' && (
              <Notice tone="warn">
                外放 click 适合手机外放。戴着耳机时 click 几乎不会进麦克风，请改用「戴耳机跟拍」。
              </Notice>
            )}
            {method === 'tap' && kind === 'speaker' && (
              <Notice tone="warn">
                跟拍校准时如果外放，麦克风会直接收到节拍声，结果会偏小。建议戴耳机。
              </Notice>
            )}

            {error && <Notice tone="error">{error}</Notice>}

            <div className="calib-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                以后再说
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!recordingAllowed}
                onClick={() => void start()}
              >
                {method === 'speaker' ? '开始外放校准' : '开始跟拍校准'}
              </button>
            </div>
            <p className="calib-note">
              校准只在本机进行，不会保存或上传录音；过程中请让页面保持在前台。首次练唱前不校准也能用，只是起音和节奏判定可能偏晚。
            </p>
          </>
        ) : phase === 'measuring' ? (
          <>
            <div className="calib-listening">
              {method === 'speaker' ? <MicIcon /> : <HeadphonesIcon />}
              <div>
                <strong>
                  {method === 'speaker' ? '请保持安静，别遮住扬声器' : '戴好耳机，跟着节拍拍手'}
                </strong>
                <span>
                  {method === 'speaker'
                    ? '会播放 7 下 click，手机离自己约 30 厘米，音量保持 60% 以上。'
                    : '听到「嗒」就拍手或说「嗒」，不用刻意抢拍，按平时唱歌的感觉来。'}
                </span>
              </div>
            </div>
            <ProgressBar
              stage={progress.stage || '正在校准…'}
              ratio={progress.ratio}
              onCancel={cancel}
            />
            <p className="calib-note">整个过程约 10–20 秒。</p>
          </>
        ) : (
          <>
            <div className="calib-result">
              <div className="calib-value">
                {result?.ms ?? 0}
                <span>ms</span>
              </div>
              <p>
                建议补偿 {result?.ms ?? 0} ms。已按
                <strong>{OUTPUT_KIND_LABEL[kind]}</strong>
                {output?.label ? `（${output.label}）` : ''}保存，之后练唱会自动套用。
              </p>
              <div className="calib-result-meta">
                <span>{result?.samples ?? 0} 次有效测量</span>
                <span>波动 ±{result?.spreadMs ?? 0} ms</span>
                <span>{result?.method === 'speaker' ? '外放声学' : '跟拍（含反应）'}</span>
              </div>
            </div>
            {(result?.spreadMs ?? 0) > 80 && (
              <Notice tone="warn">
                这次测量波动偏大。可以在安静环境里重测，或戴耳机改用跟拍方式。
              </Notice>
            )}
            {result?.method === 'tap' && (
              <p className="calib-note">
                跟拍结果包含你的自然反应时间。如果之后觉得判定“太宽容”，可以到设置里把「输入延迟补偿」手动调小一点。
              </p>
            )}
            <div className="calib-actions">
              <button type="button" className="btn ghost" onClick={() => setPhase('setup')}>
                重测
              </button>
              <button type="button" className="btn primary" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
