import { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { NotificationToast } from '../NotificationToast'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  useKeyboardShortcuts()

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar />

        {/* Page content */}
        <main className="flex-1 overflow-y-auto px-8 py-6">
          <div className="animate-fade-in">
            {children}
          </div>
        </main>
      </div>

      {/* Notification toasts */}
      <NotificationToast />
    </div>
  )
}
