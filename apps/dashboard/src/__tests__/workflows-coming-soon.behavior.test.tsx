// @vitest-environment jsdom

/**
 * Flujos is not built yet: the automation worker serves none of the
 * `/v1/automation/workflows` routes the old page called, so every visit ended
 * in a 404. Until it is (openspec/changes/workflow-builder), the sidebar shows
 * it as coming soon and the page says so instead of failing.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ logout: vi.fn() }) }));
vi.mock('@/lib/sidebar-context', () => ({
  useSidebar: () => ({
    collapsed: false,
    isMobile: false,
    mobileOpen: false,
    toggle: vi.fn(),
    closeMobile: vi.fn(),
  }),
}));
vi.mock('@/lib/api', () => ({ apiFetch: mocks.apiFetch }));

import WorkflowsPage from '../app/dashboard/communication/workflows/page';
import { Sidebar } from '../components/Sidebar';

afterEach(cleanup);

describe('Flujos while it is not built', () => {
  it('is listed in the sidebar as coming soon, not as a link', () => {
    render(<Sidebar />);

    const item = screen.getByText('Flujos').closest('[aria-disabled="true"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain('Próximamente');
    expect(screen.queryByRole('link', { name: /Flujos/ })).toBeNull();
  });

  it('keeps every other section a link', () => {
    render(<Sidebar />);

    expect(screen.getByRole('link', { name: 'Campañas' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mensajes' })).toBeTruthy();
  });

  it('opens on a coming-soon notice and calls no missing route', () => {
    render(<WorkflowsPage />);

    expect(screen.getByRole('heading', { name: 'Flujos' })).toBeTruthy();
    expect(screen.getByText('Próximamente')).toBeTruthy();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
