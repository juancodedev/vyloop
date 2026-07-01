import { describe, it, expect } from 'vitest';

describe('database package', () => {
  it('should export createDb function', async () => {
    const mod = await import('./index');
    expect(mod.createDb).toBeDefined();
    expect(typeof mod.createDb).toBe('function');
  });
});
