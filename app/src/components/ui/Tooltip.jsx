// Tooltip primitive (Radix) - the house replacement for native title=. Wrap the
// app once in <TooltipProvider>, then use <Tip label="...">child</Tip>.
import * as RT from '@radix-ui/react-tooltip';
import { cn } from './cn.js';

export function TooltipProvider({ children }) {
  return (
    <RT.Provider delayDuration={200} skipDelayDuration={400}>
      {children}
    </RT.Provider>
  );
}

// Wraps a single focusable child. With no label it renders the child untouched,
// so callers can pass an optional label without branching.
export function Tip({ label, side = 'top', align = 'center', children }) {
  if (!label) return children;
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-[70] max-w-[16rem] rounded-lg px-2.5 py-1.5 text-[11px] font-medium leading-snug shadow-xl',
            'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900',
          )}
        >
          {label}
          <RT.Arrow className="fill-zinc-900 dark:fill-zinc-100" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
