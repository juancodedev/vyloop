// @vitest-environment jsdom

/**
 * The message history, as a merchant reads it: who each notification went to,
 * what it said, whether it arrived and, when it did not, why.
 *
 * WhatsApp is hidden for now, so the page asks only for push deliveries.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/lib/api', () => ({ apiFetch: mocks.apiFetch }));

import MessagesPage from '../app/dashboard/communication/messages/page';

function row(overrides: Record<string, unknown>) {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000000',
    customerId: 'f6c4439b-980f-4bdb-a3a5-2e9260e2c640',
    customerName: 'Ana Rojas',
    direction: 'outbound',
    channel: 'push',
    status: 'sent',
    content: { title: 'Café al 2x1', body: 'Solo hoy en Providencia', reference_id: 'r:s' },
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.apiFetch.mockResolvedValue({
    data: [
      row({}),
      row({
        id: 'bbbbbbbb-0000-0000-0000-000000000000',
        customerName: 'Pedro Soto',
        status: 'failed',
        metadata: { error: 'The browser is no longer registered for push.' },
      }),
      row({
        id: 'cccccccc-0000-0000-0000-000000000000',
        customerName: null,
        status: 'failed',
        metadata: { error: 'push service returned 413' },
      }),
    ],
    meta: { total: 3, page: 1, per_page: 15 },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the message history', () => {
  it('asks for push deliveries only', async () => {
    render(<MessagesPage />);
    await screen.findByText('Ana Rojas');

    expect(String(mocks.apiFetch.mock.calls[0]![0])).toContain('channel=push');
  });

  it('names the customer and shows the message instead of ids', async () => {
    render(<MessagesPage />);

    expect(await screen.findByText('Ana Rojas')).toBeTruthy();
    expect(screen.getAllByText('Café al 2x1').length).toBe(3);
    expect(screen.queryByText(/f6c4439b/)).toBeNull();
    expect(screen.queryByText(/^ID:/)).toBeNull();
  });

  it('says a customer without a name is no longer available, not their id', async () => {
    render(<MessagesPage />);

    expect(await screen.findByText('Cliente no disponible')).toBeTruthy();
  });

  it('explains why each failed delivery failed, in Spanish', async () => {
    render(<MessagesPage />);
    await screen.findByText('Pedro Soto');

    expect(screen.getByText(/ya no acepta notificaciones/)).toBeTruthy();
    expect(screen.getByText(/rechazó el envío \(código 413\)/)).toBeTruthy();
  });

  it('offers no WhatsApp action or status', async () => {
    render(<MessagesPage />);
    await screen.findByText('Ana Rojas');

    expect(screen.queryByText(/WhatsApp/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /Enviar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leído' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recibido' })).toBeNull();
  });
});
