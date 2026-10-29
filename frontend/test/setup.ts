import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetToasts } from '../src/shared/ui/toast';
import { server } from './server';

// The default 1 s is tight when the machine is busy (the whole app renders in jsdom per test).
configure({ asyncUtilTimeout: 5000 });

// Node's fetch needs absolute URLs; the app calls /api/... relative to its own origin.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return nativeFetch(new URL(input, window.location.origin), init);
  }
  return nativeFetch(input, init);
}) as typeof fetch;

// jsdom has no <dialog> showModal/close: a minimal version is enough for the tests (open attribute).
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetToasts();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});
afterAll(() => server.close());
