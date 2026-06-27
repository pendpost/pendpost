// The pendpost brand mark, as a React component - the bracket gate + clearing
// chevron. Source geometry is brand/logo/mark-mono.svg (kept in sync); the app
// had no brand-mark component before this (only Lucide icons + the favicon), so
// this is the canonical mark for in-app brand moments (boot splash, the
// "all caught up" reward state).
//
// Brand rule (brand/guide/brand-guide.md): the mark carries the single teal
// "go / approved" signal. Strokes use currentColor, so callers set the teal via
// Tailwind text color (e.g. text-brand / text-brand-light, which resolve to
// var(--accent) per tailwind.config.cjs) and it follows per-client theming.
//
// animated: the living mark - breathe loop on the whole mark, the chevron
// clearing forward (a post passing the gate). Keyframes live in src/index.css
// (pp-breathe / pp-chevron-clear) and are disabled under prefers-reduced-motion.
export function GateMark({ size = 72, animated = false, className, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      className={className}
      style={animated ? { animation: 'pp-breathe 2.6s ease-in-out infinite', transformOrigin: 'center' } : undefined}
      {...rest}
    >
      <g fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M41 31 L31 31 L31 69 L41 69" />
        <path d="M59 31 L69 31 L69 69 L59 69" />
        <path
          d="M45 40 L55 50 L45 60"
          style={animated ? { strokeDasharray: 64, animation: 'pp-chevron-clear 2.6s ease-in-out infinite' } : undefined}
        />
      </g>
    </svg>
  );
}

export default GateMark;
