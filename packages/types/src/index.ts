// Branded types for domain primitives
// Enforces type-level safety across bounded contexts

declare const __brand: unique symbol;
type Brand<T extends string> = { [__brand]: T };

export type TenantId = string & Brand<'TenantId'>;
export type UserId = string & Brand<'UserId'>;
export type CustomerId = string & Brand<'CustomerId'>;

export interface BaseEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: Date;
  tenantId: TenantId;
  correlationId: string;
  data: T;
}

export interface Entity {
  id: string;
  tenantId: TenantId;
  createdAt: Date;
  updatedAt: Date;
}
