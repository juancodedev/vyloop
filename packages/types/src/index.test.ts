import { describe, it, expect } from 'vitest';
import type { TenantId, UserId, CustomerId, BaseEvent, Entity } from './index';

describe('branded types', () => {
  it('should be assignable from string via assertion', () => {
    const tenantId = 'tenant-abc' as TenantId;
    const userId = 'user-123' as UserId;
    const customerId = 'cust-456' as CustomerId;

    expect(typeof tenantId).toBe('string');
    expect(typeof userId).toBe('string');
    expect(typeof customerId).toBe('string');
  });

  it('should reject plain string assignment at type level', () => {
    // @ts-expect-error - plain string is not assignable to branded TenantId
    const _fail: TenantId = 'plain-string';
  });
});

describe('BaseEvent', () => {
  it('should construct with all required fields', () => {
    const event: BaseEvent = {
      id: 'evt-001',
      type: 'user.created',
      timestamp: new Date('2025-01-01T00:00:00Z'),
      tenantId: 'tenant-1' as TenantId,
      correlationId: 'corr-001',
      data: {},
    };
    expect(event.type).toBe('user.created');
    expect(event.tenantId).toBe('tenant-1');
  });
});

describe('Entity', () => {
  it('should construct with required fields', () => {
    const entity: Entity = {
      id: 'ent-001',
      tenantId: 'tenant-1' as TenantId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(entity.id).toBe('ent-001');
  });
});
