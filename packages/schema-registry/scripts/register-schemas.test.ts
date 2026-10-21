import type { KVNamespace } from '@cloudflare/workers-types';
import { describe, it, expect, vi } from 'vitest';

// Mock the schema registry module so we can verify calls without side effects
const registerSchemaMock = vi.fn();
vi.mock('../src/index.ts', () => ({
  registerSchema: registerSchemaMock,
  customerRegisteredSchema: {
    $id: 'https://schema.vyloop.app/events/CustomerRegistered/v1.0.0',
    title: 'CustomerRegistered',
    type: 'object',
    properties: {},
  },
  pointsAssignedSchema: {
    $id: 'https://schema.vyloop.app/events/PointsAssigned/v1.0.0',
    title: 'PointsAssigned',
    type: 'object',
    properties: {},
  },
  rewardRedeemedSchema: {
    $id: 'https://schema.vyloop.app/events/RewardRedeemed/v1.0.0',
    title: 'RewardRedeemed',
    type: 'object',
    properties: {},
  },
  pushNotificationRequestedSchema: {
    $id: 'https://schema.vyloop.app/events/PushNotificationRequested/v1.0.0',
    type: 'object',
    title: 'PushNotificationRequested',
    description: 'Envelope schema for PushNotificationRequested events',
    required: ['header', 'payload'],
    properties: {
      header: { type: 'object' },
      payload: { type: 'object' },
    },
    additionalProperties: false,
  },
  whatsappOutboundRequestedSchema: {
    $id: 'https://schema.vyloop.app/events/WhatsAppOutboundRequested/v1.0.0',
    title: 'WhatsAppOutboundRequested',
    type: 'object',
    properties: {},
  },
  workflowTriggeredSchema: {
    $id: 'https://schema.vyloop.app/events/WorkflowTriggered/v1.0.0',
    title: 'WorkflowTriggered',
    type: 'object',
    properties: {},
  },
  pushCampaignRequestedSchema: {
    $id: 'https://schema.vyloop.app/events/PushCampaignRequested/v1.0.0',
    title: 'PushCampaignRequested',
    type: 'object',
    properties: {},
  },
  customerCheckedInSchema: {
    $id: 'https://schema.vyloop.app/events/CustomerCheckedIn/v1.0.0',
    title: 'CustomerCheckedIn',
    type: 'object',
    properties: {},
  },
  rewardAvailableAtBranchSchema: {
    $id: 'https://schema.vyloop.app/events/RewardAvailableAtBranch/v1.0.0',
    title: 'RewardAvailableAtBranch',
    type: 'object',
    properties: {},
  },
}));

const { registerAllSchemas } = await import('./register-schemas');

describe('registerAllSchemas', () => {
  const kv = {} as unknown as KVNamespace;

  beforeEach(() => {
    registerSchemaMock.mockReset();
    registerSchemaMock.mockResolvedValue(undefined);
  });

  it.each(['PushCampaignRequested', 'CustomerCheckedIn'])(
    'should register %s schema',
    async (eventType) => {
      await registerAllSchemas(kv);

      expect(registerSchemaMock).toHaveBeenCalledWith(
        kv,
        eventType,
        expect.objectContaining({ title: eventType }),
        '1.0.0',
      );
    },
  );

  it('should register CustomerRegistered schema', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledWith(
      kv,
      'CustomerRegistered',
      expect.objectContaining({ title: 'CustomerRegistered' }),
      '1.0.0',
    );
  });

  it('should register PointsAssigned schema', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledWith(
      kv,
      'PointsAssigned',
      expect.objectContaining({ title: 'PointsAssigned' }),
      '1.0.0',
    );
  });

  it('should register RewardRedeemed schema', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledWith(
      kv,
      'RewardRedeemed',
      expect.objectContaining({ title: 'RewardRedeemed' }),
      '1.0.0',
    );
  });

  it('should register WhatsAppOutboundRequested schema', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledWith(
      kv,
      'WhatsAppOutboundRequested',
      expect.objectContaining({ title: 'WhatsAppOutboundRequested' }),
      '1.0.0',
    );
  });

  it('should register WorkflowTriggered schema', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledWith(
      kv,
      'WorkflowTriggered',
      expect.objectContaining({ title: 'WorkflowTriggered' }),
      '1.0.0',
    );
  });

  it('should register RewardAvailableAtBranch schema', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledWith(
      kv,
      'RewardAvailableAtBranch',
      expect.objectContaining({ title: 'RewardAvailableAtBranch' }),
      '1.0.0',
    );
  });

  it('should register all nine schemas', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledTimes(9);
  });
});
