import { brandColors } from '../shared/utils/color';

// Theme = light / dark / follow the system. The preference is a per-viewer convenience kept in
// localStorage (which can be unavailable or throw: private windows, blocked storage), never required.

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'lms-theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // storage unavailable: the choice just lasts for this page view
  }
  applyThemePref(pref);
}

export function applyThemePref(pref: ThemePref = getThemePref()): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

const BRAND_VARS = ['--primary-l', '--primary-fg-l', '--primary-d', '--primary-fg-d'] as const;

/**
 * Applies the college colour as CSS variables, per theme, only where it passes WCAG AA on that
 * theme's background (see brandColors); otherwise the variable stays unset and the default brand
 * colour of that theme is used. Passing null removes the branding.
 */
export function applyBrandColor(hex: string | null | undefined): void {
  const style = document.documentElement.style;
  for (const v of BRAND_VARS) style.removeProperty(v);
  if (!hex) return;
  const colors = brandColors(hex);
  if (!colors.light.fellBack) {
    style.setProperty('--primary-l', colors.light.primary);
    style.setProperty('--primary-fg-l', colors.light.foreground);
  }
  if (!colors.dark.fellBack) {
    style.setProperty('--primary-d', colors.dark.primary);
    style.setProperty('--primary-fg-d', colors.dark.foreground);
  }
}
