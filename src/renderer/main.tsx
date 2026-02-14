import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles/globals.css'

// Fade out and remove the splash screen once React is painted
function dismissSplash(): void {
  const splash = document.getElementById('splash')
  if (!splash) return
  splash.style.opacity = '0'
  splash.style.visibility = 'hidden'
  setTimeout(() => splash.remove(), 400)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
)

// Dismiss after first paint so the UI is visible underneath
requestAnimationFrame(() => requestAnimationFrame(dismissSplash))
