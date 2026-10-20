import { describe, it, expect, vi } from 'vitest';

import { createEnvelope, publish, publishBatch, consume } from './index';
import type { EventEnvelope } from './index';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockMessage(overrides: Partial<{ body: EventEnvelope; id: string; timestamp: Date }> = {}) {
  return {
    id: overrides.id ?? 'msg-001',
    timestamp: overrides.timestamp ?? new Date(),
    body: overrides.body ?? ({} as EventEnvelope),
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Parameters<typeof consume>[0]['messages'][number];
}

function mockBatch(messages: Array<{ body: EventEnvelope; id?: string }>) {
  return {
    queue: 'test-queue',
    messages: messages.map((m, i) => mockMessage({ body: m.body, id: m.id ?? `msg-${i}` })),
  } as unknown as Parameters<typeof consume>[0];
}

function makeEnvelope(payload: unknown = {}): EventEnvelope {
  return createEnvelope(
    'test_event',
    { business_id: 'biz_001', timestamp: new Date().toISOString() },
    payload,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventBus', () => {
  describe('event type constants', () => {
    it('should export CUSTOMER_REGISTERED constant', async () => {
      const mod = await import('./index');
      expect(mod.CUSTOMER_REGISTERED).toBe('CustomerRegistered');
    });

    it('should export POINTS_ASSIGNED constant', async () => {
      const mod = await import('./index');
      expect(mod.POINTS_ASSIGNED).toBe('PointsAssigned');
    });

    it('should export REWARD_REDEEMED constant', async () => {
      const mod = await import('./index');
      expect(mod.REWARD_REDEEMED).toBe('RewardRedeemed');
    });

    it('should export PUSH_CAMPAIGN_REQUESTED constant', async () => {
      const mod = await import('./index');
      expect(mod.PUSH_CAMPAIGN_REQUESTED).toBe('PushCampaignRequested');
    });

    it('should export CUSTOMER_CHECKED_IN constant', async () => {
      const mod = await import('./index');
      expect(mod.CUSTOMER_CHECKED_IN).toBe('CustomerCheckedIn');
    });
  });

  describe('createEnvelope', () => {
    it('should create a valid event envelope', () => {
      const envelope = createEnvelope(
        'test_event',
        {
          business_id: 'biz_001',
          timestamp: '2026-07-02T12:00:00Z',
          localization: { country: 'CL', currency: 'CLP', timezone: 'America/Santiago', language: 'es-CL' },
        },
        { message: 'hello' },
      );

      expect(envelope.id).toBeTruthy();
      expect(envelope.type).toBe('test_event');
      expect(envelope.source).toBe('vyloop.gateway');
      expect(envelope.specversion).toBe('1.0');
      expect(envelope.time).toBeTruthy();
      expect(envelope.header.business_id).toBe('biz_001');
      expect(envelope.payload).toEqual({ message: 'hello' });
    });

    it('should generate a unique ID for each envelope', () => {
      const e1 = createEnvelope('test_event', { business_id: 'biz_1', timestamp: new Date().toISOString() }, {});
      const e2 = createEnvelope('test_event', { business_id: 'biz_1', timestamp: new Date().toISOString() }, {});

      expect(e1.id).not.toBe(e2.id);
    });
  });

  describe('publish', () => {
    it('should send an event to the queue', async () => {
      const queue = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Parameters<typeof publish>[0];
      const envelope = makeEnvelope({ data: 1 });

      await publish(queue, envelope);

      expect(queue.send).toHaveBeenCalledOnce();
      expect(queue.send).toHaveBeenCalledWith(envelope, { contentType: 'json' });
    });
  });

  describe('publishBatch', () => {
    it('should send multiple events in a batch', async () => {
      const queue = { sendBatch: vi.fn().mockResolvedValue(undefined) } as unknown as Parameters<typeof publishBatch>[0];
      const events = [makeEnvelope({ n: 1 }), makeEnvelope({ n: 2 })];

      await publishBatch(queue, events);

      expect(queue.sendBatch).toHaveBeenCalledOnce();
      expect(queue.sendBatch).toHaveBeenCalledWith(
        events.map((e) => ({ body: e, contentType: 'json' })),
      );
    });
  });

  describe('consume', () => {
    it('should call ack for successfully processed messages', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const env = makeEnvelope({ ok: true });
      const batch = mockBatch([{ body: env }]);

      await consume(batch, handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(batch.messages[0].ack).toHaveBeenCalledOnce();
      expect(batch.messages[0].retry).not.toHaveBeenCalled();
    });

    it('should call retry when handler throws', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler failed'));
      const env = makeEnvelope({ ok: false });
      const batch = mockBatch([{ body: env }]);

      await consume(batch, handler);

      expect(handler).toHaveBeenCalledOnce();
      expect(batch.messages[0].retry).toHaveBeenCalledOnce();
      expect(batch.messages[0].ack).not.toHaveBeenCalled();
    });

    it('should handle multiple messages independently', async () => {
      const handler = vi.fn()
        .mockResolvedValueOnce(undefined)  // first succeeds
        .mockRejectedValueOnce(new Error('fail'));  // second fails

      const batch = mockBatch([
        { body: makeEnvelope({ ok: true }) },
        { body: makeEnvelope({ ok: false }) },
      ]);

      await consume(batch, handler);

      expect(batch.messages[0].ack).toHaveBeenCalledOnce();
      expect(batch.messages[1].retry).toHaveBeenCalledOnce();
    });
  });
});
