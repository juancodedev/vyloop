import { describe, it, expect } from 'vitest';

import { generateApiKey, validateApiKey, validateScopes, VALID_SCOPES } from './api-keys';

describe('ApiKeys', () => {
  describe('generateApiKey', () => {
    it('should generate a key with the correct prefix and length', async () => {
      const result = await generateApiKey('test-key', ['read:customers']);

      expect(result.rawKey).toMatch(/^vyl_/);
      expect(result.rawKey.length).toBe(48);
      expect(result.hash).toBeTruthy();
      expect(result.name).toBe('test-key');
      expect(result.scopes).toEqual(['read:customers']);
    });

    it('should generate unique keys on each call', async () => {
      const k1 = await generateApiKey('key-1', ['read:customers']);
      const k2 = await generateApiKey('key-2', ['read:customers']);

      expect(k1.rawKey).not.toBe(k2.rawKey);
      expect(k1.hash).not.toBe(k2.hash);
    });

    it('should throw for invalid scopes', async () => {
      await expect(generateApiKey('bad-key', ['invalid:scope'])).rejects.toThrow('Invalid scopes');
    });
  });

  describe('hashKey / validateApiKey', () => {
    it('should verify a correct key against its hash', async () => {
      const { rawKey, hash } = await generateApiKey('test', ['read:customers']);

      const isValid = await validateApiKey(rawKey, hash);
      expect(isValid).toBe(true);
    });

    it('should reject an incorrect key', async () => {
      const { hash } = await generateApiKey('test', ['read:customers']);

      const isValid = await validateApiKey('wrong-key', hash);
      expect(isValid).toBe(false);
    });
  });

  describe('validateScopes', () => {
    it('should return valid for known scopes', () => {
      const result = validateScopes(['read:customers', 'write:loyalty']);
      expect(result.valid).toBe(true);
      expect(result.invalid).toEqual([]);
    });

    it('should return invalid for unknown scopes', () => {
      const result = validateScopes(['read:customers', 'unknown:scope']);
      expect(result.valid).toBe(false);
      expect(result.invalid).toEqual(['unknown:scope']);
    });
  });

  describe('VALID_SCOPES', () => {
    it('should contain all required scopes', () => {
      expect(VALID_SCOPES).toContain('read:customers');
      expect(VALID_SCOPES).toContain('write:customers');
      expect(VALID_SCOPES).toContain('write:loyalty');
      expect(VALID_SCOPES).toContain('read:analytics');
      expect(VALID_SCOPES).toContain('admin:billing');
      expect(VALID_SCOPES).toContain('admin:webhooks');
    });
  });
});
