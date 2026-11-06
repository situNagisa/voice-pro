import { useEffect, useState } from 'react'
import type { InputSource } from './audio/capture'
import type { PracticeRecord, PracticeRecordMeta } from './state/records'
import {
  clearRecords,
  deleteRecord,
  listRecords,
  loadRecord,
} from './state/records'
import type { LoadedSong } from './state/session'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './state/settings'
import type { Settings } from './state/settings'
import { BottomNav } from './ui/BottomNav'
import type { TabKey } from './ui/BottomNav'
import { SettingsSheet } from './ui/SettingsSheet'
import { SideNav } from './ui/SideNav'
import { PrepView } from './views/PrepView'
import { PracticeView } from './views/Practice'
import type { PracticeResult } from './views/Practice'
import { RecordsView } from './views/Records'
import { ReportView } from './views/Report'
import { ReviewView } from './views/Review'
import { SongsHome } from './views/SongsHome'
import { TunerView } from './views/Tuner'
import './App.css'

type Overlay =
  | { kind: 'prep'; song: LoadedSong }
  | { kind: 'practice'; song: LoadedSong; source: InputSource }
  | { kind: 'report'; result: PracticeResult }
  | {
      kind: 'review'
      record: PracticeRecord
      song: LoadedSong | null
      startAt: number
      returnTo: Overlay | null
    }

function App() {
  const [tab, setTab] = useState<TabKey>('songs')
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [records, setRecords] = useState<PracticeRecordMeta[]>([])
  const [recordsLoading, setRecordsLoading] = useState(true)
  const [openingRecord, setOpeningRecord] = useState(false)
  const [libraryRevision, setLibraryRevision] = useState(0)

  async function refreshRecords(): Promise<void> {
    setRecordsLoading(true)
    const next = await listRecords()
    setRecords(next)
    setRecordsLoading(false)
  }

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [tab, overlay])

  useEffect(() => {
    // 首次进入时读取本机记录；之后的增删会主动刷新
    void refreshRecords()
  }, [])

  function patchSettings(patch: Partial<Settings>): void {
    setSettings((current) => ({ ...current, ...patch }))
  }

  function openSong(song: LoadedSong): void {
    setOverlay({ kind: 'prep', song })
  }

  function startPractice(song: LoadedSong, source: InputSource): void {
    setOverlay({ kind: 'practice', song, source })
  }

  function finishPractice(result: PracticeResult): void {
    setOverlay({ kind: 'report', result })
    void refreshRecords()
  }

  function openReviewFromReport(result: PracticeResult, startAt: number): void {
    const reportOverlay: Overlay = { kind: 'report', result }
    setOverlay({
      kind: 'review',
      record: result.record,
      song: result.song,
      startAt,
      returnTo: reportOverlay,
    })
  }

  async function openRecord(id: string): Promise<void> {
    setOpeningRecord(true)
    try {
      const record = await loadRecord(id)
      if (!record) {
        setRecords(await listRecords())
        return
      }
      const sortedPoints = record.points.slice().sort((a, b) => a.t - b.t)
      const firstNote = record.melodyNotes.slice().sort((a, b) => a.start - b.start)[0]
      const targetStart = Math.max(0, firstNote?.start ?? 0)
      const startPoint =
        sortedPoints.find((point) => point.t >= targetStart - 0.2) ?? sortedPoints[0]
      setOverlay({
        kind: 'review',
        record,
        song: null,
        startAt: startPoint?.t ?? targetStart,
        returnTo: null,
      })
    } catch (error) {
      console.warn('[voice-pro] 打开记录失败', error)
    } finally {
      setOpeningRecord(false)
    }
  }

  async function removeRecord(id: string): Promise<void> {
    try {
      await deleteRecord(id)
    } catch (error) {
      console.warn('[voice-pro] 删除记录失败', error)
    }
    await refreshRecords()
  }

  async function clearAllRecords(): Promise<void> {
    try {
      await clearRecords()
    } catch (error) {
      console.warn('[voice-pro] 清空记录失败', error)
    }
    await refreshRecords()
  }

  function backToTabs(): void {
    setOverlay(null)
    void refreshRecords()
  }

  function navigate(tabKey: TabKey): void {
    setOverlay(null)
    setTab(tabKey)
  }

  useEffect(() => {
    // Esc 返回：练唱与回看页各自处理（需要先确认/停止播放），这里管准备页与报告页。
    if (!overlay || settingsOpen) return
    if (overlay.kind === 'practice' || overlay.kind === 'review') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      setOverlay(null)
      void refreshRecords()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, settingsOpen])

  let content
  if (overlay?.kind === 'prep') {
    content = (
      <PrepView
        song={overlay.song}
        settings={settings}
        onBack={backToTabs}
        onStart={(source) => startPractice(overlay.song, source)}
      />
    )
  } else if (overlay?.kind === 'practice') {
    content = (
      <PracticeView
        key={`${overlay.song.id}-${overlay.source}`}
        song={overlay.song}
        settings={settings}
        source={overlay.source}
        initialLoop={null}
        loopLabel={null}
        onPatchSettings={patchSettings}
        onFinish={finishPractice}
        onBack={backToTabs}
      />
    )
  } else if (overlay?.kind === 'report') {
    content = (
      <ReportView
        record={overlay.result.record}
        onBack={backToTabs}
        onReview={(startAt) => openReviewFromReport(overlay.result, startAt)}
        onRestart={() => setOverlay({ kind: 'prep', song: overlay.result.song })}
      />
    )
  } else if (overlay?.kind === 'review') {
    content = (
      <ReviewView
        key={overlay.record.id}
        record={overlay.record}
        initialSong={overlay.song}
        startAt={overlay.startAt}
        onBack={() => setOverlay(overlay.returnTo)}
      />
    )
  } else {
    content = (
      <>
        {tab === 'songs' && (
          <SongsHome
            settings={settings}
            records={records}
            libraryRevision={libraryRevision}
            onSong={openSong}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        {tab === 'tuner' && (
          <TunerView onOpenSettings={() => setSettingsOpen(true)} />
        )}
        {tab === 'records' && (
          <RecordsView
            records={records}
            loading={recordsLoading}
            onOpen={(id) => void openRecord(id)}
            onDelete={(id) => void removeRecord(id)}
            onGoSongs={() => setTab('songs')}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        <BottomNav active={tab} onChange={setTab} />
      </>
    )
  }

  return (
    <div className={`app-shell ${overlay ? 'has-overlay' : ''}`}>
      <SideNav active={tab} onNavigate={navigate} onOpenSettings={() => setSettingsOpen(true)} />
      <div className="app-main">
        {content}
        {openingRecord && (
          <div className="boot-overlay">
            <div className="spinner large" />
            <span>正在读取记录…</span>
          </div>
        )}
      </div>
      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        recordCount={records.length}
        onClose={() => setSettingsOpen(false)}
        onPatch={patchSettings}
        onReset={() => setSettings({ ...DEFAULT_SETTINGS })}
        onClearRecords={() => void clearAllRecords()}
        onLibraryCleared={() => setLibraryRevision((value) => value + 1)}
      />
    </div>
  )
}

export default App
