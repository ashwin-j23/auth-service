import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#EEF0FD',
          100: '#DCE0FB',
          200: '#B8C1F7',
          300: '#95A3F3',
          400: '#7184EE',
          500: '#3B4FE0',
          600: '#2F3EB4',
          700: '#232E87',
          800: '#181F5B',
          900: '#0C0F2E',
        },
        success: {
          50: '#ECFDF5',
          500: '#059669',
          600: '#047857',
        },
        warning: {
          50: '#FFFBEB',
          500: '#D97706',
          600: '#B45309',
        },
        danger: {
          50: '#FEF2F2',
          500: '#DC2626',
          600: '#B91C1C',
        },
        accent: {
          200: '#DDD6FE',
          300: '#C4B5FD',
          400: '#A78BFA',
          500: '#8B5CF6',
          600: '#7C3AED',
        },
      },
      fontFamily: {
        sans: [
          'Inter var',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        card: '8px',
        input: '6px',
        btn: '4px',
      },
      boxShadow: {
        subtle: '0 1px 3px rgba(15, 23, 42, 0.08)',
        elevated: '0 4px 12px rgba(15, 23, 42, 0.12)',
        'subtle-dark': '0 1px 3px rgba(0, 0, 0, 0.4)',
        'elevated-dark': '0 4px 16px rgba(0, 0, 0, 0.5)',
      },
      spacing: {
        4.5: '1.125rem',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        float: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '50%': { transform: 'translate(0, -14px)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.5', transform: 'scale(1)' },
          '50%': { opacity: '0.8', transform: 'scale(1.08)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'fade-in-up': 'fade-in-up 250ms ease-out',
        'scale-in': 'scale-in 180ms ease-out',
        shimmer: 'shimmer 1.8s linear infinite',
        float: 'float 6s ease-in-out infinite',
        'float-slow': 'float 9s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
