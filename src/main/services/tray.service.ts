import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'

let tray: Tray | null = null

/**
 * System Tray — keeps Brainwave running in the background.
 * When the user closes the window, the app minimizes to tray instead of quitting.
 */
export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  // Create a simple 16x16 tray icon (will be replaced with a real icon later)
  const iconPath = join(__dirname, '../../resources/icon.png')
  let icon: Electron.NativeImage

  try {
    icon = nativeImage.createFromPath(iconPath)
  } catch {
    // Fallback: create a tiny colored icon programmatically
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon.isEmpty() ? createFallbackIcon() : icon)
  tray.setToolTip('Brainwave 2 — Running in background')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Brainwave',
      click: () => {
        const win = getMainWindow()
        if (win) {
          win.show()
          win.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Scheduler Active',
      type: 'checkbox',
      checked: true,
      click: (menuItem) => {
        // TODO: Wire to scheduler.pause() / scheduler.resume()
        console.log('[Tray] Scheduler', menuItem.checked ? 'resumed' : 'paused')
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Brainwave',
      click: () => {
        // Force quit — bypass the close-to-tray behavior
        app.isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  // Click tray icon → show window
  tray.on('click', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isVisible()) {
        win.focus()
      } else {
        win.show()
      }
    }
  })

  return tray
}

/** Create a small fallback icon when no icon file exists */
function createFallbackIcon(): Electron.NativeImage {
  // 16x16 purple square as a placeholder
  const size = 16
  const canvas = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = 99      // R
    canvas[i * 4 + 1] = 102 // G
    canvas[i * 4 + 2] = 241 // B (accent color #6366F1)
    canvas[i * 4 + 3] = 255 // A
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size })
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

// Extend app type to track quitting state
declare module 'electron' {
  interface App {
    isQuitting?: boolean
  }
}
