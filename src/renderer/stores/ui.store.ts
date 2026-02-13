import { create } from 'zustand'

interface UIState {
  sidebarCollapsed: boolean
  activeRoute: string
  toggleSidebar: () => void
  setActiveRoute: (route: string) => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  activeRoute: '/',
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setActiveRoute: (route) => set({ activeRoute: route }),
}))
