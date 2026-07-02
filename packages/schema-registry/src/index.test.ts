import { describe, it, expect, beforeEach } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import {
  getSchema,
  registerSchema,
  validate,
  clearCache,
  customerRegisteredSchema,
} from './index';

// ---------------------------------------------------------------------------
// In-memory KV mock (covers the KVNamespace subset used by the registry)
// ---------------------------------------------------------------------------
class MemKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// Patch type — MemKV structurally matches the KVNamespace subset we use
const kv = new MemKV() as unknown as KVNamespace;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const purchaseSchema = {
  $id: 'https://schema.vyloop.app/events/purchase_completed/v1',
  type: 'object',
  required: ['header', 'payload'],
  properties: {
    header: {
      type: 'object',
      required: ['event_id', 'event_type'],
      properties: {
        event_id: { type: 'string', format: 'uuid' },
        event_type: { type: 'string', const: 'purchase_completed' },
      },
    },
    payload: {
      type: 'object',
      required: ['customer_id', 'amount', 'items'],
      properties: {
        customer_id: { type: 'string', format: 'uuid' },
        amount: { type: 'number', exclusiveMinimum: 0 },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['name', 'quantity', 'unit_price'],
            properties: {
              name: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
              unit_price: { type: 'number', exclusiveMinimum: 0 },
            },
          },
        },
      },
    },
  },
};

const validPayload = {
  header: {
    event_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    event_type: 'purchase_completed',
  },
  payload: {
    customer_id: '12345678-1234-1234-1234-123456789abc',
    amount: 49.99,
    items: [
      { name: 'Café Latte', quantity: 2, unit_price: 4.5 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaRegistry', () => {
  beforeEach(() => {
    clearCache();
  });

  describe('registerSchema', () => {
    it('should store schema under type:latest and type:version', async () => {
      await registerSchema(kv, 'purchase_completed', purchaseSchema, '1.0.0');

      const latest = await kv.get('purchase_completed:latest');
      expect(latest).not.toBeNull();

      // Explicit version is used when provided
      const versioned = await kv.get('purchase_completed:1.0.0');
      expect(versioned).not.toBeNull();

      // Both keys should hold the same schema
      expect(JSON.parse(latest!)).toEqual(purchaseSchema);
      expect(JSON.parse(versioned!)).toEqual(purchaseSchema);
    });

    it('should extract version from $id when version not provided', async () => {
      const schema = {
        $id: 'https://schema.vyloop.app/events/test_event/v1.2.0',
        type: 'object',
        properties: { message: { type: 'string' } },
      };
      await registerSchema(kv, 'test_event', schema);

      // Should extract 1.2.0 from the $id
      const versioned = await kv.get('test_event:1.2.0');
      expect(versioned).not.toBeNull();
    });
  });

  describe('getSchema', () => {
    it('should return null when schema is not registered', async () => {
      const result = await getSchema(kv, 'non_existent_type');
      expect(result).toBeNull();
    });

    it('should return the schema when it exists', async () => {
      await registerSchema(kv, 'purchase_completed', purchaseSchema);
      const result = await getSchema(kv, 'purchase_completed');
      expect(result).toEqual(purchaseSchema);
    });
  });

  describe('customerRegisteredSchema', () => {
    it('should be exported with correct structure', async () => {
      const mod = await import('./index');
      expect(mod.customerRegisteredSchema).toBeDefined();
      expect(mod.customerRegisteredSchema.title).toBe('CustomerRegistered');
      expect(mod.customerRegisteredSchema.required).toEqual(['customer_id', 'full_name', 'business_id']);
      expect(mod.customerRegisteredSchema.properties.customer_id.format).toBe('uuid');
      expect(mod.customerRegisteredSchema.properties.full_name.minLength).toBe(1);
      expect(mod.customerRegisteredSchema.properties.business_id.format).toBe('uuid');
    });

    it('should pass validation for a valid CustomerRegistered payload', async () => {
      await registerSchema(kv, 'CustomerRegistered', customerRegisteredSchema, '1.0.0');

      const result = await validate(kv, 'CustomerRegistered', {
        customer_id: '123e4567-e89b-12d3-a456-426614174000',
        full_name: 'Alice García',
        business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should fail validation for a payload missing full_name', async () => {
      await registerSchema(kv, 'CustomerRegistered', customerRegisteredSchema, '1.0.0');

      const result = await validate(kv, 'CustomerRegistered', {
        customer_id: '123e4567-e89b-12d3-a456-426614174000',
        business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      });

      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.includes("full_name"))).toBe(true);
    });

    it('should fail validation for invalid uuid format in customer_id', async () => {
      await registerSchema(kv, 'CustomerRegistered', customerRegisteredSchema, '1.0.0');

      const result = await validate(kv, 'CustomerRegistered', {
        customer_id: 'not-a-uuid',
        full_name: 'Alice García',
        business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      });

      expect(result.valid).toBe(false);
    });

    it('should fail validation for empty full_name (minLength 1)', async () => {
      await registerSchema(kv, 'CustomerRegistered', customerRegisteredSchema, '1.0.0');

      const result = await validate(kv, 'CustomerRegistered', {
        customer_id: '123e4567-e89b-12d3-a456-426614174000',
        full_name: '',
        business_id: 'b0a1c2d3-e4f5-6789-abcd-ef0123456789',
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('validate', () => {
    it('should return valid:true for a valid payload', async () => {
      await registerSchema(kv, 'purchase_completed', purchaseSchema);
      const result = await validate(kv, 'purchase_completed', validPayload);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should return valid:false + errors for an invalid payload', async () => {
      await registerSchema(kv, 'purchase_completed', purchaseSchema);
      const badPayload = {
        header: { event_id: 'not-a-uuid' },
        payload: { amount: -5 },
        // missing customer_id, items, event_type
      };
      const result = await validate(kv, 'purchase_completed', badPayload);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should return error when schema is not found', async () => {
      const result = await validate(kv, 'ghost_event', {});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Schema not found for event type: "ghost_event"');
    });

    it('should cache compiled validator and still work on second call', async () => {
      await registerSchema(kv, 'purchase_completed', purchaseSchema);

      // First call — compiles and caches
      const r1 = await validate(kv, 'purchase_completed', validPayload);
      expect(r1.valid).toBe(true);

      // Second call — uses cache
      const r2 = await validate(kv, 'purchase_completed', validPayload);
      expect(r2.valid).toBe(true);
    });
  });
});
