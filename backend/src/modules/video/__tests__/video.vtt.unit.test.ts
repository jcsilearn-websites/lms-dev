import { describe, expect, it } from 'vitest';
import { validateWebVtt } from '../video.vtt';

const cue = '00:00.000 --> 00:02.500\nHello\n';

describe('WebVTT validation', () => {
  it('accepts captions, normalises line ends and a BOM, and ends with a newline', () => {
    const r = validateWebVtt(`﻿WEBVTT\r\n\r\n${cue.replace(/\n/g, '\r\n')}`);
    expect(r).toEqual({ ok: true, text: `WEBVTT\n\n${cue}` });
    expect(validateWebVtt(`WEBVTT - a title\n\n${cue}`)).toMatchObject({ ok: true });
    expect(validateWebVtt(`WEBVTT\n\n01:02:03.000 --> 01:02:04.000 align:start\nHi`)).toMatchObject(
      { ok: true },
    );
    expect(
      validateWebVtt(`WEBVTT\n\nintro\n${cue}\n\n00:03.000 --> 00:04.000\n<b>bold</b> ü\n`),
    ).toMatchObject({ ok: true });
  });
  it('refuses a file that is not WebVTT', () => {
    for (const text of [
      'hello',
      `WEBVTTX\n\n${cue}`,
      ` WEBVTT\n\n${cue}`,
      '1\n00:00:01,000 --> 00:00:02,000\nSRT\n',
    ]) {
      expect(validateWebVtt(text), text).toMatchObject({ ok: false });
    }
  });
  it('refuses a file without cues, with control characters, or too large', () => {
    expect(validateWebVtt('WEBVTT\n\nNOTE nothing here\n')).toMatchObject({
      ok: false,
      message: expect.stringContaining('no cues'),
    });
    expect(validateWebVtt(`WEBVTT\n\n${cue}\u0000`)).toMatchObject({ ok: false });
    expect(validateWebVtt(`WEBVTT\n\n${cue}\u0007`)).toMatchObject({ ok: false });
    expect(validateWebVtt(`WEBVTT\n\n${cue}${'x'.repeat(262_144)}`)).toMatchObject({
      ok: false,
      message: expect.stringContaining('256 KB'),
    });
    // multi-byte text counts in BYTES
    expect(validateWebVtt(`WEBVTT\n\n${cue}${'é'.repeat(140_000)}`)).toMatchObject({ ok: false });
  });
  it('refuses an absurd number of cues', () => {
    const many = Array.from({ length: 20_001 }, (_, i) => `00:00.000 --> 00:01.000\nc${i}\n`).join(
      '\n',
    );
    expect(validateWebVtt(`WEBVTT\n\n${many}`)).toMatchObject({ ok: false });
  });
});
