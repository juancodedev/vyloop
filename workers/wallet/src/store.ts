/**
 * Persistence boundary for the issuance path.
 *
 * The pass model (`class.ts`, `object.ts`, `jwt.ts`, `member-code.ts`) is pure
 * and always was. The moment there are routes, there is also persistence, and
 * the rules that matter most here — tenant scoping, "a member code must exist
 * before a pass is built", "the balance is read, never computed" — are rules
 * about *reads and writes*, not about payload construction. Testing them
 * through a mocked Drizzle builder tests the mock.
 *
 * So the data access sits behind this interface, exactly as the Google client
 * sits behind its interface: the issuance rules are exercised offline against
 * an in-memory store, and `DrizzleWalletStore` is the only place that knows
 * about `points_transactions` or `tenant_wallet_programs`.
 *
 * ## The tenant id in every signature
 *
 * `tenantId` is `tenants.id`, the value the gateway injects as
 * `X-Business-Id`. It appears in **every** method rather than being carried on
 * a context object, so a caller cannot read or write a wallet row without also
 * naming the tenant it believes it is acting for. A method that omitted it
 * would be a method that could only be used correctly by accident.
 */

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The slice of `customers` the pass needs. */
export interface WalletCustomerRow {
  /** `customers.id`. */
  id: string;
  /** `customers.global_id`. Derives the pass id and carries the barcode. */
  globalId: string;
  /** `customers.full_name`. Nullable. */
  fullName: string | null;
  /** `customers.member_code`. Nullable, and the reason for `claimMemberCode`. */
  memberCode: string | null;
  /** `customers.current_tier_id`. Nullable. */
  currentTierId: string | null;
}

/** The slice of `tenant_wallet_programs` the pass needs. */
export interface WalletProgramRow {
  /** `tenant_wallet_programs.tenant_id`, which is also its primary key. */
  tenantId: string;
  /** The Google-issued issuer id. */
  issuerId: string;
  /** The full `<issuerId>.tenant-<tenantId>`. */
  classId: string;
  /**
   * vyloop's own storage form of Google's review status:
   * `none` | `draft` | `under_review` | `approved` | `rejected`.
   *
   * A plain `string` and not a union, deliberately. The column is `text` with no
   * `check` constraint, so the database is the authority on what can be in it
   * and a value this code has never heard of must be handled rather than
   * rejected at the type level. `classReadinessFor` fails closed on anything
   * that is not exactly `approved`.
   */
  reviewStatus: string;
  /** `tenant_wallet_programs.last_synced_at`. Nullable. */
  lastSyncedAt: Date | null;
}

/** The slice of `membership_tiers` the pass needs. */
export interface WalletTierRow {
  /** `membership_tiers.name`. */
  name: string;
}

/** What `POST /v1/wallet/program/sync` needs to write back. */
export interface PassTrackingUpdate {
  /** `customer_wallet_passes.customer_id`, which is the primary key. */
  customerId: string;
  tenantId: string;
  /** The full `<issuerId>.member-<globalId>`. */
  objectId: string;
  /**
   * `last_synced_at`, or null to leave it alone.
   *
   * A pass is recorded with a null `last_synced_at` on the request path
   * because nothing has been synced with Google yet.
   */
  lastSyncedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** The slice of `customer_wallet_passes` the reconciliation path needs. */
export interface WalletPassRow {
  /** `customer_wallet_passes.customer_id`, which is the primary key. */
  customerId: string;
  tenantId: string;
  /** The full `<issuerId>.member-<globalId>`. */
  objectId: string;
  /**
   * vyloop's tracking state.
   *
   * A plain `string` for the same reason `WalletProgramRow.reviewStatus` is:
   * the column is `text` with no `check` constraint, so the database is the
   * authority on what can be in it and a value this code has never heard of must
   * be read rather than rejected at the type level.
   */
  state: string;
  /**
   * The last moment we got a definitive answer from Google about this object.
   *
   * Null means we have never asked, which is what a freshly issued link leaves
   * behind.
   */
  lastSyncedAt: Date | null;
}

/**
 * The only two states reconciliation is allowed to write.
 *
 * A narrow union on purpose. `PassTrackingState` also carries `inactive`,
 * `expired` and `completed`, and widening this parameter to it would let a
 * caller record Google's lifecycle transitions — which this system cannot
 * currently observe honestly, because it never asked Google for the object's
 * state before deciding what the pass is doing. The type is the place that
 * says no, so the compiler says it rather than a reviewer.
 */
export type ReconciliationState = 'not_saved' | 'issued';

export interface PassReconciliationUpdate {
  customerId: string;
  tenantId: string;
  /** The state we observed. Narrow: see `ReconciliationState`. */
  state: ReconciliationState;
  /**
   * The moment Google answered. Always a `Date` rather than `Date | null`:
   * this method is only called once we have a definitive answer, and a nullable
   * "or clear it" reading would make a lost observation indistinguishable from
   * a deliberate one.
   */
  observedAt: Date;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface WalletStore {
  /**
   * Find a customer by `globalId` **within one tenant**.
   *
   * Both halves are load-bearing. The same person is a separate row per
   * merchant, so a lookup on `globalId` alone is a cross-tenant lookup that
   * happens to be one of many equally valid answers. `null` covers "no such
   * person", "no such person at this merchant" and "no longer an active
   * member" identically, so the caller cannot turn the answer into an
   * existence oracle.
   */
  findCustomer(globalId: string, tenantId: string): Promise<WalletCustomerRow | null>;

  /** Re-read a customer by primary key within one tenant. */
  findCustomerById(customerId: string, tenantId: string): Promise<WalletCustomerRow | null>;

  /** The tenant's Google program record, or `null` when it has no class row. */
  findProgram(tenantId: string): Promise<WalletProgramRow | null>;

  /**
   * The tenant's points currency, `loyalty_programs.points_currency`.
   *
   * `null` when the tenant has no program row at all, which is a real state
   * during onboarding: a loyalty program is configured separately from a
   * Google class, and a tenant can have one without the other.
   */
  findPointsCurrency(tenantId: string): Promise<string | null>;

  /** The name of a membership tier within one tenant, or `null`. */
  findTierName(tierId: string, tenantId: string): Promise<WalletTierRow | null>;

  /**
   * The customer's current balance, read from the ledger.
   *
   * `points_transactions.balance_after` of the most recent transaction, which
   * is the same definition `workers/growth` and `workers/customer` use. Zero
   * when the customer has no transactions: a member who has never earned is a
   * balance of zero, not a missing balance, and a pass that refuses to render
   * for a new member would be wrong.
   *
   * This method computes nothing. The pass is a projection of the ledger, and
   * the single most damaging change to this worker would be a "helpfully"
   * summed balance computed here.
   */
  latestBalance(customerId: string, tenantId: string): Promise<number>;

  /**
   * Is this member code already taken within the tenant?
   *
   * The tenant-scoped existence check `member-code.ts` retries against. The
   * partial unique index on `(business_id, member_code)` is still the real
   * guard; this only turns the rare collision into one more round trip.
   */
  isMemberCodeTaken(tenantId: string, code: string): Promise<boolean>;

  /**
   * Write `code` onto the customer **only if they have no code yet**, and
   * return the value that is now stored.
   *
   * A compare-and-set, not an unconditional update. Two concurrent first pass
   * requests both derive a candidate, both find it free, and both would
   * happily overwrite each other without this. The `WHERE member_code IS NULL`
   * makes the write safe without catching a unique-violation, and guarantees
   * a code a customer already holds is never replaced — which is the whole
   * point of storing it rather than deriving it on read.
   *
   * The return value is the post-condition, not the input: the caller must
   * build the pass from what was actually stored, so a lost race produces the
   * winner's code rather than this request's discarded candidate.
   */
  claimMemberCode(customerId: string, tenantId: string, code: string): Promise<string | null>;

  /**
   * Record that this customer has a pass planned for this tenant.
   *
   * Insert when absent; update `object_id` only while the pass has never been
   * issued. `customer_wallet_passes.state` is **never** written here: handing
   * out a save link does not create a Google object, so advancing the tracking
   * state to `issued` would assert a pass the customer does not have yet. See
   * `issuance.ts`.
   */
  recordPass(update: PassTrackingUpdate): Promise<void>;

  /**
   * Read this customer's pass row for this tenant.
   *
   * Reconciliation patches the `object_id` stored here rather than one derived
   * again from `customers.global_id`. The two agree today — `ids.ts`
   * guarantees it — but the row is the record of what was actually issued, and
   * reconciling a *derived* id would quietly reconcile a pass this system never
   * handed out if the two ever diverged.
   */
  findPass(customerId: string, tenantId: string): Promise<WalletPassRow | null>;

  /**
   * Record a definitive observation from Google about this customer's object.
   *
   * The implementation is guarded so `state` only ever moves from `not_issued`
   * or `not_saved`. That is a monotonicity guarantee, not a formatting
   * preference: a `404` observed after a confirmed `200` is far more likely a
   * propagation or permission artifact than a customer deleting their pass, and
   * a `state` that flaps between `issued` and `not_saved` is worse for support
   * than one that is a day late. See `reconcile.ts`.
   */
  recordPassReconciliation(update: PassReconciliationUpdate): Promise<void>;

  /** Write a freshly observed review status and sync timestamp. */
  updateProgramReviewStatus(tenantId: string, reviewStatus: string, syncedAt: Date): Promise<void>;
}
