import { createErrorHandler, requestIdMiddleware } from '@vyloop/request-context';
import { Hono } from 'hono';

const app = new Hono();

app.use('*', requestIdMiddleware());

app.all('*', (c) => c.json({ service: 'compliance', status: 'placeholder' }));
app.onError(createErrorHandler('compliance'));

export default app;
