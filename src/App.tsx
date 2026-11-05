import { useEffect, useState } from 'react'
import type { LoopRange } from './audio/player'
import {
  addRecentSong,
  clearRecentSongs,
  loadRecentSongs,
  removeRecentSong,
} from './state/library'
import type { RecentSong } from './state/library'
import type { LoadedSong, PracticeSession } from './state/session'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './state/settings'
import type { Settings } from './state/settings'
import { FreeTune } from './views/FreeTune'
import { Home } from './views/Home'
import { PracticeView } from './views/Practice'
import { ReportView } from './views/Report'
import { SettingsView } from './views/Settings'
import './App.css'

type View = 'home' | 'practice' | 'report' | 'free' | 'settings'

function App() {
  const [view, setView] = useState<View>('home')
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [recent, setRecent] = useState<RecentSong[]>(() => loadRecentSongs())
  const [song, setSong] = useState<LoadedSong | null>(null)
  const [session, setSession] = useState<PracticeSession | null>(null)
  const [loop, setLoop] = useState<LoopRange | null>(null)
  const [loopLabel, setLoopLabel] = useState<string | null>(null)

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [view])

  function patchSettings(patch: Partial<Settings>): void {
    setSettings((current) => ({ ...current, ...patch }))
  }

  function handleReady(loaded: LoadedSong): void {
    setSong(loaded)
    setSession(null)
    setLoop(null)
    setLoopLabel(null)
    setRecent(
      addRecentSong({
        id: loaded.id,
        name: loaded.name,
        duration: loaded.buffer.duration,
        noteCount: loaded.melody.notes.length,
        temporary: loaded.temporary,
        importedAt: loaded.importedAt,
      }),
    )
    setView('practice')
  }

  function handleSessionEnd(nextSession: PracticeSession): void {
    setSession(nextSession)
    setView('report')
  }

  function handlePracticeLoop(range: LoopRange, label: string): void {
    setLoop(range)
    setLoopLabel(label)
    setView('practice')
  }

  function handleRestart(): void {
    setLoop(null)
    setLoopLabel(null)
    setView('practice')
  }

  function handleHome(): void {
    setView('home')
  }

  if (view === 'free') {
    return <FreeTune onHome={handleHome} />
  }

  if (view === 'settings') {
    return (
      <SettingsView
        settings={settings}
        recentCount={recent.length}
        onPatch={patchSettings}
        onReset={() => setSettings({ ...DEFAULT_SETTINGS })}
        onClearRecent={() => setRecent(clearRecentSongs())}
        onHome={handleHome}
      />
    )
  }

  if (view === 'practice' && song) {
    return (
      <PracticeView
        key={`${song.id}-${loop?.start ?? 'full'}-${loop?.end ?? ''}`}
        song={song}
        settings={settings}
        onPatchSettings={patchSettings}
        initialLoop={loop}
        initialLoopLabel={loopLabel}
        onEnd={handleSessionEnd}
        onHome={handleHome}
      />
    )
  }

  if (view === 'report' && session) {
    return (
      <ReportView
        session={session}
        onHome={handleHome}
        onRestart={handleRestart}
        onPracticeLoop={handlePracticeLoop}
      />
    )
  }

  return (
    <Home
      settings={settings}
      recent={recent}
      onReady={handleReady}
      onFree={() => setView('free')}
      onSettings={() => setView('settings')}
      onRemoveRecent={(id) => setRecent(removeRecentSong(id))}
      onClearRecent={() => setRecent(clearRecentSongs())}
    />
  )
}

export default App
