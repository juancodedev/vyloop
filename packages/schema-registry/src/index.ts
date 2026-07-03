import type { KVNamespace } from '@cloudflare/workers-types';
import Ajv, { type ValidateFunction } from 'ajv';

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

// ---------------------------------------------------------------------------
// Event schemas
// ---------------------------------------------------------------------------

/**
 * JSON Schema v1.0.0 for CustomerRegistered events.
 *
 * Validates the event payload contains:
 * - customer_id: string (uuid format, required)
 * - full_name: string (minLength 1, required)
 * - business_id: string (uuid format, required)
 */
export const customerRegisteredSchema = {
  $id: 'https://schema.vyloop.app/events/CustomerRegistered/v1.0.0',
  type: 'object',
  title: 'CustomerRegistered',
  description: 'Payload schema for CustomerRegistered events',
  required: ['customer_id', 'full_name', 'business_id'],
  properties: {
    customer_id: {
      type: 'string',
      format: 'uuid',
      description: "The customer's global_id",
    },
    full_name: {
      type: 'string',
      minLength: 1,
      description: "The customer's full name",
    },
    business_id: {
      type: 'string',
      format: 'uuid',
      description: 'The business scoping identifier',
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Envelope header schema (shared by PointsAssigned and RewardRedeemed)
// ---------------------------------------------------------------------------

const envelopeHeaderSchema = {
  type: 'object',
  required: ['business_id', 'timestamp', 'localization'],
  properties: {
    business_id: {
      type: 'string',
      format: 'uuid',
      description: 'The business scoping identifier',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'ISO 8601 timestamp of event creation',
    },
    localization: {
      type: 'object',
      required: ['language', 'timezone'],
      properties: {
        language: { type: 'string', description: 'Language code (e.g. es-CL)' },
        timezone: { type: 'string', description: 'Timezone (e.g. America/Santiago)' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * JSON Schema v1.0.0 for PointsAssigned events (envelope format).
 *
 * Validates the full envelope with header + payload.
 */
export const pointsAssignedSchema = {
  $id: 'https://schema.vyloop.app/events/PointsAssigned/v1.0.0',
  type: 'object',
  title: 'PointsAssigned',
  description: 'Envelope schema for PointsAssigned events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['customer_id', 'points_assigned', 'points_multiplier', 'total_points', 'reference_id', 'assignment_id'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        points_assigned: { type: 'integer', minimum: 1, description: 'Points awarded in this assignment' },
        points_multiplier: { type: 'number', minimum: 0, description: 'Effective tier multiplier applied' },
        total_points: { type: 'integer', minimum: 0, description: 'Running total balance after assignment' },
        reference_id: { type: 'string', minLength: 1, description: 'Idempotency key scoped to customer' },
        assignment_id: { type: 'string', format: 'uuid', description: 'Unique identifier for this assignment' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * JSON Schema v1.0.0 for RewardRedeemed events (envelope format).
 *
 * Validates the full envelope with header + payload.
 */
export const rewardRedeemedSchema = {
  $id: 'https://schema.vyloop.app/events/RewardRedeemed/v1.0.0',
  type: 'object',
  title: 'RewardRedeemed',
  description: 'Envelope schema for RewardRedeemed events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['customer_id', 'points_redeemed', 'total_points_after', 'partial', 'reference_id', 'redemption_id'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        points_redeemed: { type: 'integer', minimum: 1, description: 'Points consumed in this redemption' },
        total_points_after: { type: 'integer', minimum: 0, description: 'Balance after redemption' },
        reward_name: { type: 'string', description: 'Optional reward description' },
        partial: { type: 'boolean', description: 'Whether this redemption was partial' },
        reference_id: { type: 'string', minLength: 1, description: 'Idempotency key scoped to customer' },
        redemption_id: { type: 'string', format: 'uuid', description: 'Unique identifier for this redemption' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
