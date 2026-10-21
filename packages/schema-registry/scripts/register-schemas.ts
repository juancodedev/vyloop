/**
 * Schema registration helper — call at Worker startup to populate KV.
 *
 * Usage (in Worker's scheduled handler or on first request):
 * ```ts
 * import { registerAllSchemas } from '@vyloop/schema-registry/scripts/register-schemas';
 * await registerAllSchemas(env.SCHEMA_REGISTRY);
 * ```
 *
 * Stores each schema under both `{eventType}:{version}` and `{eventType}:latest`.
 */
import type { KVNamespace } from '@cloudflare/workers-types';

import {
  registerSchema,
  customerCheckedInSchema,
  customerRegisteredSchema,
  pointsAssignedSchema,
  pushCampaignRequestedSchema,
  pushNotificationRequestedSchema,
  rewardAvailableAtBranchSchema,
  rewardRedeemedSchema,
  whatsappOutboundRequestedSchema,
  workflowTriggeredSchema,
} from '../src/index.ts';

const SCHEMAS_TO_REGISTER: Array<{
  eventType: string;
  schema: Record<string, unknown>;
  version: string;
}> = [
  {
    eventType: 'CustomerRegistered',
    schema: customerRegisteredSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'PointsAssigned',
    schema: pointsAssignedSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'RewardRedeemed',
    schema: rewardRedeemedSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'WhatsAppOutboundRequested',
    schema: whatsappOutboundRequestedSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'WorkflowTriggered',
    schema: workflowTriggeredSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'PushNotificationRequested',
    schema: pushNotificationRequestedSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'PushCampaignRequested',
    schema: pushCampaignRequestedSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'CustomerCheckedIn',
    schema: customerCheckedInSchema as Record<string, unknown>,
    version: '1.0.0',
  },
  {
    eventType: 'RewardAvailableAtBranch',
    schema: rewardAvailableAtBranchSchema as Record<string, unknown>,
    version: '1.0.0',
  },
];

/**
 * Register all known event schemas into the `SCHEMA_REGISTRY` KV namespace.
 * Idempotent — re-registering the same version overwrites the stored schema.
 */
export async function registerAllSchemas(kv: KVNamespace): Promise<void> {
  await Promise.all(
    SCHEMAS_TO_REGISTER.map(({ eventType, schema, version }) =>
      registerSchema(kv, eventType, schema, version),
    ),
  );
}
