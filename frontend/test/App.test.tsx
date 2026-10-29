import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { Providers } from '../src/app/providers';

function renderApp() {
  render(
    <Providers client={new QueryClient()}>
      <App />
    </Providers>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the API health result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    );
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId('health-up')).toHaveLength(2));
    expect(screen.getAllByText('ok')).toHaveLength(2);
  });

  it('shows an error when the API reports not ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/health/ready')
          ? new Response(JSON.stringify({ error: { code: 'not_ready' } }), { status: 503 })
          : new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      ),
    );
    renderApp();
    expect(await screen.findByText('error (503)')).toBeDefined();
  });

  it('shows unreachable when the API cannot be contacted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    renderApp();
    await waitFor(() => expect(screen.getAllByText('unreachable')).toHaveLength(2));
  });
});
