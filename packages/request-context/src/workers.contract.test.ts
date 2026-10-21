import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

const WORKERS = ['analytics','automation','communication','compliance','customer','growth','identity','wallet'];

describe('every worker establishes and reports a request id', () => {
  it.each(WORKERS)('%s', (worker) => {
    const source = readFileSync(join(ROOT, 'workers', worker, 'src', 'index.ts'), 'utf8');

    expect(source).toContain("app.use('*', requestIdMiddleware());");
    expect(source).toContain('app.onError(createErrorHandler(');
  });
});
