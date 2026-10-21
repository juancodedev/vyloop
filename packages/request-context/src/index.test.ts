import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';

import {
  REQUEST_ID_HEADER,
  getRequestId,
  isValidRequestId,
  logPrefix,
  requestIdMiddleware,
  resolveRequestId,
} from './index';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('isValidRequestId', () => {
  it('accepts a UUID', () => {
    expect(isValidRequestId(crypto.randomUUID())).toBe(true);
  });

  it('accepts both boundary lengths', () => {
    expect(isValidRequestId('a'.repeat(8))).toBe(true);
    expect(isValidRequestId('a'.repeat(128))).toBe(true);
  });

  it('refuses a length outside the range', () => {
    expect(isValidRequestId('a'.repeat(7))).toBe(false);
    expect(isValidRequestId('a'.repeat(129))).toBe(false);
  });

  it('refuses an empty, absent or non-string value', () => {
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId(undefined)).toBe(false);
  });

  it('refuses a value that could reshape a log line', () => {
    expect(isValidRequestId('abc def ghi')).toBe(false);
    expect(isValidRequestId('abc\ndefgh')).toBe(false);
    expect(isValidRequestId('abcdefgh=')).toBe(false);
    expect(isValidRequestId('abcdefgh;drop')).toBe(false);
  });
});

describe('resolveRequestId', () => {
  it('keeps a well-formed id', () => {
    expect(resolveRequestId('0123456789abcdef')).toBe('0123456789abcdef');
  });

  it('generates a UUID for an absent or malformed id', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
    expect(resolveRequestId('bad id!')).toMatch(UUID);
  });
});

describe('logPrefix', () => {
  it('formats the service and the id', () => {
    expect(logPrefix('growth', 'abc')).toBe('[growth] request_id=abc');
  });
});

describe('requestIdMiddleware', () => {
  it('generates an id, forwards it and echoes it', async () => {
    let forwarded: string | undefined;
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/ok', (c) => {
      forwarded = c.req.header(REQUEST_ID_HEADER);
      return c.json({ id: getRequestId(c) });
    });

    const res = await app.request('/ok');
    const id = res.headers.get(REQUEST_ID_HEADER);

    expect(id).toMatch(UUID);
    expect(forwarded).toBe(id);
    expect(await res.json()).toEqual({ id });
  });

  it('keeps a well-formed client id', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/ok', (c) => c.json({ id: getRequestId(c) }));

    const res = await app.request('/ok', {
      headers: { [REQUEST_ID_HEADER]: 'client-id-1234' },
    });

    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('client-id-1234');
    expect(await res.json()).toEqual({ id: 'client-id-1234' });
  });

  it('replaces a malformed client id', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/ok', (c) => c.json({ id: getRequestId(c) }));

    const res = await app.request('/ok', {
      headers: { [REQUEST_ID_HEADER]: 'bad id!' },
    });

    const id = res.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(UUID);
    expect(await res.json()).toEqual({ id });
  });

  it('sets the response header after a thrown error', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware());
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.onError((err, c) => c.json({ error: err.message, request_id: getRequestId(c) }, 500));

    const res = await app.request('/boom', {
      headers: { [REQUEST_ID_HEADER]: 'client-id-1234' },
    });

    expect(res.status).toBe(500);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('client-id-1234');
    expect(await res.json()).toEqual({ error: 'boom', request_id: 'client-id-1234' });
  });
});
