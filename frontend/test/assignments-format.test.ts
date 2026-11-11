import { describe, expect, it } from 'vitest';
import { previewKind } from '../src/features/assignments/FilePreview';
import {
  bytes,
  duration,
  latePolicyText,
  points,
  remainingSeconds,
} from '../src/features/assignments/format';

describe('assignment text helpers', () => {
  it('duration reads naturally and never goes below zero', () => {
    expect(duration(0)).toBe('less than a minute');
    expect(duration(45)).toBe('less than a minute');
    expect(duration(61)).toBe('1 minute');
    expect(duration(3700)).toBe('1 hour 1 minute');
    expect(duration(93_784)).toBe('1 day 2 hours');
    expect(duration(2 * 86_400)).toBe('2 days');
    expect(duration(-5)).toBe('less than a minute');
  });

  it('points are singular and plural, and never show float noise', () => {
    expect(points(1)).toBe('1 point');
    expect(points(10)).toBe('10 points');
    expect(points(7.5)).toBe('7.5 points');
    expect(points(2.3333)).toBe('2.33 points');
  });

  it('the late policy says what it costs in points', () => {
    const base = {
      penaltyKind: 'per_day' as const,
      penaltyValue: 10,
      penaltyCap: 30,
      maxPoints: 50,
    };
    expect(latePolicyText({ ...base, latePolicy: 'none', lateCutoffAt: null })).toMatch(
      /not accepted/,
    );
    const per = latePolicyText({
      ...base,
      latePolicy: 'allowed',
      lateCutoffAt: '2026-12-31T10:00:00.000Z',
    });
    expect(per).toMatch(/10% of the maximum \(5 points\) for every day/);
    expect(per).toMatch(/never more than 30% \(15 points\)/);
    const flat = latePolicyText({
      ...base,
      penaltyKind: 'flat',
      latePolicy: 'allowed',
      lateCutoffAt: '2026-12-31T10:00:00.000Z',
    });
    expect(flat).toMatch(/once/);
  });

  it("the countdown follows the SERVER's clock, not the browser's", () => {
    const due = '2026-01-01T12:00:00.000Z';
    // the browser is 10 minutes behind the server: the server says 11:50, the browser's own clock says 11:40
    const browserNow = new Date('2026-01-01T11:40:00.000Z').getTime();
    const offset = new Date('2026-01-01T11:50:00.000Z').getTime() - browserNow;
    expect(remainingSeconds(due, offset, browserNow)).toBe(10 * 60);
    expect(remainingSeconds(due, 0, browserNow)).toBe(20 * 60);
    expect(remainingSeconds(due, offset, browserNow + 11 * 60_000)).toBe(-60);
  });

  it('file sizes', () => {
    expect(bytes(null)).toBe('');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(2048)).toBe('2 KB');
    expect(bytes(5 * 1048576)).toBe('5.0 MB');
  });

  it('only images, text and PDF are looked at in the browser; everything else is a download', () => {
    expect(previewKind({ name: 'a.png', contentType: 'image/png' })).toBe('image');
    expect(previewKind({ name: 'a.jpg', contentType: 'image/jpeg' })).toBe('image');
    expect(previewKind({ name: 'a.pdf', contentType: 'application/pdf' })).toBe('pdf');
    expect(previewKind({ name: 'a.txt', contentType: 'text/plain' })).toBe('text');
    expect(previewKind({ name: 'a.csv', contentType: 'text/csv' })).toBe('text');
    for (const t of [
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'text/html',
      'application/zip',
      'application/vnd.ms-excel',
    ])
      expect(previewKind({ name: 'x', contentType: t }), t).toBe('download');
  });
});
