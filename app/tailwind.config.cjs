/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Per-client accent (multi-client): App.jsx sets --accent / --accent-light
        // on documentElement from the active client's theme on every client
        // change and dark-mode toggle, with the shipped defaults as the fallback
        // so existing `brand` / `brand-light` class usages keep working unchanged.
        brand: { DEFAULT: 'var(--accent, #0f766e)', light: 'var(--accent-light, #5eead4)' },
      },
      fontFamily: {
        // DS-2 / NFR-LIC-02: one self-hosted family (Inter) for display + body,
        // matching the exported brand assets; system-ui is the offline fallback.
        display: ['Inter', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        blob: 'blob 20s ease-in-out infinite',
        'blob-slow': 'blob 28s ease-in-out infinite reverse',
        'slide-in': 'slide-in 260ms cubic-bezier(0.32, 0.72, 0, 1) both',
      },
      keyframes: {
        blob: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '33%': { transform: 'translate(50px, -70px) scale(1.08)' },
          '66%': { transform: 'translate(-40px, 40px) scale(0.94)' },
        },
        'slide-in': {
          from: { transform: 'translateX(48px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
