import { describe, expect, it } from 'vitest';

import { resolveGatewayUrl } from './gateway-url';

describe('resolveGatewayUrl', () => {
  const PRODUCTION = 'https://gateway.cl-jmunoz.workers.dev';

  it('uses the configured value', () => {
    expect(resolveGatewayUrl(PRODUCTION, true)).toBe(PRODUCTION);
  });

  it('trims the value and drops a trailing slash', () => {
    expect(resolveGatewayUrl(`  ${PRODUCTION}/  `, true)).toBe(PRODUCTION);
    expect(resolveGatewayUrl(`${PRODUCTION}///`, true)).toBe(PRODUCTION);
  });

  it('refuses to guess in production, and names the variable', () => {
    // The deployed bundle inlined `http://localhost:8787` and the login page
    // failed in the browser with `ERR_CONNECTION_REFUSED`. A fallback is the
    // thing that shipped that bug, so production must have no fallback at all.
    expect(() => resolveGatewayUrl(undefined, true)).toThrow(/NEXT_PUBLIC_API_URL/);
    expect(() => resolveGatewayUrl('', true)).toThrow(/NEXT_PUBLIC_API_URL/);
    expect(() => resolveGatewayUrl('   ', true)).toThrow(/NEXT_PUBLIC_API_URL/);
  });

  it('does not fall back to localhost even in production', () => {
    // Asserting the message does not contain the address keeps the error useful
    // (it says what to set) without handing anyone a copy-pasteable default.
    let message = '';
    try {
      resolveGatewayUrl(undefined, true);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toContain('localhost:8787');
  });

  it('falls back to the local gateway outside production', () => {
    expect(resolveGatewayUrl(undefined, false)).toBe('http://localhost:8787');
    expect(resolveGatewayUrl('', false)).toBe('http://localhost:8787');
  });

  it('prefers the configured value over the development fallback', () => {
    expect(resolveGatewayUrl(PRODUCTION, false)).toBe(PRODUCTION);
  });
});
