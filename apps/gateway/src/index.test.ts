import { describe, it, expect } from 'vitest';
import app from './index';

describe('API Gateway', () => {
  describe('GET /health', () => {
    it('returns 200 with status ok and timestamp', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { status: string; timestamp: string };
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('timestamp');
      expect(typeof body.timestamp).toBe('string');
    });
  });

  describe('GET /unknown', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await app.request('/unknown');
      expect(res.status).toBe(404);
    });

    it('returns JSON body for 404', async () => {
      const res = await app.request('/some-route');
      const body = (await res.json()) as { message: string };
      expect(body).toHaveProperty('message');
    });
  });
});
