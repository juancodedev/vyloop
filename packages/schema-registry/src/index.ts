import Ajv, { type ValidateFunction } from 'ajv';
import type { KVNamespace } from '@cloudflare/workers-types';

const ajv = new Ajv({
  // Prevent schema-with-$id conflicts when re-compiling schemas with same $id
  addUsedSchema: false,
});

// Register format validators used by our event schemas
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/);
ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

/**
 * In-memory cache of compiled AJV validators, keyed by schema key.
 * Avoids recompiling on every validate() call for the same event type.
 */
const validatorCache = new Map<string, ValidateFunction>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function schemaKey(eventType: string, version?: string): string {
  return version ? `${eventType}:${version}` : `${eventType}:latest`;
}

function validatorCacheKey(eventType: string, version?: string): string {
  return schemaKey(eventType, version);
}

/** Extract a semver version string from the schema's $id field. */
function extractVersionFromId($id: string | undefined): string | null {
  if (!$id) return null;
  const segments = $id.split('/');
  const last = segments[segments.length - 1];
  // Accept "v1.0.0" or "1.0.0" style version tails
  if (/^v?\d+\.\d+\.\d+$/.test(last)) {
    return last.replace(/^v/, '');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a registered JSON Schema from the KV store.
 *
 * @param kv        The Workers KV namespace bound as `SCHEMA_REGISTRY`.
 * @param eventType The event type key (e.g. `purchase_completed`).
 * @param version   Optional semver string. Uses `:latest` tag when omitted.
 * @returns The parsed schema object, or `null` when not found.
 */
export async function getSchema(
  kv: KVNamespace,
  eventType: string,
  version?: string,
): Promise<Record<string, unknown> | null> {
  const key = schemaKey(eventType, version);
  const raw = await kv.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Register (or overwrite) a JSON Schema in the KV store.
 * Stores under both `{eventType}:{version}` and `{eventType}:latest`.
 *
 * @param kv        The Workers KV namespace bound as `SCHEMA_REGISTRY`.
 * @param eventType The event type key (e.g. `purchase_completed`).
 * @param schema    The JSON Schema object.
 * @param version   Semver string (e.g. `1.0.0`). Auto-detected from `$id` when omitted.
 */
export async function registerSchema(
  kv: KVNamespace,
  eventType: string,
  schema: Record<string, unknown>,
  version?: string,
): Promise<void> {
  // Prefer explicit version, fall back to $id extraction, then default
  const ver = version ?? extractVersionFromId(schema.$id as string | undefined) ?? '1.0.0';

  // Write versioned key
  await kv.put(schemaKey(eventType, ver), JSON.stringify(schema));
  // Update latest pointer
  await kv.put(schemaKey(eventType), JSON.stringify(schema));

  // Bust cache
  validatorCache.delete(validatorCacheKey(eventType, ver));
  validatorCache.delete(validatorCacheKey(eventType));
}

/**
 * Validate a payload against the registered schema for the given event type.
 *
 * @param kv        The Workers KV namespace bound as `SCHEMA_REGISTRY`.
 * @param eventType The event type key.
 * @param payload   The data to validate.
 * @returns An object with `valid: boolean` and optional `errors` array.
 */
export async function validate(
  kv: KVNamespace,
  eventType: string,
  payload: unknown,
): Promise<{ valid: boolean; errors?: string[] }> {
  const schema = await getSchema(kv, eventType);
  if (!schema) {
    return { valid: false, errors: [`Schema not found for event type: "${eventType}"`] };
  }

  const cacheKey = validatorCacheKey(eventType);
  let validateFn = validatorCache.get(cacheKey);

  if (!validateFn) {
    validateFn = ajv.compile(schema);
    validatorCache.set(cacheKey, validateFn);
  }

  const ok = validateFn(payload);
  if (ok) {
    return { valid: true };
  }

  const errorMessages = validateFn.errors?.map(
    (e) => `${e.instancePath} ${e.message ?? ''}`.trim(),
  );
  return { valid: false, errors: errorMessages ?? ['Validation failed'] };
}

/**
 * Clear the internal AJV validator cache.
 * Useful in tests or when schemas are hot-reloaded.
 */
export function clearCache(): void {
  validatorCache.clear();
  ajv.removeSchema();
}
