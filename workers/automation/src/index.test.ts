import { describe, expect, it } from 'vitest';

import worker from './index';

/**
 * The worker's HTTP surface, which until now had no app-level test: the cron and
 * event handlers each have one, but the middleware in front of both did not.
 *
 * These two cases are the whole contract of `PUBLIC_PATHS`. The first says the
 * liveness probe works without a gateway identity; the second says the
 * exemption is exact, so a path that merely starts with `/health` is still
 * refused.
 */
describe('automation worker HTTP surface', () => {
  it('answers the liveness probe without gateway headers', async () => {
    const response = await worker.fetch(new Request('http://localhost/health'), {} as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'automation' });
  });

  it('still refuses a path that only starts with /health', async () => {
    const response = await worker.fetch(new Request('http://localhost/health/extra'), {} as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Missing authentication headers' },
    });
  });
});
