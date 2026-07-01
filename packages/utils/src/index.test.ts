import { describe, it, expect } from 'vitest';
import { noop, sleep } from './index';

describe('noop', () => {
  it('should return undefined', () => {
    expect(noop()).toBeUndefined();
  });

  it('should accept any arguments', () => {
    expect(noop(1, 'two', { three: 3 })).toBeUndefined();
  });
});

describe('sleep', () => {
  it('should resolve after given time', async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});
