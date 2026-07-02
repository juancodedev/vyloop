import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.notFound((c) => {
  return c.json({ message: 'Not Found' }, 404);
});

export default app;
