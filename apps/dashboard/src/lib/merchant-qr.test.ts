// @vitest-environment node

/**
 * The QR's URL and filename, as pure functions.
 *
 * These two functions are the whole of the fix. Everything else on the page is
 * `useState` and markup, and the bug this file exists for was a hardcoded
 * `?biz=cafe-central` string sitting where `registerHrefFor`'s argument belongs.
 * A URL builder that takes the slug as a parameter cannot express that mistake;
 * a constant in a component can, and did.
 *
 * So these assertions are about the *shape* of the function, not just its output.
 * The two that matter most are the last two in the first block: if someone makes
 * the slug an optional parameter and quietly falls back to a default, those fail.
 */

import { describe, expect, it } from 'vitest';

import {
  customerWebBaseUrl,
  DEFAULT_CUSTOMER_WEB_BASE_URL,
  qrFileNameFor,
  registerHrefFor,
} from './merchant-qr';

describe('registerHrefFor', () => {
  it('builds the registration URL from the slug it is given', () => {
    expect(registerHrefFor('https://customer.example', 'panaderia-del-barrio')).toBe(
      'https://customer.example/register?biz=panaderia-del-barrio',
    );
  });

  it('is the same shape the gateway builds, so both agree on where a customer lands', () => {
    // `apps/gateway/src/merchant-page.ts` builds `${base}/register?biz=${slug}`
    // behind the same slug pattern. If the two ever drift, a customer who
    // registers from a printed QR and a customer who arrives from a merchant's
    // link are sent to different places, and nothing local would look broken.
    expect(registerHrefFor(DEFAULT_CUSTOMER_WEB_BASE_URL, 'ferreteria-sur')).toBe(
      'https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=ferreteria-sur',
    );
  });

  /**
   * The load-bearing test of the whole change: the slug has to actually reach the
   * URL. A builder that accepted the slug and then interpolated a constant would
   * pass every output-shaped test above while shipping the original bug, because
   * the expected values would be the wrong merchant's — which is exactly the
   * failure nobody noticed the first time.
   */
  it('changes its output when the slug changes, so no constant can hide behind it', () => {
    const first = registerHrefFor('https://customer.example', 'panaderia-del-barrio');
    const second = registerHrefFor('https://customer.example', 'ferreteria-sur');

    expect(first).not.toBe(second);
    expect(first).toContain('panaderia-del-barrio');
    expect(second).toContain('ferreteria-sur');
    expect(first).not.toContain('ferreteria-sur');
    expect(second).not.toContain('panaderia-del-barrio');
  });

  it('changes its output when only the host changes', () => {
    // The counterpart to the previous test, and the reason the host is a parameter
    // rather than a literal inside the function: a preview deployment and the
    // production one have to be able to point at different hosts.
    expect(registerHrefFor('https://a.example', 'same-slug')).not.toBe(
      registerHrefFor('https://b.example', 'same-slug'),
    );
  });

  // A URL with no slug is not a worse QR. It is a QR that sends a customer to a
  // registration form for a business nobody chose, which is the bug itself with
  // the name removed. `null` is the only answer that cannot be rendered.
  it('refuses a missing slug rather than emitting `?biz=` with nothing after it', () => {
    expect(registerHrefFor('https://customer.example', null)).toBeNull();
    expect(registerHrefFor('https://customer.example', undefined)).toBeNull();
    expect(registerHrefFor('https://customer.example', '')).toBeNull();
  });

  it('refuses a blank slug, which `tenants.slug` really can hold', () => {
    // `tenants.slug` is `notNull` with no check constraint, so `''` and a
    // whitespace-only value are reachable and `provision.ts` already refuses them
    // for `homepageUri`. A blank here would render a QR reading
    // `...?biz=` — valid, scannable, and pointing nowhere.
    expect(registerHrefFor('https://customer.example', '   ')).toBeNull();
    expect(registerHrefFor('https://customer.example', '\t\n')).toBeNull();
  });

  it('refuses a slug that could break out of the query string', () => {
    // Same shape the gateway refuses, and for the same reasons: `.`, `/`, `%`,
    // `?`, `#`, quotes, spaces and every non-ASCII character are excluded by one
    // pattern. Without this a slug could append `&admin=1` to the URL the customer
    // is sent to, or carry a homoglyph that reads as another business.
    for (const slug of [
      'panaderia?admin=1',
      'panaderia#x',
      '../../register',
      'panaderia/../otra',
      "panaderia'",
      'panaderia"',
      'panaderia rlativa',
      'café-central',
      'PANADERIA',
      '-panaderia',
      'panaderia-',
      'panaderia--doble',
      'panaderia\n',
    ]) {
      expect(registerHrefFor('https://customer.example', slug), slug).toBeNull();
    }
  });

  it('accepts the slugs a real merchant slug can be', () => {
    for (const slug of ['a', 'ferreteria-sur', 'panaderia-del-barrio', 'barro-2', 'x1']) {
      expect(registerHrefFor('https://customer.example', slug), slug).not.toBeNull();
    }
  });

  it('does not double the slash when the configured host already ends in one', () => {
    // `https://host//register?biz=x` is a different path from
    // `https://host/register?biz=x`, and the first one 404s on Cloudflare Pages.
    expect(registerHrefFor('https://customer.example/', 'panaderia')).toBe(
      'https://customer.example/register?biz=panaderia',
    );
  });
});

describe('customerWebBaseUrl', () => {
  it('falls back to the deployment the routes actually live on when unset', () => {
    expect(customerWebBaseUrl(undefined)).toBe(DEFAULT_CUSTOMER_WEB_BASE_URL);
    expect(customerWebBaseUrl('')).toBe(DEFAULT_CUSTOMER_WEB_BASE_URL);
    expect(customerWebBaseUrl('   ')).toBe(DEFAULT_CUSTOMER_WEB_BASE_URL);
  });

  it('uses the configured host and trims trailing slashes', () => {
    expect(customerWebBaseUrl('https://customer.example/')).toBe('https://customer.example');
    expect(customerWebBaseUrl('  https://customer.example  ')).toBe('https://customer.example');
  });

  it('defaults to the same origin the wallet worker puts on a pass', () => {
    // Two independent readers of "where customer-web is", so they are asserted
    // equal: `workers/wallet/src/helpers.ts` and `apps/gateway/src/merchant-page.ts`
    // both carry this value, and a fourth copy drifting from the other three is
    // how a customer ends up registering on a host nobody else knows about.
    expect(DEFAULT_CUSTOMER_WEB_BASE_URL).toBe('https://vyloop-customer-web.cl-jmunoz.workers.dev');
  });
});

describe('qrFileNameFor', () => {
  it('names the file after the business', () => {
    expect(qrFileNameFor('Panadería del Barrio', 'panaderia-del-barrio')).toBe(
      'vyloop-qr-panaderia-del-barrio.png',
    );
  });

  /**
   * A `café` left in a filename is not a cosmetic problem: `download` is a
   * filesystem write, and the unaccented form is what a merchant can retype, print
   * and find again. `Café Central` produced `vyloop-qr-café-central.png` before,
   * which no keyboard reproduces reliably.
   */
  it('strips accents so the name is typeable and portable', () => {
    expect(qrFileNameFor('Café Central', 'cafe-central')).toBe('vyloop-qr-cafe-central.png');
    expect(qrFileNameFor('Panadería Ñandú', 'panaderia')).toBe('vyloop-qr-panaderia-nandu.png');
    expect(qrFileNameFor('Épicerie Zürich', 'epicerie')).toBe('vyloop-qr-epicerie-zurich.png');
  });

  it('turns spaces and punctuation into dashes, with no empty segments', () => {
    expect(qrFileNameFor('Ferretería  y   Pinturas SRL', null)).toBe(
      'vyloop-qr-ferreteria-y-pinturas-srl.png',
    );
    expect(qrFileNameFor('Panadería del Barrio (Sucursal Centro)', null)).toBe(
      'vyloop-qr-panaderia-del-barrio-sucursal-centro.png',
    );
    // A leading or trailing separator would leave `--` or a trailing `-`. `Ñ`
    // folds to `n` and keeps its letter, so `¡Peluquería Ñ!` keeps that `n` —
    // dropping it instead would give `peluqueria`, which is a different word.
    expect(qrFileNameFor('  ¡Peluquería Ñ!  ', null)).toBe('vyloop-qr-peluqueria-n.png');
  });

  it('keeps digits and reads the same regardless of case', () => {
    expect(qrFileNameFor('Barrio 24', null)).toBe('vyloop-qr-barrio-24.png');
    expect(qrFileNameFor('NVA CAFÉ', null)).toBe('vyloop-qr-nva-cafe.png');
  });

  it('falls back to the slug when the name yields nothing usable', () => {
    // A name made entirely of punctuation or non-latin script — `###`, `日本語`
    // — normalises to nothing. The slug is a `[a-z0-9-]` value by construction,
    // so it is always something a filesystem can hold, and it is the same tenant
    // the QR points at, which keeps the filename and the destination in agreement.
    expect(qrFileNameFor('###', 'ferreteria-sur')).toBe('vyloop-qr-ferreteria-sur.png');
    expect(qrFileNameFor('日本語', 'panaderia')).toBe('vyloop-qr-panaderia.png');
    expect(qrFileNameFor(null, 'panaderia')).toBe('vyloop-qr-panaderia.png');
    expect(qrFileNameFor(undefined, undefined)).toBeNull();
  });

  it('never returns a path separator, so a business name cannot choose the directory', () => {
    // `download` is honoured as a suggestion by the browser but a name carrying
    // `../` or a separator is a name the merchant's OS will interpret.
    for (const name of ['../../etc/passwd', 'a/b', 'a\\b', 'C:\\Windows']) {
      const file = qrFileNameFor(name, null);
      expect(file, name).not.toBeNull();
      expect(file, name).not.toMatch(/[/\\]/);
      expect(file, name).toMatch(/^vyloop-qr-[a-z0-9-]+\.png$/);
    }
  });

  it('is the same for the same business, so re-downloading does not litter', () => {
    expect(qrFileNameFor('Panadería del Barrio', 'p')).toBe(
      qrFileNameFor('Panadería del Barrio', 'p'),
    );
  });
});