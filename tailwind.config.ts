import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // Base palette — mission-control dark theme
        primary: {
          DEFAULT: '#0A0B0F',
          50: '#141620',
          100: '#0E1017',
          200: '#08090D',
        },
        surface: {
          DEFAULT: '#0E1017',
          light: '#141620',
          dark: '#08090D',
        },
        accent: {
          DEFAULT: '#6366F1', // Indigo
          secondary: '#8B5CF6', // Purple
          glow: '#818CF8', // Light indigo glow
        },
        // Agent identity colors
        agent: {
          orchestrator: '#F59E0B',
          planner: '#06B6D4',
          researcher: '#3B82F6',
          coder: '#10B981',
          writer: '#A855F7',
          analyst: '#14B8A6',
          critic: '#EF4444',
          reviewer: '#F97316',
          reflection: '#EC4899',
          executor: '#6366F1',
        },
        // Status
        status: {
          success: '#10B981',
          warning: '#F59E0B',
          error: '#EF4444',
          info: '#3B82F6',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      backdropBlur: {
        glass: '12px',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'slide-in': 'slide-in 0.2s ease-out',
        'fade-in': 'fade-in 0.15s ease-out',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'slide-in': {
          from: { transform: 'translateX(-8px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}

export default config
