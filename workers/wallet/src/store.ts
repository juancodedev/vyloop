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
   * that is not exactly `approved`, unless the class id carries Google's
   * demo-mode marker — the one other shape Google accepts an object against.
   */
  reviewStatus: string;
  /**
   * `tenant_wallet_programs.demo_mode`. Whether this tenant is still inside
   * Google's demo mode, declared per business by an operator.
   *
   * Optional on the type because a row written before the column existed, or by
   * a query that has not been updated, must not read as "not in demo mode".
   *
   * **This is not read by `classReadinessFor`.** It answers *who receives the
   * pass* — Google's demo-mode issuers only deliver to their own test accounts —
   * not *whether the object can be created*, which Google answers from
   * `reviewStatus` and from whether the class id carries the demo marker. The
   * gate used to read this column and wave unapproved classes through, which is
   * what left two production tenants unable to issue. Read by the operator
   * console and the inactivity sweep instead.
   */
  demoMode?: boolean;
  /**
   * `tenant_wallet_programs.pass_inactivity_months`. Months of customer
   * inactivity after which this tenant's passes are deactivated automatically.
   *
   * Optional on the type for the same reason `demoMode` is: a row written before
   * the column existed, or read by a query that has not been updated, must not
   * read as "this tenant wants their cards muted". `null` and `undefined` both
   * mean the rule is off, and so does a value of `0` or less — see
   * `inactivity.ts`, where that is enforced rather than assumed.
   */
  passInactivityMonths?: number | null;
  /** `tenant_wallet_programs.last_synced_at`. Nullable. */
  lastSyncedAt: Date | null;
}

/**
 * A program row plus the business it belongs to.
 *
 * Extends rather than replaces `WalletProgramRow`, and that is the point: the
 * base type means "what `tenant_wallet_programs` holds" and stays exactly that, so
 * `listProgramTenants` can keep returning it without claiming fields it does not
 * read. This type means "and here is the joined business identity", which is only
 * true of the one read that joins.
 *
 * Both fields are nullable, and `null` means "there was no `tenants` row to join"
 * — see `findProgramWithBusiness` for why the read is a LEFT JOIN and why that
 * distinction has to survive into the type. `businessSlug` is `notNull` in the
 * schema but is `text` with no check constraint, so a blank string is a value the
 * column really holds and is passed through as such rather than normalised here.
 */
export interface WalletProgramWithBusinessRow extends WalletProgramRow {
  /** `tenants.name`. `null` when there is no tenant row to join. */
  businessName: string | null;
  /**
   * `tenants.slug`, verbatim. `null` when there is no tenant row to join; a blank
   * string when the column is blank. Callers must treat both as "no public page",
   * and neither as a slug they may put in a URL.
   */
  businessSlug: string | null;
}

/**
 * One pass this tenant's inactivity rule would deactivate.
 *
 * `lastActivityAt` is `null` for a customer who has never had a ledger movement,
 * in which case the clock that decides is their enrolment date — see
 * `isInactiveSince`. Carrying it rather than a pre-computed verdict is what lets
 * the report show *why* a pass was chosen.
 */
export interface InactivityCandidateRow {
  customerId: string;
  objectId: string;
  /** Latest `points_transactions.created_at` for this customer, or `null`. */
  lastActivityAt: Date | null;
}

/**
 * A pass whose holder has granted `nearby_notifications`.
 *
 * Only the two ids: the sync patch reads nothing else, and widening the row
 * would make every caller depend on columns it does not use.
 */
export interface ConsentingPassRow {
  /** `customers.id` — the key every consent reader uses. */
  customerId: string;
  /** `customer_wallet_passes.object_id`, the Google object to patch. */
  objectId: string;
}

/** The slice of `membership_tiers` the pass needs. */
export interface WalletTierRow {
  /** `membership_tiers.name`. */
  name: string;
}

/**
 * The tenant's own name, country and slug — what a Google class is branded with
 * and where its `homepageUri` points.
 *
 * Read by provisioning and by nothing else on the issuance path: a pass carries
 * the merchant's name because Google copied it into the class at signup, not
 * because any request re-reads the tenant row.
 */
export interface WalletTenantBrandingRow {
  /** `tenants.name`. Google's display may ellipsise after 20 characters. */
  name: string;
  /** `tenants.country`. ISO 3166-1 alpha-2, free text in the column. */
  country: string;
  /**
   * `tenants.slug` — the tenant's own public identifier.
   *
   * Read, never derived. `homepageUri` is `{webBaseUrl}/p/{slug}`, and that
   * page is a real route in the gateway that resolves this exact column. A slug
   * reconstructed from `name` at provision time would be a *guess*: `slugify`
   * truncates at a word boundary and the unique index settles collisions, so two
   * businesses called "Café Central" do not both end up at `cafe-central`, and
   * the slug a merchant actually owns is the one in this row.
   *
   * Absent rather than blank when the tenant has none. A blank slug would build
   * `/p/`, which is a 404 on the one field Google rejects a class over.
   */
  slug: string;
}

/**
 * What a new tenant's `tenant_wallet_programs` row is.
 *
 * `classId` travels as a value rather than being derived by the store, because
 * the same derivation has to produce the id sent to Google and the id stored, and
 * two derivations are two answers. The caller holds both halves.
 */
export interface ProgramInsert {
  tenantId: string;
  /** `tenant_wallet_programs.issuer_id`. Google's issuer id. */
  issuerId: string;
  /** `<issuerId>.tenant-<tenantId>`. */
  classId: string;
  /**
   * vyloop's storage form of the review status. Always passed explicitly.
   *
   * The column's default is `'none'`, which means "this tenant has no class" and
   * fails the readiness gate closed — for a tenant that does have one. A caller
   * that omitted this would write a row that looks provisioned and cannot issue
   * a pass, with no error anywhere.
   */
  reviewStatus: string;
  /**
   * `demo_mode`. True for a new tenant, because this deployment has no Google's
   * publishing approval and a pass without it only reaches the issuer's own test
   * accounts.
   */
  demoMode: boolean;
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
// Google Wallet callbacks
// ---------------------------------------------------------------------------

/**
 * What a tenant's program row looks like when reached **by class id**.
 *
 * Deliberately not `WalletProgramRow`. This is the only read in the interface
 * that exists to answer "which tenant does this Google class belong to?", and it
 * runs before any tenant is known — the callback carries a `classId` and nothing
 * that names a tenant. Returning the full program row would invite a caller to
 * read `reviewStatus` from a row it reached cross-tenant.
 */
export interface WalletTenantByClassIdRow {
  /** `tenants.id`, resolved from `tenant_wallet_programs.class_id`. */
  tenantId: string;
}

/**
 * What one callback says, and what we will do about it.
 *
 * A dedicated union rather than a reuse of `PassTrackingState`: that type is
 * `text`-backed and open, so widening it here would let a future state be
 * written from a callback without anyone deciding what it means. This is narrow
 * to the two existence states a callback can assert, and to the *event* that
 * produced it.
 */
export type PassCallbackWrite = {
  customerId: string;
  tenantId: string;
} & ({ eventType: 'save' } | { eventType: 'del' });

export interface PassCallbackClaim {
  /** `tenants.id`, resolved from the callback's `classId`. */
  tenantId: string;
  /** Google's `nonce`, verbatim. See the note on the column. */
  nonce: string;
  /** Google's `eventType`. Recorded for support; decides nothing here. */
  eventType: string;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface WalletStore {
  /**
   * Get the Google Wallet issuer ID for this tenant.
   * This is the Google-issued issuer ID for the wallet program.
   */
  getIssuerId(): Promise<string>;

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
   * The same program row, joined to the tenant's own name and slug.
   *
   * ## Why this is a second read and not a wider `findProgram`
   *
   * `findProgram` is not the only reader of `PROGRAM_COLUMNS`. `listProgramTenants`
   * is, and that method is the **cross-tenant provisioning sweep**: one keyset page
   * of every tenant that has a class, walked in primary-key order with a hard
   * bound on the page. Adding the two business columns to the shared projection
   * would put a `tenants` join inside that sweep, and the two possible joins fail
   * in opposite directions. An INNER JOIN would silently *drop* program rows from
   * provisioning — the sweep would skip a merchant and report itself healthy. A
   * LEFT JOIN would be correct but still widens the projection for two callers
   * that have no use for a merchant's name, and `listProgramTenants` is declared
   * to return `WalletProgramRow[]`, so the fields would have to sit on a row type
   * that read does not populate: a type lying about its own contents.
   *
   * The asymmetry is the reason this can be a separate method at all. `findProgram`
   * is a **single-tenant, at-most-one-row** read, so a join there cannot change
   * the cardinality of anything and costs one index lookup. The join is free where
   * it is needed and confined to where it is harmless.
   *
   * ## Why the joined columns are nullable while the program's are not
   *
   * `tenant_wallet_programs.tenant_id` does reference `tenants.id`, so under
   * referential integrity a program row always has a tenant row and both columns
   * are `notNull`. The nullability is not paranoia about the schema; it is about
   * the *read*. An INNER JOIN cannot distinguish "this tenant has no branding
   * row" from "this tenant has no program row", and it would report the first as
   * the second — a 404 on the operator console and on the pass route, with the
   * readiness gate reading a missing program as demo mode. A LEFT JOIN keeps the
   * program row intact and reports only the branding as absent, so the blast
   * radius of a missing name is a missing name.
   *
   * A blank slug is a different state from an absent one and is passed through
   * as the blank string it is. `tenants.slug` is `notNull` with no check
   * constraint, so `''` is reachable and `provision.ts` already treats it as a
   * real condition (`tenant_slug_missing`). Collapsing blank into `null` here would
   * take away the caller's ability to say which of the two happened.
   */
  findProgramWithBusiness(tenantId: string): Promise<WalletProgramWithBusinessRow | null>;

  /**
   * Give a tenant its `tenant_wallet_programs` row.
   *
   * The second half of provisioning, and the half whose failure is
   * recoverable: by the time it runs, the class exists at Google, so a failure
   * leaves an orphan class rather than a lie about one. The next attempt finds
   * the 409 and writes this row, which is why `ON CONFLICT` does nothing rather
   * than overwriting.
   */
  insertProgram(program: ProgramInsert): Promise<void>;

  /**
   * The tenant's own name and country — what a Google class is branded with.
   *
   * `null` for a tenant that does not exist, which is not a state provisioning
   * can paper over: there is nothing truthful to put in a class's header, and a
   * placeholder name reaches a real customer's phone.
   */
  findTenantBranding(tenantId: string): Promise<WalletTenantBrandingRow | null>;

  /**
   * `loyalty_programs.name` for this tenant, or `null`.
   *
   * `null` is a real state — a tenant can have a business and no program yet —
   * and also covers a blank name. Google requires `programName`, so this is the
   * difference between "nothing to build" and "a class with an empty program".
   */
  findProgramName(tenantId: string): Promise<string | null>;

/**
   * `loyalty_programs.points_currency`, e.g. `puntos`.
   *
   * `null` when the tenant has no program row at all, which is a real state
   * during onboarding: a loyalty program is configured separately from a
   * Google class, and a tenant can have one without the other.
   */
  findPointsCurrency(tenantId: string): Promise<string | null>;

  /**
   * `loyalty_programs.promo_copy`: the merchant's own sentence about what the
   * programme is for.
   *
   * `null` for a merchant who has written none, which is most of them today.
   * That is the point of the nullable column: the pass carries no promo row
   * rather than one carrying a default sentence the merchant never wrote, which
   * is the same "omitted, never substituted" rule `findProgramName` follows for
   * a blank name.
   */
  findPromoCopy(tenantId: string): Promise<string | null>;

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
   * One page of the tenants that have **no** `tenant_wallet_programs` row.
   *
   * ## Why this exists, given `listProgramTenants` exists
   *
   * `listProgramTenants` reads the program table, so it can only ever return a
   * tenant that already has a class. The tenants that need one are precisely the
   * ones it cannot see: provisioning runs off the signup response under
   * `waitUntil`, which has no durability guarantee, so a business can be
   * registered with no row and no class. An enumeration of the program table is
   * blind to them by construction — not slow to reach them, unable to name them.
   *
   * ## It reads `tenants`, not the program table
   *
   * The roster is the root table: `tenants` is deliberately absent from
   * `BUSINESS_ID_TABLES` in `packages/db`, because it is the table every other
   * table's `business_id` points at and scoping it by itself would be circular.
   * The answer therefore comes from an anti-join — every tenant, minus the ones a
   * program row exists for — and this is the second cross-tenant query in this
   * worker, for the same reason as the first: there is no tenant to scope to when
   * the question is which tenants there are.
   *
   * ## Keyset, for the reason `listProgramTenants` is keyset
   *
   * `tenants.id` is a uuid primary key: unique, immutable and totally ordered, so
   * `>` is an exact cursor and no `OFFSET` is involved. The order is also the
   * budget's fairness — see `MAX_PROVISION_PER_RUN`.
   *
   * ## RLS
   *
   * **This returns no rows at all once the tenant policies are enabled**, the same
   * gap `listProgramTenants` documents, and for the same reason: the sweep runs on
   * a bare session with no `app.current_tenant_id`, and a policy keyed on that
   * variable admits no rows to it.
   *
   * Stated rather than left to be discovered, because the failure mode is silence:
   * the sweep would report zero unprovisioned tenants, every counter would read as
   * healthy, and the businesses that need a class would stay without one. Giving
   * these two queries a bypass role is a change to `packages/db` and a separate
   * decision.
   */
  listTenantsWithoutProgram(options: {
    /** Hard bound. The implementation must not fetch more than this. */
    limit: number;
    /** `tenants.id` to resume after, or `null` to start at the beginning. */
    afterTenantId: string | null;
  }): Promise<string[]>;

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

  /**
   * The passes in **one tenant** that no ledger movement inside `cutoff` covers.
   *
   * ## The one query this rule is allowed to ask
   *
   * Everything the pass-inactivity rule decides comes from here. It is a single
   * statement per tenant, it reads nothing at Google, and it is the reason the
   * rule's "decide" half can run in an environment with no Google access at all.
   *
   * ## Why the tenant is a parameter and not a filter the caller applies
   *
   * Because the window is per tenant. A tenant configured for three months and
   * one configured for twenty-four produce different `cutoff` values, so a shared
   * threshold computed once and applied across tenants would be a mute of exactly
   * the kind this feature exists to prevent: one merchant's setting silently
   * deciding another merchant's customers. `tenantId` is in the `WHERE` and again
   * in the ledger subquery.
   *
   * ## The bound is not decoration
   *
   * `limit` is a hard cap the implementation must honour. A tenant with a large
   * pass table would otherwise have one unbounded statement per run, and the
   * report could not say how much it had not reached. Truncation is reported as
   * `truncated` rather than silently applied, because a report that says "400
   * deactivated" when 4,000 were due is a report nobody can act on.
   */
  findInactivePassCandidates(input: {
    tenantId: string;
    /** Activity at or after this instant is inside the window, so the pass is not a candidate. */
    cutoff: Date;
    limit: number;
  }): Promise<InactivityCandidateRow[]>;

  /**
   * One page of the passes whose holder has granted `nearby_notifications`.
   *
   * The fan-out for a venue change needs exactly this set: a pass we believe
   * Google holds, whose customer consented. Three predicates, each load-bearing:
   *
   *   - `p.tenant_id = <tenantId>` — the crossing defence every statement in
   *     this file carries.
   *   - `p.state = 'issued'` — a pass we believe exists at Google. Patching a
   *     `not_saved` object is a 404 and patching an `expired` one is a write to
   *     something Google no longer shows.
   *   - `consent.granted = true` — the whole reason locations are object-level.
   *     A business-wide fan-out that ignored it would write positions onto a
   *     pass whose holder refused them.
   *
   * `after` is a keyset cursor on `customers.id`, not an offset: rows change
   * between calls, and an offset would skip or repeat a customer. `null` starts
   * at the beginning.
   */
  listConsentingPasses(input: {
    tenantId: string;
    after: string | null;
    limit: number;
  }): Promise<ConsentingPassRow[]>;

  /** Write a freshly observed review status and sync timestamp. */
  updateProgramReviewStatus(tenantId: string, reviewStatus: string, syncedAt: Date): Promise<void>;

  /**
   * Set the tenant's demo-mode switch.
   *
   * Separate from `updateProgramReviewStatus` on purpose. The review status is
   * Google's to report and this code only records it; the demo-mode flag is an
   * operator's declaration about publishing access, and a sync from Google must
   * never be able to flip it — a status read that happened to arrive while an
   * operator was testing would otherwise end the test.
   *
   * Returns the number of rows changed, so a caller can tell a tenant with no
   * program row from one whose switch was set.
   */
  setProgramDemoMode(tenantId: string, demoMode: boolean): Promise<number>;

  // -------------------------------------------------------------------------
  // Google Wallet callbacks
  // -------------------------------------------------------------------------

  /**
   * Which tenant owns this Google class?
   *
   * ## Why the tenant has to be resolved from the class
   *
   * A callback's body carries a `classId` and an `objectId` and nothing else. It
   * has no tenant, no customer id, and no credential this system minted — Google
   * is the sender and Google does not know our primary keys. So the tenant is
   * *derived*, from the one mapping that already exists:
   * `tenant_wallet_programs.class_id`.
   *
   * ## Why this answers a question `customer_wallet_passes` cannot
   *
   * The pass table has no `class_id` column, and adding one would be the obvious
   * fix and the wrong one: the class a pass belongs to is already derivable from
   * the tenant, and a denormalised copy would be a second answer to "which class
   * is this pass in?" able to disagree with the program row. Resolving through
   * the program table means the callback path reads the same single source of
   * truth every other path in this worker reads.
   *
   * ## `null` is a real answer
   *
   * A class this system has no row for: a class created by hand in the console,
   * or one belonging to another deployment pointed at this endpoint. Both are
   * refused, and refusing is the whole point — a class we cannot attribute to a
   * tenant names no row we are permitted to write.
   *
   * ## This is a cross-tenant query
   *
   * There is no tenant to scope to; working out which tenants exist *is* the
   * question. Like `listProgramTenants` and `listTenantsWithoutProgram`, it must
   * be called on a session with **no** `app.current_tenant_id`, and it will
   * return no rows at all once the tenant RLS policies are enabled — a gap both
   * of those already document, and one this method inherits rather than
   * introduces.
   */
  findTenantByClassId(classId: string): Promise<WalletTenantByClassIdRow | null>;

  /**
   * Record this callback delivery, and report whether it is the first time.
   *
   * `true` means the caller owns the effect and must carry it out. `false` means
   * this nonce was already recorded, and the delivery is a **replay** — the
   * caller must not write anything.
   *
   * ## Why one statement and not a read then a write
   *
   * Google's retries are concurrent by nature, and a read-then-write lets two
   * deliveries of the same nonce both observe absence and both apply. This is
   * `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so the check and the record
   * are the same atomic step and the unique index is the only arbiter.
   *
   * ## Claim before writing, never after
   *
   * A caller that records the nonce *after* applying the effect is not
   * idempotent; it is merely audited. Ordering is the contract, and the route is
   * the only place it can be enforced.
   *
   * ## A failure here must not be treated as "not seen"
   *
   * The distinction the caller must preserve: `false` is a fact (this nonce was
   * recorded), while a thrown error is an unknown. Collapsing them would let a
   * database blip turn every retry into a duplicate apply.
   */
  claimCallbackDelivery(claim: PassCallbackClaim): Promise<boolean>;

  /**
   * Apply a **confirmed** callback event to a pass row.
   *
   * ## Why this needs its own statement, and its own predicate
   *
   * `recordPassReconciliation` is rank-guarded so an existence claim is
   * monotonic: `state IN ('not_issued', 'not_saved', 'inactive')`. That guard is
   * right for a `404` from `getObject`, where a missing object is far more likely
   * a propagation artifact than a customer deleting their pass.
   *
   * A callback is the opposite of that. It is not an absence noticed while
   * asking; it is Google stating that an add or a remove happened. So
   * `del` must be able to move a row from `issued` back to `not_saved`, and the
   * existence guard would refuse exactly that write — the one write the whole
   * feature exists to perform.
   *
   * Widening the reconciliation predicate instead would be worse: it would let a
   * `getObject` 404 move a row backwards, destroying the monotonicity guarantee
   * for the *other* caller to serve the callback path. Two callers with opposite
   * rules need two statements, and this is the second one.
   *
   * ## The terminal states still hold
   *
   * `expired` and `completed` are absent from the source set, so a callback can
   * never move a row off them. Google cannot un-expire or un-complete an object,
   * and a `save` event arriving late does not make it active again.
   *
   * `inactive` **is** in the source set: a customer who reactivates a pass
   * really does have it in their phone, so `inactive` → `issued` is a true
   * transition that the existence guard would have forbidden.
   *
   * ## Returns rows changed
   *
   * Zero means our tracking state and Google's disagree, or the row is gone — the
   * caller logs it rather than reporting a write that did not happen. See the
   * return-value contract on `recordPassLifecycle`, which this shares.
   */
  recordPassCallback(update: PassCallbackWrite, observedAt: Date): Promise<number>;
}
