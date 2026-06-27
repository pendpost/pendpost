// Popover primitive (Radix) - collision-aware floating surface used by the
// DateTimePicker, the Composer video picker, and the status filter. Headless +
// styled in house glass tokens (more opaque than the panel chrome for legibility).
import * as RP from '@radix-ui/react-popover';
import { cn } from './cn.js';

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverAnchor = RP.Anchor;
export const PopoverClose = RP.Close;

export function PopoverContent({ className, align = 'start', side = 'bottom', sideOffset = 6, children, ...props }) {
  return (
    <RP.Portal>
      <RP.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-[70] rounded-2xl bg-white/95 p-2 shadow-2xl ring-1 ring-zinc-900/10 backdrop-blur-xl outline-none dark:bg-zinc-900/95 dark:ring-white/10',
          className,
        )}
        {...props}
      >
        {children}
      </RP.Content>
    </RP.Portal>
  );
}
