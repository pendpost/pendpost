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
        // Mixed through color-mix with Tailwind's <alpha-value>, so the opacity forms
        // (`bg-brand/10`, `hover:ring-brand/40`, `dark:bg-brand-light/10`) generate CSS. A bare
        // var() carries no alpha channel, and Tailwind used to drop every one of those classes
        // silently (no rule at all). Without a modifier <alpha-value> is the utility's own
        // opacity variable (1 by default), so plain `bg-brand` is unchanged.
        brand: {
          DEFAULT: 'color-mix(in srgb, var(--accent, #0f766e) calc(<alpha-value> * 100%), transparent)',
          light: 'color-mix(in srgb, var(--accent-light, #5eead4) calc(<alpha-value> * 100%), transparent)',
        },
      },
      width: {
        // Draggable sidebar rail: App.jsx sets --sidebar-w on documentElement from
        // the persisted display preference, and SidebarResizer rewrites it live
        // during a drag. Consumed as `lg:w-sidebar`, with the shipped 15rem as the
        // fallback so the rail is correct before the boot effect runs.
        sidebar: 'var(--sidebar-w, 15rem)',
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
