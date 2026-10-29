import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUNDS,
  brandColors,
  contrastRatio,
  DEFAULT_PRIMARY,
  isHexColor,
} from '../src/shared/utils/color';

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1); // the classic AA grey
  });

  it('validates hex colours strictly', () => {
    expect(isHexColor('#12abEF')).toBe(true);
    for (const bad of ['red', '#123', '#12345g', 'rgb(0,0,0)', '#1234567', '']) {
      expect(isHexColor(bad)).toBe(false);
    }
  });
});

describe('brand colour, per theme (WCAG AA 4.5:1 against that theme background)', () => {
  it('a mid blue is used where it is readable and replaced where it is not', () => {
    const c = brandColors('#2563eb');
    expect(c.light).toMatchObject({ primary: '#2563eb', fellBack: false });
    // #2563eb on the near-black dark background is below 4.5: the dark theme falls back
    expect(contrastRatio('#2563eb', BACKGROUNDS.dark)).toBeLessThan(4.5);
    expect(c.dark).toMatchObject({ primary: DEFAULT_PRIMARY.dark.primary, fellBack: true });
  });

  it('a very light colour is refused on the light theme but fine on the dark one', () => {
    const c = brandColors('#fde68a');
    expect(c.light.fellBack).toBe(true);
    expect(c.light.primary).toBe(DEFAULT_PRIMARY.light.primary);
    expect(c.dark).toMatchObject({ primary: '#fde68a', fellBack: false });
  });

  it('a very dark colour is refused on the dark theme but fine on the light one', () => {
    const c = brandColors('#1e3a8a');
    expect(c.dark.fellBack).toBe(true);
    expect(c.light).toMatchObject({ primary: '#1e3a8a', fellBack: false });
  });

  it('every colour that ends up applied really passes AA, with readable text on top', () => {
    for (const hex of [
      '#2563eb',
      '#fde68a',
      '#1e3a8a',
      '#16a34a',
      '#dc2626',
      '#7c3aed',
      '#000000',
      '#ffffff',
      '#808080',
    ]) {
      const colors = brandColors(hex);
      for (const theme of ['light', 'dark'] as const) {
        const { primary, foreground } = colors[theme];
        expect(
          contrastRatio(primary, BACKGROUNDS[theme]),
          `${hex} ${theme} vs background`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(primary, foreground),
          `${hex} ${theme} text on it`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('no colour set means the defaults, without reporting a fallback', () => {
    const c = brandColors(null);
    expect(c.light).toMatchObject({ ...DEFAULT_PRIMARY.light, fellBack: false });
    expect(c.dark).toMatchObject({ ...DEFAULT_PRIMARY.dark, fellBack: false });
  });
});

describe('design tokens (src/index.css)', () => {
  const css = readFileSync('src/index.css', 'utf8'); // vitest runs in the package folder;
  const block = (selector: string) => {
    const start = css.indexOf(selector);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    const vars: Record<string, string> = {};
    for (const m of body.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
      vars[m[1] as string] = (m[2] as string).trim();
    }
    return vars;
  };
  const light = block(':root {');
  const dark = block(':root[data-theme="dark"]');
  // "#2563eb" or "var(--primary-l, #2563eb)" -> the default colour
  const hexOf = (v: string) =>
    /^#[0-9a-f]{6}$/i.test(v) ? v : /,\s*(#[0-9a-f]{6})\)/i.exec(v)?.[1];

  it('the backgrounds match the ones the colour logic assumes', () => {
    expect(light.background).toBe(BACKGROUNDS.light);
    expect(dark.background).toBe(BACKGROUNDS.dark);
  });

  for (const [name, t] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`${name}: text, muted text, status colours and primary pass AA on the page`, () => {
      const bg = t.background as string;
      for (const token of [
        'foreground',
        'muted-foreground',
        'danger',
        'success',
        'warning',
        'primary',
      ]) {
        const c = hexOf(t[token] as string);
        expect(c, `${name} --${token}`).toBeTruthy();
        expect(contrastRatio(c as string, bg), `${name} --${token}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrastRatio(hexOf(t['muted-foreground'] as string) as string, t.muted as string),
      ).toBeGreaterThanOrEqual(4.5);
      // the border of a form control must be visible (WCAG 1.4.11 non-text contrast, 3:1)
      expect(contrastRatio(t['input-border'] as string, bg)).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(
          hexOf(t['primary-foreground'] as string) as string,
          hexOf(t.primary as string) as string,
        ),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
