import { render } from '@testing-library/react';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { QrCode } from '../src/features/mfa/QrCode';

// THE QR CODE IS DECODED, not trusted (docs/adr/0026-mfa.md): the SVG the component renders is rasterised pixel by pixel and
// read by an independent decoder (jsqr, a development dependency only), and what it reads must be exactly the otpauth link.

const SCALE = 4;

/** The rendered SVG as RGBA pixels. Only what the component emits is understood: anything else fails the test. */
function rasterise(svg: SVGSVGElement) {
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number) as number[];
  expect(w).toBe(h);
  const size = (w as number) * SCALE;
  const pixels = new Uint8ClampedArray(size * size * 4);
  const background = svg.querySelector('rect');
  expect(background?.getAttribute('fill')).toBe('#ffffff');
  pixels.fill(255);
  const path = svg.querySelector('path');
  expect(path?.getAttribute('fill')).toBe('#000000');
  const d = path?.getAttribute('d') ?? '';
  expect(d).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const at = ((Number(y) * SCALE + dy) * size + Number(x) * SCALE + dx) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
  }
  return { pixels, size };
}

const link = (secret: string, account: string) =>
  `otpauth://totp/JCS%20iLearn:${encodeURIComponent(account)}?secret=${secret}&issuer=JCS%20iLearn&algorithm=SHA1&digits=6&period=30`;

const LINKS: [string, string][] = [
  ['a plain address', link('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'admin@alpha.test')],
  ['all the base32 letters', link('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 'a.b+c@college.example.in')],
  ['a repetitive secret', link('A'.repeat(32), 'x@y.in')],
  [
    'a long address',
    link('NB2W45DFOIZA42LSNFZCA5DIMUQGQ3DM', `${'very.long.name.'.repeat(8)}@department.example`),
  ],
  ['an escaped address', link('MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U', "o'brien & co@émigré.test")],
];

describe('the authenticator QR code', () => {
  it.each(LINKS)('decodes back to the otpauth link: %s', (_name, text) => {
    const { container, unmount } = render(<QrCode text={text} label="QR code" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    const { pixels, size } = rasterise(svg);
    expect(jsQR(pixels, size, size)?.data).toBe(text);
    unmount();
  });

  it('has no style attribute and no <style>: the strict CSP stays as it is', () => {
    const { container } = render(<QrCode text={LINKS[0]?.[1] as string} label="QR code" />);
    expect(container.querySelector('[style], style')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('QR code');
  });
});
