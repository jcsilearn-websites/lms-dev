import type { ReactNode } from 'react';

// A table wider than a phone scrolls sideways; a scrollable area must be reachable by keyboard (axe: scrollable-region-focusable),
// so it is a focusable, NAMED region. The attributes are spread from one object on purpose: this is the single place that needs them.
export function ScrollRegion({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const region = { role: 'region', tabIndex: 0, 'aria-label': `${label} (scrolls sideways)` };
  return (
    <div {...region} className={`overflow-x-auto ${className}`}>
      {children}
    </div>
  );
}
