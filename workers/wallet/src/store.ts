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
 * The only two **existence** states reconciliation is allowed to write.
 *
 * A narrow union on purpose. `PassTrackingState` also carries `inactive`,
 * `expired` and `completed`, and widening this parameter to it would let a
 * caller record Google's lifecycle transitions from the *per-customer* path,
 * which does not observe them: `reconcilePass` is handed one `objectId` and
 * learns only whether the object is `ACTIVE`. The sweep does observe them, and
 * writes them through `recordPassLifecycle` instead, so the two facts keep the
 * two statements that can enforce them. See `PassLifecycleState`.
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
   * "or clear it" reading would make a lost observation indistinguishable from a
   * deliberate one.
   */
  observedAt: Date;
}

/**
 * A lifecycle state, as distinct from an existence state.
 *
 * ## Why this is a separate union rather than a widening of
 * `ReconciliationState`
 *
 * The two answer different questions and obey different rules, so putting them
 * in one type would mean one of them is documented wrongly.
 *
 * - `ReconciliationState` answers **"does a Google object exist?"** and is
 *   strictly monotonic: once `issued`, only `issued` may be re-asserted, because
 *   a 404 observed after a confirmed 200 is far more likely a propagation
 *   artifact than a customer deleting their pass.
 * - `PassLifecycleState` answers **"what has Google's platform done with the
 *   object that exists?"** and is monotonic only *within* the object-exists
 *   subset. A pass Google deactivated comes back when the customer reactivates
 *   it, so `inactive → issued` is a real transition and the existence rule would
 *   forbid it.
 *
 * `PENDING` is deliberately absent. It means the platform holds an object the
 * user has not activated, which is a positive claim about an object existing —
 * the same reason `objectStateFor` refuses to map it onto `not_issued`. And
 * `STATE_UNSPECIFIED` is absent because it is Google's "no answer", and a
 * tracking state written from it would be a claim we never received.
 */
export type PassLifecycleState = 'inactive' | 'expired' | 'completed';

export interface PassLifecycleUpdate {
  customerId: string;
  tenantId: string;
  /** What Google reported. Narrow: see `PassLifecycleState`. */
  state: PassLifecycleState;
  observedAt: Date;
}

/**
 * A bare observation: Google answered, and the answer is not a state we will
 * record.
 *
 * Deliberately carries no `state`. The caller asserts only that it got a
 * definitive answer, and a statement that could also set `state` would be one
 * line away from inventing a lifecycle value this system has no word for.
 */
export interface PassObservationUpdate {
  customerId: string;
  tenantId: string;
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
   * ## The monotonicity guarantee
   *
   * The states rank weakest to strongest as
   * `not_issued → not_saved → inactive → issued`, with `expired` and `completed`
   * terminal, and the implementation refuses any write that would move a row
   * backwards down that order. That is a monotonicity guarantee, not a
   * formatting preference: a `404` observed after a confirmed `200` is far more
   * likely a propagation or permission artifact than a customer deleting their
   * pass, and a `state` that flaps between `issued` and `not_saved` is worse for
   * support than one that is a day late. See `reconcile.ts`.
   *
   * ## The guard applies to the state alone, and that is deliberate
   *
   * The `state` column is a **claim** about the world, so it is rank-guarded.
   * `last_synced_at` is an **observation** of Google having answered, so it is
   * not: it moves on every call where the row exists, whether or not the state
   * transition was allowed.
   *
   * Those used to be one predicate, `state IN ('not_issued', 'not_saved',
   * 'inactive') OR state = <written>`, and the second clause existed only to
   * keep the timestamp moving for rows already in the state being written. That
   * worked for `issued` and `inactive` and was **wrong for the terminal states**:
   * a row in `expired` or `completed` matched nothing, so a definitive answer
   * about it was discarded. The row then stayed permanently in the sweep's due
   * set, was re-read from Google and the ledger on every single run, and with
   * `MAX_RECONCILES_PER_TENANT` such rows it starved the whole tenant — the
   * same liveness defect `recordPassObservation` exists to fix, reached by a
   * different route. Splitting the claim from the observation is what closes
   * both.
   *
   * @see `recordPassObservation` for the case where there is no claim to make.
   */
  recordPassReconciliation(update: PassReconciliationUpdate): Promise<number>;

  /**
   * Record Google's **lifecycle** answer for an object we already know exists.
   *
   * ## This is the one documented exception to the monotonicity guard, and the
   * guard it replaces
   *
   * `recordPassReconciliation`'s predicate is `state IN ('not_issued',
   * 'not_saved')`, which makes an existence state one-way. A lifecycle state
   * cannot live under that predicate, for two reasons that pull in opposite
   * directions:
   *
   * 1. A pass that is already `issued` is outside the predicate, so a lifecycle
   *    write would silently update **zero rows** — the method would report
   *    success having done nothing, and the sweep would count a lifecycle
   *    observation it never recorded.
   * 2. Widening the predicate to `state NOT IN ('not_issued', 'not_saved')`
   *    would fix (1) and break the existence guarantee by allowing a lifecycle
   *    write to touch a pass whose object existence was never confirmed.
   *
   * So this is a **separate statement with its own predicate**: a lifecycle
   * state may only be written from a row that already asserts the object exists.
   * The invariant that survives is the one that matters — *a lifecycle write can
   * never make a row claim an object exists when it does not* — and it is
   * enforced by the source-state set `('issued', 'inactive')` rather than by the
   * target state.
   *
   * Within that set the transitions are honest rather than monotonic:
   * `inactive → issued` is legal because a customer who reactivates a pass
   * really does have an `ACTIVE` object again, and `expired` and `completed` are
   * terminal because neither appears in the source set, so nothing can move a
   * row off them.
   *
   * ## The return value, and why `void` was not good enough
   *
   * This returns **how many rows it actually changed**, which may be zero.
   *
   * The source set is a genuine possibility, not a formality: `findPassesByObjectIds`
   * resolves rows by object id with no state filter at all, so a row in
   * `not_saved` — written whenever `getObject` 404s, which the codebase
   * describes as "far more likely a propagation artifact" than a customer
   * deleting their pass — is handed to this method whenever its Google object is
   * non-`ACTIVE`. The `UPDATE` matches nothing, and under a `Promise<void>`
   * signature the caller could not tell that from a real write. The sweep then
   * incremented a lifecycle counter for an observation it had never recorded,
   * and because this statement guards `last_synced_at` as well as `state`, the
   * row kept its stale timestamp and stayed permanently due. A method that
   * reports success having done nothing is how a report stops being evidence.
   *
   * A zero here is a **fact about our own data**, not an error: it says a Google
   * object exists for a pass we never confirmed exists. The guard is right to
   * refuse the state change, so the fix is to make the refusal visible rather
   * than to widen the predicate — see `SweepReport.lifecycleWritesSkipped`.
   *
   * The caller is expected to pair a zero with `recordPassObservation`, which
   * stamps the row without claiming anything about its state, so the pass still
   * leaves the due set.
   *
   * @see sweep.ts for the only caller.
   */
  recordPassLifecycle(update: PassLifecycleUpdate): Promise<number>;

  /**
   * Record only that Google answered, changing nothing else.
   *
   * ## The liveness defect this exists to close
   *
   * `reconcilePass` returns `object_not_active` for an object in any state other
   * than `ACTIVE`. For `INACTIVE`, `EXPIRED` and `COMPLETED` the sweep has a
   * lifecycle statement to record it with, but for `PENDING` and
   * `STATE_UNSPECIFIED` — and for any state Google adds to its enum after this
   * was written — `lifecycleStateFor` returns `null` on purpose, because this
   * system has no honest tracking state for them. So there was nothing to write
   * *anywhere*: `last_synced_at` was never refreshed, the pass stayed in the
   * due set for ever, and `getObject` fired again on every single run.
   *
   * That is a cost problem until a tenant holds `MAX_RECONCILES_PER_TENANT` such
   * objects, at which point it is a **starvation**: the run exhausts its budget
   * on rows it can make no progress on, returns `deferred`, and never reaches
   * the rest of the tenant. The report reads as ordinary deferral, so nothing
   * anywhere says the tenant is stuck.
   *
   * The fix is to record the observation without inventing the state. We *did*
   * learn a definitive thing: the object exists, and it is not `ACTIVE`. That
   * is exactly what `last_synced_at` is documented to mean, so it is stamped
   * here while `state` is left alone.
   *
   * ## Why it writes no state at all, rather than a "not active" value
   *
   * The alternatives were a new `PassTrackingState` member, or widening
   * `ReconciliationState`. Both put a word in the schema that no other reader
   * would know the meaning of, and the second one would break the documented
   * reason the two unions are separate at all: `ReconciliationState` answers
   * "does an object exist?", and `PENDING` is a positive claim about existence
   * that the existence path has not confirmed. Leaving `state` alone keeps this
   * method incapable of asserting existence, which is the invariant every
   * guard in this interface exists to protect.
   *
   * No state predicate in the `WHERE` either. A guard here would reintroduce the
   * very starvation this fixes for whatever subset it excluded — including
   * `expired` and `completed`, which a sweep-written lifecycle state produces
   * routinely. The tenant filter stays, because that is a different question:
   * not "is this state allowed" but "may this write cross a tenant boundary".
   */
  recordPassObservation(update: PassObservationUpdate): Promise<number>;

  // -------------------------------------------------------------------------
  // Enumeration, for the scheduled sweep
  // -------------------------------------------------------------------------

  /**
   * One page of the tenants that have a `tenant_wallet_programs` row.
   *
   * ## Why this is paged, and paged by key
   *
   * `SELECT ... FROM tenant_wallet_programs` with no `LIMIT` is the shape of a
   * bug waiting for a customer with 50,000 passes: the row count is small, but
   * it is unbounded, and an unbounded read in a scheduled job is an outage with
   * a delay before it.
   *
   * Keyset rather than `OFFSET`, for the same reason `claimMemberCode` is a
   * compare-and-set rather than a read-then-write: `OFFSET` re-reads and re-sorts
   * every row it skips, so page 900 costs 900 times page 1, and a tenant
   * inserted mid-sweep shifts every subsequent page and makes rows be **skipped
   * entirely**. `tenant_id` is the primary key, so it is unique, immutable and
   * monotonically comparable, which is exactly what a keyset cursor needs.
   *
   * ## This is the one cross-tenant query in this worker
   *
   * It has no tenant to scope to — enumerating the tenants is the point — so it
   * must be called on a session that has **not** set `app.current_tenant_id`.
   * Every other method here requires one. See `sweep.ts` and the RLS note on
   * `drizzle-store.ts`: this query returns no rows at all once the tenant
   * policies are enabled, and giving it a bypass role is a separate change to
   * `packages/db`.
   */
  listProgramTenants(options: {
    /** Hard bound. The implementation must not fetch more than this. */
    limit: number;
    /** `tenant_id` to resume after, or `null` to start at the beginning. */
    afterTenantId: string | null;
  }): Promise<WalletProgramRow[]>;

  /**
   * The pass rows, within one tenant, whose `object_id` is in `objectIds`.
   *
   * ## Why this exists instead of reconciling everything the list returned
   *
   * Google will hold objects this system has no row for — a pass created
   * through the console, a customer restored from a backup under a new id — and
   * reconciling those would need a `customerId` we do not have. Resolving the
   * other way, from our own rows outward, means a Google object is only ever
   * acted on when we hold the row that says which customer it belongs to.
   *
   * ## The tenant filter is the crossing defence
   *
   * `customer_wallet_passes.customer_id` is the primary key, so object ids are
   * tenant-unique in practice — but "in practice" is not a guarantee, and a row
   * written under the wrong tenant would otherwise be patched at Google from
   * this sweep. The predicate carries `tenant_id` so a row belonging to another
   * tenant is simply not returned, and the sweep cannot see it to act on it.
   *
   * Takes a batch rather than the whole set so memory stays bounded on a tenant
   * with 50,000 passes: the caller pages Google's list and resolves one page at
   * a time.
   */
  findPassesByObjectIds(objectIds: string[], tenantId: string): Promise<WalletPassRow[]>;

  /** Write a freshly observed review status and sync timestamp. */
  updateProgramReviewStatus(tenantId: string, reviewStatus: string, syncedAt: Date): Promise<void>;
}
