import { describe, expect, it } from 'vitest';

import { assertVerifiedTls, isProductionHost } from './database-url.mjs';

const HOST = 'ep-example-123-pooler.c-4.us-east-1.aws.neon.tech';
const withMode = (mode) =>
  `postgresql://user:super-secret@${HOST}/neondb${mode === null ? '' : `?sslmode=${mode}`}`;

describe('assertVerifiedTls', () => {
  it('accepts sslmode=verify-full', () => {
    expect(assertVerifiedTls(withMode('verify-full')).host).toBe(HOST);
  });

  for (const mode of ['require', 'prefer', 'verify-ca', 'disable', 'no-verify', null]) {
    it(`refuses ${mode ?? 'a missing sslmode'}`, () => {
      expect(() => assertVerifiedTls(withMode(mode))).toThrow(/sslmode must be verify-full/);
    });
  }

  it('names the host in the error and never the password', () => {
    let message = '';
    try {
      assertVerifiedTls(withMode('require'));
    } catch (error) {
      message = error.message;
    }

    expect(message).toContain(HOST);
    expect(message).not.toContain('super-secret');
  });

  it('refuses a missing URL without echoing anything', () => {
    expect(() => assertVerifiedTls(undefined)).toThrow('DATABASE_URL is not set');
  });

  it('refuses a malformed URL without echoing it', () => {
    expect(() => assertVerifiedTls('not a url with a password inside')).toThrow(
      'DATABASE_URL is not a valid URL',
    );
  });
});

describe('isProductionHost', () => {
  it('recognises the production endpoint, pooled or direct', () => {
    expect(
      isProductionHost(
        'postgresql://user:pass@ep-shiny-paper-aibbf0hk-pooler.c-4.us-east-1.aws.neon.tech/neondb',
      ),
    ).toBe(true);
    expect(
      isProductionHost(
        'postgresql://user:pass@ep-shiny-paper-aibbf0hk.c-4.us-east-1.aws.neon.tech/neondb',
      ),
    ).toBe(true);
  });

  it('does not match another endpoint or a lookalike host', () => {
    expect(isProductionHost(withMode('verify-full'))).toBe(false);
    expect(
      isProductionHost(
        'postgresql://user:pass@ep-shiny-paper-aibbf0hk.evil.example/neondb?sslmode=verify-full',
      ),
    ).toBe(false);
  });
});
