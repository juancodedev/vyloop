/**
 * The sidebar as a merchant uses it.
 *
 * The till is the screen the counter opens all day, so it leads. Inicio,
 * Programa and Analytics showed the same numbers three times; they are one
 * "Resumen" now, and the two old addresses send there instead of breaking a
 * bookmark. Every screen a merchant manages is reachable from the sidebar,
 * not only from a card on another page.
 */

import { describe, expect, it, vi } from 'vitest';

import { NAV_SECTIONS, PRIMARY_ACTION, getPageTitle } from '../lib/navigation';

const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

const hrefs = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href));

describe('the sidebar', () => {
  it('leads with opening the till', () => {
    expect(PRIMARY_ACTION).toMatchObject({ label: 'Abrir caja', href: '/dashboard/loyalty/pos' });
  });

  it('reaches every screen a merchant manages, each once', () => {
    expect([...hrefs].sort()).toEqual(
      [
        '/dashboard',
        '/dashboard/customers',
        '/dashboard/loyalty/config',
        '/dashboard/loyalty/tiers',
        '/dashboard/loyalty/rewards',
        '/dashboard/loyalty/customers',
        '/dashboard/communication/campaigns',
        '/dashboard/communication/messages',
        '/dashboard/communication/workflows',
        '/dashboard/qr',
        '/dashboard/settings/venues',
        '/dashboard/settings',
      ].sort(),
    );
  });

  it('no longer lists the duplicate overview pages', () => {
    expect(hrefs).not.toContain('/dashboard/analytics');
    expect(hrefs).not.toContain('/dashboard/loyalty');
  });

  it('gives each item its own icon, so a collapsed sidebar can be told apart', () => {
    const icons = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.icon));
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('names the overview "Resumen"', () => {
    expect(getPageTitle('/dashboard')).toBe('Resumen');
  });
});

describe('the old overview addresses', () => {
  it.each([
    ['/dashboard/analytics', () => import('../app/dashboard/analytics/page')],
    ['/dashboard/loyalty', () => import('../app/dashboard/loyalty/page')],
  ])('%s sends to the summary', async (_path, load) => {
    redirect.mockClear();
    const page = (await load()).default as () => unknown;

    page();

    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });
});
