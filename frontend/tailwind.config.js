/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f5f7ff',
          100: '#ebeefe',
          200: '#d4dafe',
          300: '#b3bcfd',
          400: '#8a96fb',
          500: '#6671f8',
          600: '#4f4af0',
          700: '#4138d9',
          800: '#3730b0',
          900: '#312d8c',
          950: '#1f1d56',
        },
        accent: {
          50: '#fff5f7',
          100: '#ffe7eb',
          200: '#fed1d9',
          300: '#fda9b7',
          400: '#fb768e',
          500: '#f6496b',
          600: '#e5224b',
          700: '#c1183c',
          800: '#9e1638',
          900: '#831735',
          950: '#480917',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'display-xl': ['clamp(3rem, 8vw, 6rem)', { lineHeight: '1.1', letterSpacing: '-0.03em' }],
        'display-lg': ['clamp(2.5rem, 6vw, 4.5rem)', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        'display-md': ['clamp(2rem, 4vw, 3.5rem)', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
        'display-sm': ['clamp(1.5rem, 3vw, 2.5rem)', { lineHeight: '1.25' }],
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: 0, transform: 'translateY(8px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        'fade-in-up': {
          '0%': { opacity: 0, transform: 'translateY(20px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        'slide-up': {
          '0%': { opacity: 0, transform: 'translateY(20px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        'slide-down': {
          '0%': { opacity: 0, transform: 'translateY(-20px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: 0, transform: 'translateX(30px)' },
          '100%': { opacity: 1, transform: 'translateX(0)' },
        },
        'scale-in': {
          '0%': { opacity: 0, transform: 'scale(0.95)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0) rotate(0deg)' },
          '25%': { transform: 'translateY(-10px) rotate(2deg)' },
          '50%': { transform: 'translateY(5px) rotate(-1deg)' },
          '75%': { transform: 'translateY(-5px) rotate(1deg)' },
        },
        'float-slow': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '20%': { transform: 'translate(30px, -20px) scale(1.05)' },
          '40%': { transform: 'translate(-20px, 30px) scale(0.95)' },
          '60%': { transform: 'translate(20px, 20px) scale(1.02)' },
          '80%': { transform: 'translate(-30px, -20px) scale(0.98)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.7)', opacity: 0.6 },
          '100%': { transform: 'scale(1.3)', opacity: 0 },
        },
        'rotate-slow': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        'bounce-subtle': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        'wiggle': {
          '0%, 100%': { transform: 'rotate(-3deg)' },
          '50%': { transform: 'rotate(3deg)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.5s ease-out',
        'fade-in-up': 'fade-in-up 0.6s ease-out',
        'slide-up': 'slide-up 0.5s ease-out',
        'slide-down': 'slide-down 0.5s ease-out',
        'slide-in-right': 'slide-in-right 0.5s ease-out',
        'scale-in': 'scale-in 0.4s ease-out',
        shimmer: 'shimmer 2s linear infinite',
        float: 'float 6s ease-in-out infinite',
        'float-slow': 'float-slow 20s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 2s ease-out infinite',
        'rotate-slow': 'rotate-slow 20s linear infinite',
        'bounce-subtle': 'bounce-subtle 2s ease-in-out infinite',
        'wiggle': 'wiggle 1s ease-in-out infinite',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'hero-gradient': 'radial-gradient(ellipse at 50% 0%, rgba(102, 113, 248, 0.1) 0%, transparent 60%), radial-gradient(ellipse at 80% 100%, rgba(246, 73, 107, 0.08) 0%, transparent 50%)',
        'mesh-gradient': 'linear-gradient(135deg, #6671f8 0%, #8b5cf6 50%, #f6496b 100%)',
      },
      boxShadow: {
        'glow': '0 0 40px -10px rgba(102, 113, 248, 0.3)',
        'glow-accent': '0 0 40px -10px rgba(246, 73, 107, 0.3)',
        'glow-lg': '0 0 80px -20px rgba(102, 113, 248, 0.4)',
        'glass': '0 8px 32px -8px rgba(15, 23, 42, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.2)',
        'glass-lg': '0 20px 64px -12px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(255, 255, 255, 0.15)',
        'inner-glow': 'inset 0 0 40px -10px rgba(102, 113, 248, 0.1)',
      },
      backdropBlur: {
        'xs': '2px',
        '4xl': '72px',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        'bounce': 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
      },
      transitionDuration: {
        '400': '400ms',
        '600': '600ms',
        '800': '800ms',
      },
    },
  },
  plugins: [],
};