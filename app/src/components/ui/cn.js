// Tiny class-name joiner: drop falsy parts, join the rest. pendpost controls
// its own class strings, so no tailwind-merge dedup is needed.
export function cn(...parts) {
  return parts.filter(Boolean).join(' ');
}
