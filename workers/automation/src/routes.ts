import { Hono } from 'hono';

import type { Bindings } from './helpers';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

// ============================================================================
// Health check
// ============================================================================

/**
 * GET /health
 *
 * Minimal health-check endpoint for the automation worker.
 * The worker is primarily queue-driven; this exists for liveness probes.
 */
router.get('/health', async (c) => {
  return c.json({ status: 'ok', service: 'automation' });
});

export default router;
