import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { ChevronDown, Search, RotateCcw, X } from 'lucide-react'

interface ModelOption {
  id: string
  name: string
}

interface ModelSelectorProps {
  /** Currently selected model ID */
  value: string
  /** The preset default model ID for this agent/mode */
  presetDefault?: string
  /** Called when user selects a new model */
  onChange: (modelId: string) => void
  /** Called when user resets to preset default */
  onReset?: () => void
  /** Whether the model has been overridden from preset */
  isOverridden?: boolean
  /** Available models to select from */
  models: ModelOption[]
  /** Whether the models are still loading */
  loading?: boolean
}

export function ModelSelector({
  value,
  presetDefault,
  onChange,
  onReset,
  isOverridden,
  models,
  loading,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setSearch('')
      }
    }
    if (isOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // Focus search input when opening
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Filter models based on search
  const filtered = useMemo(() => {
    if (!search.trim()) return models.slice(0, 80) // Show first 80 when no search
    const q = search.toLowerCase()
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    ).slice(0, 80)
  }, [models, search])

  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId)
    setIsOpen(false)
    setSearch('')
  }, [onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false)
      setSearch('')
    }
  }, [])

  // Get display name for current value
  const currentModel = models.find((m) => m.id === value)
  const displayValue = value.split('/').pop() || value // Show just model name part

  return (
    <div ref={containerRef} className="relative flex items-center gap-1 min-w-0">
      {/* Model display / trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          flex items-center gap-1 min-w-0 px-2 py-1 rounded text-[11px] font-mono transition-all truncate
          ${isOverridden
            ? 'bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20'
            : 'bg-white/[0.05] border border-white/[0.08] text-gray-400 hover:border-white/[0.15] hover:text-gray-300'
          }
        `}
        title={currentModel ? `${currentModel.name}\n${currentModel.id}` : value}
      >
        <span className="truncate">{displayValue}</span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-50" />
      </button>

      {/* Reset button (only show when overridden) */}
      {isOverridden && onReset && (
        <button
          onClick={(e) => { e.stopPropagation(); onReset() }}
          className="p-0.5 rounded text-gray-500 hover:text-amber-400 hover:bg-amber-400/10 transition-colors"
          title={`Reset to preset default: ${presetDefault}`}
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      )}

      {/* Dropdown */}
      {isOpen && (
        <div
          className="absolute top-full left-0 mt-1 w-80 bg-[#1a1a2e] border border-white/[0.1] rounded-lg shadow-2xl z-50 overflow-hidden"
          onKeyDown={handleKeyDown}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06]">
            <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="flex-1 bg-transparent text-sm text-white placeholder:text-gray-600 outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-gray-500 hover:text-gray-300">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Model list */}
          <div ref={listRef} className="max-h-64 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-6 text-center text-xs text-gray-500">Loading models...</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-gray-500">No models found</div>
            ) : (
              filtered.map((model) => {
                const isSelected = model.id === value
                const isDefault = model.id === presetDefault
                return (
                  <button
                    key={model.id}
                    onClick={() => handleSelect(model.id)}
                    className={`
                      w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors
                      ${isSelected
                        ? 'bg-accent/10 border-l-2 border-accent'
                        : 'hover:bg-white/[0.04] border-l-2 border-transparent'
                      }
                    `}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] font-mono truncate ${isSelected ? 'text-accent' : 'text-gray-300'}`}>
                        {model.id}
                      </span>
                      {isDefault && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-white/[0.06] text-gray-500 shrink-0">
                          preset
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-gray-500 truncate">{model.name}</span>
                  </button>
                )
              })
            )}
          </div>

          {/* Footer showing count */}
          <div className="px-3 py-1.5 border-t border-white/[0.06] text-[10px] text-gray-600">
            {filtered.length} model{filtered.length !== 1 ? 's' : ''}
            {search && ` matching "${search}"`}
          </div>
        </div>
      )}
    </div>
  )
}
