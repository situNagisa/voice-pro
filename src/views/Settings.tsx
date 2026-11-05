import type { Settings } from '../state/settings'
import { Notice, Segmented, Slider, Stepper, Toggle, TopBar } from '../ui/controls'

interface SettingsViewProps {
  settings: Settings
  recentCount: number
  onPatch: (patch: Partial<Settings>) => void
  onReset: () => void
  onClearRecent: () => void
  onHome: () => void
}

export function SettingsView({
  settings,
  recentCount,
  onPatch,
  onReset,
  onClearRecent,
  onHome,
}: SettingsViewProps) {
  const latencyValue = settings.latencyMs ?? 60
  return (
    <div className="screen settings">
      <TopBar title="设置" subtitle="自动保存在本机" onBack={onHome} />

      <main className="settings-main">
        <section className="card settings-section">
          <div className="section-heading">
            <h2>练唱默认值</h2>
            <p>这些值会带到下一次练唱，也可以在练唱页的高级设置里临时调整。</p>
          </div>

          <Segmented
            label="偏差容忍度"
            value={settings.tolerance}
            onChange={(value) => onPatch({ tolerance: value })}
            options={[
              { value: 25, label: '±25', sub: '严格' },
              { value: 50, label: '±50', sub: '标准' },
              { value: 75, label: '±75', sub: '宽松' },
            ]}
            hint="偏差在这个范围内算命中，并显示为绿色。"
          />

          <Toggle
            label="八度自动对齐"
            checked={settings.octaveAlign}
            onChange={(checked) => onPatch({ octaveAlign: checked })}
            hint="例如男声整体低八度唱女歌时，按最近的八度比较。开启后曲线会叠到参考条块附近。"
          />

          <Stepper
            label="参考旋律移调"
            value={settings.transpose}
            min={-6}
            max={6}
            onChange={(value) => onPatch({ transpose: value })}
            format={(value) => `${value > 0 ? '+' : ''}${value} 半音`}
            hint="只平移参考条块与评分。v0.1 原曲播放保持原调，不会跟着升 key 或降 key。"
          />

          {settings.transpose !== 0 && (
            <Notice tone="warn">
              移调只影响参考旋律。跟着原曲唱时，请用 0；如果要用新调清唱，请把原曲音量调到
              0。真正给原曲变调会在后续版本加入。
            </Notice>
          )}
        </section>

        <section className="card settings-section">
          <div className="section-heading">
            <h2>输入与声音</h2>
          </div>

          <Slider
            label="输入延迟补偿"
            value={latencyValue}
            min={0}
            max={300}
            step={5}
            onChange={(value) => onPatch({ latencyMs: value })}
            format={() => (settings.latencyMs == null ? '自动' : `${settings.latencyMs} ms`)}
            hint={
              settings.latencyMs == null
                ? '当前为自动：开始练唱时按 AudioContext 的 outputLatency + baseLatency 估算。拖动滑块会改用手动值。'
                : '手动值。若曲线相对参考块总是提前，可以适当调大。'
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

          <Slider
            label="原曲音量"
            value={Math.round(settings.volume * 100)}
            min={0}
            max={100}
            step={1}
            onChange={(value) => onPatch({ volume: value / 100 })}
            format={(value) => `${value}%`}
            hint="v0.1 没有伴奏分离，原曲就是伴奏。建议戴耳机，并把音量控制在能听清自己声音的程度。"
          />
        </section>

        <section className="card settings-section">
          <div className="section-heading">
            <h2>本机数据</h2>
            <p>音频文件只在内存里，刷新页面即消失；歌曲信息和设置存在 localStorage。</p>
          </div>
          <div className="data-row">
            <div>
              <strong>最近导入记录</strong>
              <span>{recentCount} 条 · 只包含歌名、时长、音符数和导入时间</span>
            </div>
            <button
              type="button"
              className="btn small"
              disabled={recentCount === 0}
              onClick={() => {
                if (window.confirm('清空最近导入记录？不会影响当前已导入的歌曲。')) {
                  onClearRecent()
                }
              }}
            >
              清空记录
            </button>
          </div>
          <div className="data-row">
            <div>
              <strong>设置</strong>
              <span>自动保存在浏览器 localStorage，不会上传。</span>
            </div>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                if (window.confirm('恢复默认设置？')) onReset()
              }}
            >
              恢复默认
            </button>
          </div>
        </section>

        <section className="card about-card">
          <h2>关于音准镜 v0.1</h2>
          <p>
            一款只看“你唱得准不准”的本地工具。导入歌曲后会分析参考旋律，实时对比你的麦克风音高，
            结束时按乐句给出报告。所有处理都在设备上完成。
          </p>
          <ul>
            <li>支持格式：mp3 / m4a / wav / flac / ogg（取决于浏览器的解码能力）。</li>
            <li>手机系统限制：无法读取其他 App 的播放声音，只能使用麦克风。</li>
            <li>桌面浏览器可使用“标签页 / 系统声音”分析其他软件播放的音频。</li>
            <li>v0.1 不保存音频，也不录音，因此报告不能回放你自己的声音。</li>
          </ul>
          <p className="tiny-note">可以把这个网页安装到主屏幕，作为 PWA 离线打开。</p>
        </section>
      </main>
    </div>
  )
}
