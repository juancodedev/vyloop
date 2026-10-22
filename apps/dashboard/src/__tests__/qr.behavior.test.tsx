// @vitest-environment jsdom

/**
 * The QR page, rendered.
 *
 * ## Why this suite exists rather than a source guard
 *
 * The bug was a hardcoded `?biz=cafe-central` on a page mounted in the sidebar.
 * Every merchant who opened the dashboard scanned a QR pointing at one seeded
 * business's registration form, and a source guard on *that string* would only
 * have caught the same literal a second time.
 *
 * Two properties of the fix are not visible in the source at all:
 *
 *   1. **The page shows no QR until it knows the slug.** A QR whose destination is
 *      a constant can be rendered on first paint. A QR built from a fetched slug
 *      cannot, so the page has to have a state where it renders nothing — and the
 *      only way to know it does is to render it and look.
 *   2. **The QR never changes destination.** If the page paints a QR before the
 *      fetch resolves and repaints with the right one after, the intermediate QR
 *      is scannable and points somewhere real. That is the dangerous version of
 *      this bug and it is invisible to every assertion about final output.
 *
 * ## The renderer is mocked, on purpose
 *
 * `qrcode.react` is replaced with a component that writes its `value` into a
 * `data-qr-value` attribute. Two reasons:
 *
 *   - jsdom has no 2d context, so `qrcode.react` returns early and draws nothing.
 *     Asserting on pixels would be asserting on nothing.
 *   - The property under test is *which string the QR encodes*, not whether the
 *     encoder can rasterise it. Reading the value off the element tests the page's
 *     decision rather than a third-party library's rendering, and it makes the
 *     "does it change between renders" assertion exact instead of approximate.
 *
 * `apiFetch` is mocked for the same reason: the states under test are the ones the
 * page reaches *because* it is asking the API for an identity it cannot otherwise
 * know, and a real fetch would put a socket between the test and the state it is
 * trying to observe.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode.react', () => ({
  QRCodeCanvas: (props: { value: string }) => (
    <canvas data-testid="qr" data-qr-value={props.value} />
  ),
}));

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
}));

import QRCodePage from '../app/dashboard/qr/page';
import { apiFetch } from '../lib/api';


/** What `GET /v1/wallet/program` answers with, for one merchant. */
function programResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      tenantId: '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1',
      classId: '3388.tenant-a',
      reviewStatus: 'approved',
      storedDemoMode: false,
      demoMode: false,
      demoModeCeiling: false,
      businessName: 'Panadería del Barrio',
      businessSlug: 'panaderia-del-barrio',
      ...overrides,
    },
  };
}

const qr = () => screen.queryByTestId('qr');
const qrValue = () => qr()?.getAttribute('data-qr-value') ?? null;

/** The whole rendered text, for asserting an explanation is present. */
const text = () => document.body.textContent ?? '';

/**
 * Every `download` value the page asked for, since the last reset.
 *
 * `HTMLAnchorElement.prototype.click` is intercepted rather than mocked, because
 * the attribute is assigned immediately before it and there is no other seam to
 * read it from. The click is swallowed so jsdom does not attempt a navigation.
 *
 * Patched once for the file and cleared per test, rather than patched inside a
 * helper: an earlier version restored the prototype on a microtask, which ran long
 * before the test clicked anything and made every download assertion pass vacuously
 * against an empty list.
 */
let downloads: Array<string | null> = [];
const nativeAnchorClick = HTMLAnchorElement.prototype.click;

beforeAll(() => {
  HTMLAnchorElement.prototype.click = function recorded(this: HTMLAnchorElement) {
    if (this.download) downloads.push(this.download);
  };
});

afterAll(() => {
  HTMLAnchorElement.prototype.click = nativeAnchorClick;
});

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  downloads = [];
});

describe('the QR points at this merchant, not a constant', () => {
  it('encodes a URL carrying the slug the API reported', async () => {
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    expect(qrValue()).toBe(
      'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=panaderia-del-barrio',
    );
  });

  it('never encodes a slug belonging to a business other than this one', async () => {
    // The original failure, stated as the property that would have caught it. Not
    // a word-ban: this asserts the destination is derived from the response, so it
    // holds for a slug nobody has written down yet.
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    const value = qrValue() ?? '';
    expect(value).toContain('panaderia-del-barrio');
    expect(value).not.toContain('cafe-central');
    expect(value).not.toContain('demo-shop');
    expect(value).not.toContain('Café');
  });

  it('follows the merchant when the API answers about a different one', async () => {
    // Two merchants, one page, one module. If anything were cached or defaulted at
    // module scope the second render would still show the first merchant's slug —
    // which is the bug's own mechanism, module-level state outliving a navigation.
    vi.mocked(apiFetch).mockResolvedValue(programResponse());
    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    vi.mocked(apiFetch).mockResolvedValue(
      programResponse({ businessName: 'Ferretería Sur', businessSlug: 'ferreteria-sur' }),
    );
    render(<QRCodePage />);
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('[data-qr-value]')).map((node) =>
          node.getAttribute('data-qr-value'),
        ),
      ).toContain(
        'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=ferreteria-sur',
      ),
    );

    const values = Array.from(document.querySelectorAll('[data-qr-value]')).map((node) =>
      node.getAttribute('data-qr-value'),
    );
    expect(values).toContain(
      'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=panaderia-del-barrio',
    );
    expect(values).toContain(
      'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=ferreteria-sur',
    );
  });

  it('shows this merchant\'s name, not a constant one', async () => {
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    render(<QRCodePage />);
    await waitFor(() => expect(screen.getByText('Panadería del Barrio')).toBeTruthy());

    expect(text()).not.toContain('Café Central');
  });
});

describe('the three states the page could not have before', () => {
  /**
   * There was no loading state because the data was a constant: the QR was on
   * screen at first paint, pointing at the wrong business. With the slug arriving
   * from the API there is a window where the page does not know where its QR
   * points, and it must show nothing rather than something provisional.
   */
  it('renders no QR while it is still loading', () => {
    vi.mocked(apiFetch).mockReturnValue(new Promise(() => {}));

    render(<QRCodePage />);

    expect(qr()).toBeNull();
    expect(text()).not.toContain('register?biz=');
  });

  it('renders no QR and says why when the request fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('No se pudo leer el programa.'));

    render(<QRCodePage />);
    await waitFor(() => expect(text()).toMatch(/no se pudo leer/i));

    expect(qr()).toBeNull();
    expect(text()).not.toContain('register?biz=');
  });

  /**
   * The state the endpoint made possible. `tenants.slug` is `notNull` with no check
   * constraint, so a blank slug is reachable and provisioning already refuses one
   * for a pass's `homepageUri`.
   *
   * There is no correct URL here, so the page must not build one. What it must not
   * do is show a QR for another business or a QR reading `?biz=` — both are
   * scannable, and the second is the worst of the two because it looks like it
   * names a business.
   */
  it('renders no QR, and explains itself, when the business has no usable slug', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      programResponse({ businessName: 'Panadería del Barrio', businessSlug: '' }),
    );

    render(<QRCodePage />);
    await waitFor(() => expect(text()).toMatch(/slug/i));

    expect(qr()).toBeNull();
    expect(text()).not.toContain('?biz=');
    expect(text()).not.toContain('cafe-central');
  });

  it('renders no QR when the API reports no slug field at all', async () => {
    // A response from a worker that predates this change. Treating a missing field
    // as an empty one is what keeps the no-slug state reachable instead of
    // becoming a `TypeError` — and a thrown render is a blank page with no
    // explanation, which is the same failure by another route.
    vi.mocked(apiFetch).mockResolvedValue({
      data: {
        tenantId: '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1',
        classId: '3388.tenant-a',
        reviewStatus: 'approved',
        storedDemoMode: false,
        demoMode: false,
        demoModeCeiling: false,
      },
    });

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).toBeNull());

    expect(qr()).toBeNull();
    expect(text()).not.toContain('?biz=');
  });

  it('offers nothing to copy or download while there is no slug', async () => {
    // Both buttons are ways to get the URL out of the page. With no URL they have
    // nothing to give, and a "Copiar enlace" that copies `?biz=` is the same lie
    // as the QR.
    vi.mocked(apiFetch).mockResolvedValue(programResponse({ businessSlug: '' }));

    render(<QRCodePage />);
    await waitFor(() => expect(text()).toMatch(/slug/i));

    expect(screen.queryByRole('button', { name: /copiar enlace/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /descargar qr/i })).toBeNull();
  });
});

describe('the QR does not change destination once the slug is known', () => {
  /**
   * The dangerous version of the bug.
   *
   * If the page painted a QR before the fetch resolved — from a stale value, a
   * cached one, or a provisional default — and repainted with the correct one
   * after, then a QR was on screen the whole time. A customer scanning in that
   * window would have been registered against whichever business that first QR
   * named, and the operator would see the right QR by the time they noticed.
   *
   * So the assertion is not "the QR ends up right". It is "there was exactly one
   * distinct QR value, ever" — sampled after the fetch resolves *and* after a
   * forced re-render, with the values collected rather than the final one read.
   */
  it('encodes the same value on every render, with no provisional QR in between', async () => {
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    const { rerender } = render(<QRCodePage />);
    // Sample immediately: if a provisional QR existed, this is where it would be.
    const beforeSettled = qrValue();

    await waitFor(() => expect(qr()).not.toBeNull());
    const afterSettled = qrValue();

    rerender(<QRCodePage />);
    const afterRerender = qrValue();

    expect(afterSettled).toBe(
      'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=panaderia-del-barrio',
    );
    // Either nothing yet, or already correct. A third value would be the bug.
    expect([null, afterSettled]).toContain(beforeSettled);
    expect(afterRerender).toBe(afterSettled);
  });

  it('does not re-encode the QR when unrelated state changes, such as copying', async () => {
    // The copy button toggles a "copiado" label. If the QR value were recomputed
    // from anything mutable, that toggle would be a chance to change it.
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());
    const first = qrValue();

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const button = screen.getByRole('button', { name: /copiar enlace/i });
    await act(async () => {
      button.click();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(first);
    expect(qrValue()).toBe(first);
  });
});

describe('the download is named after this merchant', () => {
  /**
   * The filename used to be built from the constant `Café Central`, so every
   * merchant downloaded a file called `vyloop-qr-café-central.png` — another
   * business's name, in a form no keyboard reproduces, since the accent survives
   * a `.toLowerCase()` but not a filename the merchant can retype or print.
   */
  it('names the file from the business, with accents folded', async () => {
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    await act(async () => {
      screen.getByRole('button', { name: /descargar qr/i }).click();
    });

    expect(downloads).toContain('vyloop-qr-panaderia-del-barrio.png');
    expect(downloads).not.toContain('vyloop-qr-café-central.png');
    expect(downloads.some((name) => name?.includes('café-central'))).toBe(false);
  });

  it('follows the business it was told about, not a fixed one', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      programResponse({ businessName: 'Ferretería Sur', businessSlug: 'ferreteria-sur' }),
    );

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    await act(async () => {
      screen.getByRole('button', { name: /descargar qr/i }).click();
    });

    expect(downloads).toContain('vyloop-qr-ferreteria-sur.png');
  });

  it('survives a business name that is only punctuation, by falling back to the slug', async () => {
    // `###` normalises to nothing, and a `download` attribute with nothing usable
    // gives `vyloop-qr-.png` or no name at all. The slug is always writable and is
    // the same tenant the QR points at.
    vi.mocked(apiFetch).mockResolvedValue(programResponse({ businessName: '###' }));

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    await act(async () => {
      screen.getByRole('button', { name: /descargar qr/i }).click();
    });

    expect(downloads).toContain('vyloop-qr-panaderia-del-barrio.png');
  });
});

describe('the copied link is the same URL the QR encodes', async () => {
  it('copies the merchant\'s own registration URL', async () => {
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    await act(async () => {
      screen.getByRole('button', { name: /copiar enlace/i }).click();
    });

    expect(writeText).toHaveBeenCalledWith(qrValue());
    expect(writeText).toHaveBeenCalledWith(
      'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=panaderia-del-barrio',
    );
  });

  it('shows the merchant\'s URL on the card, so it can be read without scanning', async () => {
    // The printed URL is how a merchant types a QR into a menu or a poster by
    // hand. If it disagreed with the QR, the printed one is the wrong business.
    vi.mocked(apiFetch).mockResolvedValue(programResponse());

    render(<QRCodePage />);
    await waitFor(() => expect(qr()).not.toBeNull());

    expect(text()).toContain('register?biz=panaderia-del-barrio');
    expect(text()).not.toContain('cafe-central');
  });
});
