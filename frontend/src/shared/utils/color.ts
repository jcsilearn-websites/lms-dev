// WCAG 2.1 colour maths and the per-theme brand colour rule.

export type ThemeName = 'light' | 'dark';

/** The page background of each theme (must match the --background token in index.css). */
export const BACKGROUNDS: Record<ThemeName, string> = { light: '#ffffff', dark: '#0b1220' };

/** The built-in brand colour per theme: both pass AA on their background (see test/tokens.test.ts). */
export const DEFAULT_PRIMARY: Record<ThemeName, { primary: string; foreground: string }> = {
  light: { primary: '#2563eb', foreground: '#ffffff' },
  dark: { primary: '#60a5fa', foreground: '#0b1220' },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_TEXT = 4.5;

export interface ThemeColors {
  primary: string;
  foreground: string;
  /** true when the college colour failed AA on this theme and the default was used */
  fellBack: boolean;
}

/**
 * The brand colour is used as button background, link/text colour and focus ring. For each theme it
 * must (1) have AA text contrast (4.5:1) against that theme's background and (2) allow readable
 * text on top of it (white or near-black, whichever is better, also 4.5:1). If either fails, THAT
 * theme falls back to the default brand colour; the other theme can still use the college colour.
 */
export function brandColors(hex: string | null | undefined): Record<ThemeName, ThemeColors> {
  const out = {} as Record<ThemeName, ThemeColors>;
  for (const theme of ['light', 'dark'] as const) {
    const fallback = { ...DEFAULT_PRIMARY[theme], fellBack: true };
    if (!hex || !isHexColor(hex)) {
      out[theme] = { ...fallback, fellBack: false };
      continue;
    }
    const primary = hex.toLowerCase();
    const onWhite = contrastRatio(primary, '#ffffff');
    const onDark = contrastRatio(primary, '#0b1220');
    const foreground = onWhite >= onDark ? '#ffffff' : '#0b1220';
    const readable = Math.max(onWhite, onDark) >= AA_TEXT;
    out[theme] =
      readable && contrastRatio(primary, BACKGROUNDS[theme]) >= AA_TEXT
        ? { primary, foreground, fellBack: false }
        : fallback;
  }
  return out;
}
