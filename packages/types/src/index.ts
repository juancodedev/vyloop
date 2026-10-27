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
 * What a customer may change about themselves from the customer app.
 *
 * The staff list minus `phone`: the phone is how the counter finds the
 * customer and how they sign in, so changing it is a staff decision made with
 * the person in front of them.
 */
export const CUSTOMER_SELF_PATCHABLE_FIELDS = ['fullName', 'email', 'birthDate'] as const;

export type CustomerSelfPatchableField = (typeof CUSTOMER_SELF_PATCHABLE_FIELDS)[number];

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

export type CustomerPatchErrorCode =
  (typeof CUSTOMER_PATCH_ERROR)[keyof typeof CUSTOMER_PATCH_ERROR];

// ---------------------------------------------------------------------------
// Subject kinds
// ---------------------------------------------------------------------------
// This lives here, and only here, for the same reason `CUSTOMER_PATCHABLE_FIELDS`
// does: two processes have to agree on it for a decision to mean anything.
//
// `workers/growth` has refused customer and counter tokens on operator routes
// since PR #203. `workers/identity` needs the same refusal for the routes that
// manage a business's branches. Both answers have to be the same answer — a
// policy that two workers compute separately is a policy that will drift, and
// this one decides who may write a business's configuration.
//
// The three kinds of subject are:
//   - a **customer**, holding the customer app's token;
//   - a **counter**, a merchant's payment terminal at the till;
//   - an **operator**, everything else — the staff who administer the business.
//
// The predicates below are deliberately phrased as questions rather than as
// allow-lists of roles. `role` is free-form text the issuer never enumerates,
// so an allow-list would have to invent a vocabulary the issuer does not define
// and would refuse every role added after it was written. Asking "is this the
// customer app's token?" and "is this a counter?" cannot drift that way.
//
// The honest cost, which is deliberate: the pair fails **open** on a fourth kind
// of subject nobody has thought to ask about, where an allow-list fails closed.
// A new kind of subject needs its question added, and the counter is what that
// cost bought.

/** The role the customer app's token carries. */
export const CUSTOMER_ROLE = 'customer';

/**
 * The namespace a counter's token subject lives in: `pos:<terminalId>`.
 *
 * The colon is the separator that makes the namespace unambiguous: it cannot
 * appear in a uuid, and it is not a character any of the look-alikes contain.
 * Case-sensitive on top of that, so `POS:` is not a counter.
 */
export const COUNTER_SUBJECT_PREFIX = 'pos:';

/** Stable, specific code. Callers can branch on this without parsing prose. */
export const OPERATOR_ROLE_REQUIRED = 'OPERATOR_ROLE_REQUIRED';

export type OperatorRoleGuard =
  { ok: true } | { ok: false; status: 403; code: string; message: string };

/**
 * Is this the customer app's own token?
 *
 * Takes the role alone rather than an auth-headers object, so a worker that
 * reads the role from a JWT claim and a worker that reads it from an injected
 * header are asking the identical question of the identical value.
 */
export function isCustomerRole(userRole: string): boolean {
  return userRole === CUSTOMER_ROLE;
}

/**
 * Is this a merchant's payment terminal?
 *
 * A counter is a *third* kind of subject, so this is not `!isCustomerRole` and
 * not its mirror image. It asks one question about the subject and refuses
 * everything else.
 *
 * The remainder after the prefix is opaque. It is not looked up, not parsed, and
 * not compared to anything: there is no `pos_terminals` row behind it that
 * could tell a terminal that exists from one that does not.
 */
export function isCounterSubject(userId: string): boolean {
  // The empty remainder is refused on purpose: `pos:` with nothing behind it is
  // a marker with no terminal in it, and accepting it would make the prefix
  // alone sufficient to act as a merchant's terminal.
  return userId.startsWith(COUNTER_SUBJECT_PREFIX) && userId.length > COUNTER_SUBJECT_PREFIX.length;
}

/**
 * Refuse everything that is not an operator.
 *
 * The message is a parameter because it is route-specific: the growth routes
 * that call this are about the loyalty program, and the identity routes that
 * call it are about a business's branches. What they share is the *decision*,
 * and a decision shared as prose would be a second thing to drift.
 */
export function requireOperatorRole(
  auth: { userId: string; userRole: string },
  message: string,
): OperatorRoleGuard {
  if (isCustomerRole(auth.userRole) || isCounterSubject(auth.userId)) {
    return {
      ok: false,
      status: 403,
      code: OPERATOR_ROLE_REQUIRED,
      message,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Consent types
// ---------------------------------------------------------------------------
// A name that two processes spell differently is a name that means nothing, and
// a consent is exactly the kind of thing that is written by one process and
// read by another: the customer app records it, the communication worker
// refuses a message without it, the automation engine filters on it.
//
// The list is closed on purpose. A type nobody recognises is a consent nobody
// can honour, so an unknown one is rejected rather than stored: a client that
// sends a typo should be told, not left believing it recorded something.

/** The consents this platform knows how to ask for and honour. */
export const CONSENT_TYPES = ['whatsapp', 'nearby_notifications', 'promotions'] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

/** Is this a consent type the platform knows? */
export function isConsentType(value: unknown): value is ConsentType {
  return typeof value === 'string' && (CONSENT_TYPES as readonly string[]).includes(value);
}

/**
 * The product limits for a manual wallet message, declared once so the form and
 * the route cannot disagree (decided Q4: 40 / 300).
 */
export const WALLET_MESSAGE_LIMITS = {
  header: { min: 1, max: 40 },
  body: { min: 1, max: 300 },
} as const;

/** A consent the caller asked for, with whether they granted it. */
export interface ParsedConsent {
  consentType: ConsentType;
  granted: boolean;
}

export type ConsentParseResult =
  { ok: true; consents: ParsedConsent[] } | { ok: false; message: string };

/**
 * Read a `consents` object as the caller sent it.
 *
 * An absent object is not an error: it means the caller did not mention any
 * consent, and a consent nobody mentioned is left alone rather than revoked.
 *
 * An **unknown type is an error**, not something to skip. A client that sends a
 * typo would otherwise be told it recorded a consent, and the platform would
 * hold a consent nobody can honour — which is worse than a rejected request,
 * because the request that follows the rejection is the one that matters.
 */
export function parseConsentTypes(value: unknown): ConsentParseResult {
  if (value === undefined || value === null) {
    return { ok: true, consents: [] };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      message: `consents must be an object of consent type to boolean. Known types: ${CONSENT_TYPES.join(', ')}.`,
    };
  }

  const consents: ParsedConsent[] = [];
  for (const [key, granted] of Object.entries(value as Record<string, unknown>)) {
    if (!isConsentType(key)) {
      return {
        ok: false,
        message: `unknown consent type "${key}". Known types: ${CONSENT_TYPES.join(', ')}.`,
      };
    }
    if (typeof granted !== 'boolean') {
      return { ok: false, message: `consent "${key}" must be true or false.` };
    }
    consents.push({ consentType: key, granted });
  }

  return { ok: true, consents };
}
