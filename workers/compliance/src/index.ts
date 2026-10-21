import { getRequestId, logPrefix, requestIdMiddleware } from '@vyloop/request-context';
import { Hono } from 'hono';

const app = new Hono();

app.use('*', requestIdMiddleware());

app.all('*', (c) => c.json({ service: 'compliance', status: 'placeholder' }));
app.onError((err, c) => {
  const requestId = getRequestId(c);
  console.error(`${logPrefix('compliance', requestId)} ${c.req.method}:`, err);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: requestId } },
    500,
  );
});

export default app;
