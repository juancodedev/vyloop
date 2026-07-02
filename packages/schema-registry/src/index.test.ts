import { describe, it, expect } from 'vitest';

describe('schemas package', () => {
  it('should export types from @vyloop/types', async () => {
    const mod = await import('./index');
    // The module should load without errors (type-only exports)
    expect(mod).toBeDefined();
  });
});
