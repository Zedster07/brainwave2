import { Routes, Route } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { CommandCenter } from './features/command-center/CommandCenter'
import { AgentMonitor } from './features/agent-monitor/AgentMonitor'
import { MemoryPalace } from './features/memory-palace/MemoryPalace'
import { PlanBoard } from './features/plan-board/PlanBoard'
import { Scheduler } from './features/scheduler/Scheduler'
import { ReflectionJournal } from './features/reflection/ReflectionJournal'
import { Settings } from './features/settings/Settings'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<CommandCenter />} />
        <Route path="/agents" element={<AgentMonitor />} />
        <Route path="/memory" element={<MemoryPalace />} />
        <Route path="/plan" element={<PlanBoard />} />
        <Route path="/scheduler" element={<Scheduler />} />
        <Route path="/reflection" element={<ReflectionJournal />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  )
}
