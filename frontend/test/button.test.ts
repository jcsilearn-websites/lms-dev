import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Button hover styles', () => {
  it('never use opacity (it lowered white-on-blue to 4.31:1, below WCAG AA, found by axe in the E2E run)', () => {
    const src = readFileSync('src/shared/ui/button.tsx', 'utf8');
    expect(src).not.toMatch(/hover:opacity/);
    expect(src).toMatch(/hover:bg-\[color-mix\(/);
  });

  it('does not animate opacity: axe sampled a button half-way between disabled and enabled (3.15:1) in CI', () => {
    const src = readFileSync('src/shared/ui/button.tsx', 'utf8');
    expect(src).not.toMatch(/transition-opacity|transition-all/);
  });
});
