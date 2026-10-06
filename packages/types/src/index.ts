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

// ============================================================================
// The customer PATCH contract
// ============================================================================
// This list lives here, and only here, because two processes have to agree on
// it for a write to mean anything.
//
// `PATCH /v1/customers/:id` used to spread the whole request body into the
// UPDATE, so the set of writable columns was "whatever the caller typed" —
// `globalId` included, and `globalId` is half of the Google Wallet `objectId`
// (`<issuerId>.member-<globalId>`), so a merchant could orphan the pass already
// sitting on a customer's phone. The server now refuses everything outside this
// list, out loud, and the dashboard's edit form reads the same four names.
//
// The failure this single source prevents is worse than a crash: if the server
// accepted `fullName` while the form sent `full_name`, the PATCH would succeed,
// write nothing, and the operator would leave believing the name changed.
// A duplicated string cannot drift like that, because there is only one string.
//
// Why these four and not the rest of `customers`: they are the fields a person
// at a counter can legitimately correct with the customer in front of them. The
// remaining columns are either identity (`globalId`, `id`, `memberCode`,
// `currentTierId`), lifecycle bookkeeping (`createdAt`, `deletedAt`, `optedInAt`,
// `lastVisitAt`), or internal (`metadata`, `identityDoc`, `identityType`,
// `language`) — none of them is a typo an operator makes on purpose.
export const CUSTOMER_PATCHABLE_FIELDS = ['fullName', 'phone', 'email', 'birthDate'] as const;

export type CustomerPatchableField = (typeof CUSTOMER_PATCHABLE_FIELDS)[number];

/**
 * A partial edit.
 *
 * `undefined` means "the caller did not mention this column" and is never
 * written, which is what keeps a partial PATCH from blanking a field nobody
 * touched. `null` means "clear it", and is the only way to empty a nullable
 * column — it has to be spelled, so an untouched input cannot wipe one by
 * accident.
 */
export type CustomerPatch = Partial<Record<CustomerPatchableField, string | null>>;

/**
 * Why a PATCH was refused, as codes both sides compare against.
 *
 * `NOT_PATCHABLE` is the one this whole contract exists to produce: the caller
 * named a column that is not editable and is told so, instead of watching it be
 * ignored. `PHONE_TAKEN` / `EMAIL_TAKEN` are what `uq_customers_business_phone`
 * and `uq_customers_business_email` surface, translated into something an
 * operator can act on rather than a 500.
 *
 * Shared because the dashboard branches on them to decide whether to show the
 * message beside the offending input — a literal retyped on the frontend is the
 * same drift risk as a retyped field name.
 */
export const CUSTOMER_PATCH_ERROR = {
  /** A named column is not editable through this endpoint. */
  NOT_PATCHABLE: 'CUSTOMER_FIELD_NOT_PATCHABLE',
  /** An editable column was given something other than a string or null. */
  INVALID_VALUE: 'CUSTOMER_FIELD_INVALID',
  /** The body was syntactically fine but named no editable column at all. */
  EMPTY: 'CUSTOMER_PATCH_EMPTY',
  /** Another customer of this business already holds that phone. */
  PHONE_TAKEN: 'CUSTOMER_PHONE_TAKEN',
  /** Another customer of this business already holds that email. */
  EMAIL_TAKEN: 'CUSTOMER_EMAIL_TAKEN',
  /**
   * A unique index this route has no dedicated message for.
   *
   * Kept distinct from the two above on purpose: the dashboard cannot blame a
   * specific input for a constraint it cannot name, and reporting it as
   * `PHONE_TAKEN` would point the operator at a field that is fine.
   */
  CONFLICT: 'CUSTOMER_CONFLICT',
} as const;

export type CustomerPatchErrorCode = (typeof CUSTOMER_PATCH_ERROR)[keyof typeof CUSTOMER_PATCH_ERROR];
