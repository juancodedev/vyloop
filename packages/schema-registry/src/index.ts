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
      required: ['customer_id', 'points_redeemed', 'total_points_after', 'partial', 'reference_id', 'redemption_id', 'reward_id'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        points_redeemed: { type: 'integer', minimum: 1, description: 'Points consumed in this redemption' },
        total_points_after: { type: 'integer', minimum: 0, description: 'Balance after redemption' },
        reward_id: { type: 'string', format: 'uuid', description: 'Catalog reward identifier' },
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

/**
 * JSON Schema v1.0.0 for RewardAutoGranted events (envelope format).
 *
 * Validates the full envelope with header + payload.
 * Payload: customer_id, reward_id, reward_name, granted_at, balance_after.
 */
export const rewardAutoGrantedSchema = {
  $id: 'https://schema.vyloop.app/events/RewardAutoGranted/v1.0.0',
  type: 'object',
  title: 'RewardAutoGranted',
  description: 'Envelope schema for RewardAutoGranted events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['customer_id', 'reward_id', 'reward_name', 'granted_at', 'balance_after'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        reward_id: { type: 'string', format: 'uuid', description: 'Catalog reward identifier' },
        reward_name: { type: 'string', minLength: 1, description: 'Name of the auto-granted reward' },
        granted_at: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp of grant' },
        balance_after: { type: 'integer', minimum: 0, description: 'Customer balance after grant' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * JSON Schema v1.0.0 for RewardAvailableAtBranch events (envelope format).
 *
 * Validates the full envelope with header + payload.
 * Payload: customer_id, reward_id, reward_name, grant_id, branch_ids, granted_at.
 *
 * `branch_ids` has `minItems: 1` on purpose: the event exists to say where a
 * reward can be redeemed, and a grant with no venues is not this event — it is
 * `RewardAutoGranted`. An empty array here would let a producer publish an
 * event whose only content is missing, and the consumer would have to guess
 * whether it meant "every venue" or "no data".
 */
export const rewardAvailableAtBranchSchema = {
  $id: 'https://schema.vyloop.app/events/RewardAvailableAtBranch/v1.0.0',
  type: 'object',
  title: 'RewardAvailableAtBranch',
  description: 'Envelope schema for RewardAvailableAtBranch events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['customer_id', 'reward_id', 'reward_name', 'grant_id', 'branch_ids', 'granted_at'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        reward_id: { type: 'string', format: 'uuid', description: 'Catalog reward identifier' },
        reward_name: { type: 'string', minLength: 1, description: 'Name of the granted reward' },
        grant_id: { type: 'string', format: 'uuid', description: 'The reward_grants row this announcement is about' },
        branch_ids: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', format: 'uuid' },
          description: 'Venues where the reward can be redeemed',
        },
        granted_at: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp of the grant' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// WhatsApp & Automation event schemas
// ---------------------------------------------------------------------------

/**
 * JSON Schema v1.0.0 for WhatsAppOutboundRequested events (envelope format).
 *
 * Validates the full envelope with header + payload.
 * Payload: customer_id, business_id, template_name, parameters, idempotency_key.
 */
export const whatsappOutboundRequestedSchema = {
  $id: 'https://schema.vyloop.app/events/WhatsAppOutboundRequested/v1.0.0',
  type: 'object',
  title: 'WhatsAppOutboundRequested',
  description: 'Envelope schema for WhatsAppOutboundRequested events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['customer_id', 'business_id', 'template_name', 'parameters', 'idempotency_key'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        business_id: { type: 'string', format: 'uuid', description: 'Business scoping identifier' },
        template_name: { type: 'string', minLength: 1, description: 'Registered Meta template name' },
        parameters: { type: 'object', description: 'Template variable substitutions', additionalProperties: { type: 'string' } },
        idempotency_key: { type: 'string', minLength: 1, description: 'Dedup key (workflow_execution.id)' },
        phone: { type: 'string', description: 'Pre-resolved phone number in E.164 format' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * JSON Schema v1.0.0 for PushNotificationRequested events (envelope format).
 *
 * Validates the full envelope with header + payload. The payload is what the
 * platform chose to say; the customer identifier is the global id, like every
 * other customer event.
 */
export const pushNotificationRequestedSchema = {
  $id: 'https://schema.vyloop.app/events/PushNotificationRequested/v1.0.0',
  type: 'object',
  title: 'PushNotificationRequested',
  description: 'Envelope schema for PushNotificationRequested events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['customer_id', 'business_id', 'title', 'body'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        business_id: { type: 'string', format: 'uuid', description: 'Business scoping identifier' },
        title: { type: 'string', minLength: 1, description: 'Notification title' },
        body: { type: 'string', description: 'Notification body' },
        url: { type: 'string', description: 'Where the notification leads' },
        reference_id: { type: 'string', description: 'Dedup key for the message' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * JSON Schema v1.0.0 for PushCampaignRequested events (envelope format).
 *
 * Validates the full envelope with header + payload.
 *
 * The payload carries a **target**, never an audience. The target is either a
 * venue (`branch_id`) or a centre and a radius in metres. The audience is
 * resolved on the server, when the event is consumed: a campaign that named
 * its recipients would be a campaign a caller could aim at any customer in
 * any tenant, and the whole point of the target is that the server decides
 * who is near a place.
 */
export const pushCampaignRequestedSchema = {
  $id: 'https://schema.vyloop.app/events/PushCampaignRequested/v1.0.0',
  type: 'object',
  title: 'PushCampaignRequested',
  description: 'Envelope schema for PushCampaignRequested events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['business_id', 'title', 'body', 'target'],
      properties: {
        business_id: { type: 'string', format: 'uuid', description: 'Business scoping identifier' },
        title: { type: 'string', minLength: 1, description: 'Notification title' },
        body: { type: 'string', description: 'Notification body' },
        url: { type: 'string', description: 'Where the notification leads' },
        reference_id: { type: 'string', description: 'Dedup key for the campaign' },
        target: {
          type: 'object',
          description: 'Where the campaign points. A venue, or a centre and a radius.',
          oneOf: [
            {
              type: 'object',
              required: ['branch_id'],
              properties: {
                branch_id: { type: 'string', format: 'uuid', description: 'The venue' },
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['latitude', 'longitude', 'radius_m'],
              properties: {
                latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Centre latitude' },
                longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Centre longitude' },
                radius_m: { type: 'integer', minimum: 1, description: 'Radius in metres' },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * JSON Schema v1.0.0 for CustomerCheckedIn events (envelope format).
 *
 * Validates the full envelope with header + payload.
 *
 * The payload carries the customer and the venue they interacted with. It is
 * the fact a proximity audience is built from: a customer who has been at a
 * venue is reachable by a campaign aimed at that venue, and no other record of
 * "having been at a place" exists.
 */
export const customerCheckedInSchema = {
  $id: 'https://schema.vyloop.app/events/CustomerCheckedIn/v1.0.0',
  type: 'object',
  title: 'CustomerCheckedIn',
  description: 'Envelope schema for CustomerCheckedIn events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['customer_id', 'business_id', 'branch_id'],
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        business_id: { type: 'string', format: 'uuid', description: 'Business scoping identifier' },
        branch_id: { type: 'string', format: 'uuid', description: 'The venue the interaction happened at' },
        checkin_id: { type: 'string', format: 'uuid', description: 'The interaction itself' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * JSON Schema v1.0.0 for WorkflowTriggered events (envelope format).
 *
 * Validates the full envelope with header + payload.
 * Payload: workflow_id, customer_id, business_id, action_type, skipped state.
 */
export const workflowTriggeredSchema = {
  $id: 'https://schema.vyloop.app/events/WorkflowTriggered/v1.0.0',
  type: 'object',
  title: 'WorkflowTriggered',
  description: 'Envelope schema for WorkflowTriggered events',
  required: ['header', 'payload'],
  properties: {
    header: envelopeHeaderSchema,
    payload: {
      type: 'object',
      required: ['workflow_id', 'customer_id', 'business_id', 'action_type'],
      properties: {
        workflow_id: { type: 'string', format: 'uuid', description: 'Workflow identifier' },
        customer_id: { type: 'string', format: 'uuid', description: 'Customer identifier' },
        business_id: { type: 'string', format: 'uuid', description: 'Business scoping identifier' },
        action_type: { type: 'string', description: 'Action type that was triggered (e.g. send_whatsapp)' },
        template_name: { type: 'string', description: 'Template name if action was send_whatsapp' },
        skipped: { type: 'boolean', description: 'Whether the action was skipped (e.g. due to consent)' },
        skip_reason: { type: 'string', description: 'Reason the action was skipped' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
