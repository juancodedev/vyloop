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
}));

const { registerAllSchemas } = await import('./register-schemas');

describe('registerAllSchemas', () => {
  const kv = {} as unknown as KVNamespace;

  beforeEach(() => {
    registerSchemaMock.mockReset();
    registerSchemaMock.mockResolvedValue(undefined);
  });

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

  it('should register all five schemas', async () => {
    await registerAllSchemas(kv);

    expect(registerSchemaMock).toHaveBeenCalledTimes(5);
  });
});
