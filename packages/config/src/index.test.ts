import { describe, it, expect, beforeEach } from 'vitest';

import { env, envOptional } from './index';

const TEST_KEY = 'VYLOOP_TEST_VAR';

beforeEach(() => {
  delete process.env[TEST_KEY];
});

describe('env', () => {
  it('should throw for missing variable', () => {
    expect(() => env('UNDEFINED_VAR_99999')).toThrow(
      'Missing required environment variable',
    );
  });

  it('should return value when set', () => {
    process.env[TEST_KEY] = 'hello';
    expect(env(TEST_KEY)).toBe('hello');
  });
});

describe('envOptional', () => {
  it('should return undefined for missing variable', () => {
    expect(envOptional('UNDEFINED_VAR_99999')).toBeUndefined();
  });

  it('should return default when provided', () => {
    expect(envOptional('UNDEFINED_VAR_99999', 'fallback')).toBe('fallback');
  });

  it('should return actual value over default', () => {
    process.env[TEST_KEY] = 'actual';
    expect(envOptional(TEST_KEY, 'fallback')).toBe('actual');
  });
});
