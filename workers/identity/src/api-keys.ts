// ---------------------------------------------------------------------------
// API Key management
//
// API keys are generated as `vyl_` + random hex (48 chars total).
// The raw key is returned ONCE to the caller. Only the SHA-256 hash is
// persisted in the database — the raw key cannot be recovered.
// ---------------------------------------------------------------------------

/** Valid permission scopes for API keys. */
export const VALID_SCOPES = [
  'read:customers',
  'write:customers',
  'write:loyalty',
  'read:analytics',
  'admin:billing',
  'admin:webhooks',
] as const;

export type ApiKeyScope = (typeof VALID_SCOPES)[number];

/** Prefix for all generated API keys — enables key rotation by prefix. */
const KEY_PREFIX = 'vyl_';

/** Total length of the generated key including prefix. */
const KEY_TOTAL_LENGTH = 48;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new API key.
 *
 * @returns An object with `rawKey` (return to caller ONCE) and `hash`
 *          (store in database).
 */
export async function generateApiKey(
  name: string,
  scopes: string[],
): Promise<{ rawKey: string; hash: string; prefix: string; name: string; scopes: string[] }> {
  // Generate random bytes for the key body
  const bodyLength = KEY_TOTAL_LENGTH - KEY_PREFIX.length;
  const bytes = new Uint8Array(bodyLength / 2); // 2 hex chars per byte
  crypto.getRandomValues(bytes);

  const rawKey = `${KEY_PREFIX}${hex(bytes)}`;

  // Validate scopes
  const invalidScopes = scopes.filter((s) => !VALID_SCOPES.includes(s as ApiKeyScope));
  if (invalidScopes.length > 0) {
    throw new Error(`Invalid scopes: ${invalidScopes.join(', ')}`);
  }

  // SHA-256 hash for storage
  const hash = await hashKey(rawKey);

  return { rawKey, hash, prefix: KEY_PREFIX, name, scopes };
}

/**
 * Hash an API key using SHA-256.
 *
 * @param key The raw API key string.
 * @returns Hex-encoded SHA-256 digest.
 */
export async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hex(new Uint8Array(digest));
}

/**
 * Validate an API key against a stored hash.
 *
 * @param rawKey   The raw key provided in the request.
 * @param storedHash The SHA-256 hash stored in the database.
 * @returns `true` if the key matches the hash.
 */
export async function validateApiKey(rawKey: string, storedHash: string): Promise<boolean> {
  const computedHash = await hashKey(rawKey);
  return computedHash === storedHash;
}

/**
 * Check if the provided scopes are valid.
 */
export function validateScopes(scopes: string[]): { valid: boolean; invalid: string[] } {
  const invalid = scopes.filter((s) => !VALID_SCOPES.includes(s as ApiKeyScope));
  return { valid: invalid.length === 0, invalid };
}
