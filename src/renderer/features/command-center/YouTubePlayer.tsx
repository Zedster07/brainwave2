/**
 * YouTubePlayer — Embedded YouTube video/playlist player for chat messages.
 *
 * Renders an iframe pointing to youtube.com/embed with optional playlist support.
 * Features:
 *   - Single video or full playlist playback
 *   - Collapsible player with minimize/expand
 *   - Picture-in-picture style floating player
 *   - Start-at-time support
 */

import { useState } from 'react'
import { Play, X, Minimize2, Maximize2, ExternalLink, ListVideo } from 'lucide-react'

export interface YouTubePlayerProps {
  videoId: string
  title?: string
  playlistId?: string
  startAt?: number
}

/**
 * Build the YouTube embed URL from props.
 */
function buildEmbedUrl(props: YouTubePlayerProps): string {
  const params = new URLSearchParams({
    autoplay: '1',
    rel: '0',
    modestbranding: '1',
    enablejsapi: '0',
  })

  if (props.startAt && props.startAt > 0) {
    params.set('start', String(Math.floor(props.startAt)))
  }

  // Playlist mode
  if (props.playlistId) {
    params.set('list', props.playlistId)
    if (props.videoId) {
      // Start playlist at specific video
      return `https://www.youtube.com/embed/${props.videoId}?${params.toString()}`
    }
    // Playlist without a specific start video — use videoseries
    return `https://www.youtube.com/embed/videoseries?${params.toString()}`
  }

  // Single video
  return `https://www.youtube.com/embed/${props.videoId}?${params.toString()}`
}

export function YouTubePlayer({ videoId, title, playlistId, startAt }: YouTubePlayerProps) {
  const [minimized, setMinimized] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) {
    return (
      <div className="my-2 flex items-center gap-2 text-gray-500 text-xs">
        <Play className="w-3 h-3" />
        <span>YouTube video dismissed</span>
        <button
          onClick={() => setDismissed(false)}
          className="text-accent hover:text-accent/80 underline"
        >
          Restore
        </button>
      </div>
    )
  }

  const embedUrl = buildEmbedUrl({ videoId, title, playlistId, startAt })
  const youtubeUrl = playlistId
    ? `https://www.youtube.com/playlist?list=${playlistId}${videoId ? `&v=${videoId}` : ''}`
    : `https://www.youtube.com/watch?v=${videoId}${startAt ? `&t=${startAt}` : ''}`

  return (
    <div className="my-3 rounded-xl border border-red-500/15 bg-red-500/[0.03] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-red-500/10">
        <div className="flex items-center gap-2 min-w-0">
          {playlistId ? (
            <ListVideo className="w-4 h-4 text-red-400/70 flex-shrink-0" />
          ) : (
            <Play className="w-4 h-4 text-red-400/70 flex-shrink-0" />
          )}
          <span className="text-xs text-red-400/80 font-medium truncate">
            {title ?? (playlistId ? 'YouTube Playlist' : 'YouTube Video')}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <a
            href={youtubeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded hover:bg-white/5 text-gray-500 hover:text-gray-300 transition-colors"
            title="Open in YouTube"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => setMinimized((m) => !m)}
            className="p-1 rounded hover:bg-white/5 text-gray-500 hover:text-gray-300 transition-colors"
            title={minimized ? 'Expand' : 'Minimize'}
          >
            {minimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="p-1 rounded hover:bg-white/5 text-gray-500 hover:text-gray-300 transition-colors"
            title="Close player"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Player */}
      {!minimized && (
        <div className="relative w-full" style={{ paddingBottom: '56.25%' /* 16:9 */ }}>
          <iframe
            src={embedUrl}
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            title={title ?? 'YouTube video player'}
          />
        </div>
      )}

      {/* Minimized indicator */}
      {minimized && (
        <button
          onClick={() => setMinimized(false)}
          className="w-full px-3 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-white/[0.02]
                     transition-colors flex items-center gap-2"
        >
          <Play className="w-3 h-3 text-red-400/50" />
          <span>Click to expand player</span>
        </button>
      )}
    </div>
  )
}
