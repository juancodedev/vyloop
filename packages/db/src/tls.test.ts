import { describe, expect, it } from 'vitest';

import { assertVerifiedTls } from './tls';

const HOST = 'ep-shiny-paper-aibbf0hk-pooler.c-4.us-east-1.aws.neon.tech';
const PASSWORD = 'sup3r-s3cret-password';

function url(mode?: string): string {
  const query = mode === undefined ? '' : `?sslmode=${mode}`;
  return `postgres://vyloop:${PASSWORD}@${HOST}/neondb${query}`;
}

describe('assertVerifiedTls', () => {
  it('accepts sslmode=verify-full and returns the parsed URL', () => {
    const parsed = assertVerifiedTls(url('verify-full'));

    expect(parsed.host).toBe(HOST);
    expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
  });

  it.each(['require', 'prefer', 'verify-ca', 'disable', 'no-verify'])('refuses sslmode=%s', (mode) => {
    expect(() => assertVerifiedTls(url(mode))).toThrow(/sslmode must be verify-full/);
  });

  it('refuses a URL with no sslmode at all', () => {
    expect(() => assertVerifiedTls(url())).toThrow(/sslmode must be verify-full \(found none\)/);
  });

  it('is case-sensitive: verify-FULL is not verify-full', () => {
    expect(() => assertVerifiedTls(url('verify-FULL'))).toThrow(/sslmode must be verify-full/);
  });

  it('refuses a loopback URL too, so there is no host list to keep in sync', () => {
    expect(() =>
      assertVerifiedTls('postgres://vyloop:vyloop_dev@localhost:5432/vyloop_dev?sslmode=disable'),
    ).toThrow(/Refusing to connect to localhost:5432/);
  });

  it('names the host and never the password', () => {
    let message = '';
    try {
      assertVerifiedTls(url('require'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(HOST);
    expect(message).not.toContain(PASSWORD);
  });

  it('does not echo the input when it is not a URL', () => {
    let message = '';
    try {
      assertVerifiedTls(`postgres://vyloop:${PASSWORD}@ not-a-host`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('DATABASE_URL is not a valid URL');
    expect(message).not.toContain(PASSWORD);
  });

  it('refuses an empty value', () => {
    expect(() => assertVerifiedTls('')).toThrow('DATABASE_URL is not set');
  });
});
