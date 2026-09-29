// Mutation harness. Applies one rule-breaking edit at a time, runs the wallet
// suite, records how many tests failed, then restores the original file.
//
// Not part of the shipped test suite; a development tool kept out of `src` so
// it is neither linted nor typechecked as product code.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const WALLET = 'workers/wallet';

const MUTATIONS = [
  {
    name: 'store: findCustomer drops the business_id filter',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `            eq(customers.globalId, globalId),
            eq(customers.businessId, tenantId),`,
    to: `            eq(customers.globalId, globalId),`,
  },
  {
    name: 'store: latestBalance drops the business_id filter',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `            eq(pointsTransactions.customerId, customerId),
            eq(pointsTransactions.businessId, tenantId),`,
    to: `            eq(pointsTransactions.customerId, customerId),`,
  },
  {
    name: 'store: findProgram drops the tenant_id filter',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `.where(eq(tenantWalletPrograms.tenantId, tenantId))`,
    to: `.where(eq(tenantWalletPrograms.tenantId, 'x'))`,
  },
  {
    name: 'store: findCustomer stops excluding withdrawn customers',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `            isNull(customers.deletedAt),
          ),
        )
        .limit(1);

      return (row as WalletCustomerRow | undefined) ?? null;
    },

    async findCustomerById`,
    to: `            sql\`1 = 1\`,
          ),
        )
        .limit(1);

      return (row as WalletCustomerRow | undefined) ?? null;
    },

    async findCustomerById`,
  },
  {
    name: 'store: claimMemberCode drops the compare-and-set guard',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `           AND member_code IS NULL
        RETURNING member_code`,
    to: `        RETURNING member_code`,
  },
  {
    name: 'store: recordPass writes state = issued',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `           SET object_id = EXCLUDED.object_id,
               updated_at = now()
         WHERE customer_wallet_passes.state = 'not_issued'`,
    to: `           SET object_id = EXCLUDED.object_id,
               state = 'issued',
               updated_at = now()
         WHERE customer_wallet_passes.state = 'not_issued'`,
  },
  {
    name: 'issuance: classReadinessFor treats a missing row as usable (auto-create)',
    file: `${WALLET}/src/issuance.ts`,
    from: `  if (program === null) {
    return {
      ok: false,
      reason: 'class_not_provisioned',`,
    to: `  if (program === null) {
    return {
      ok: true,
      issuerId: '0',
      classId: '0.tenant-auto-created',
      // eslint-disable-next-line
    } as never;
  }

  if (false) {
    return {
      ok: false,
      reason: 'class_not_provisioned',`,
  },
  {
    name: 'issuance: readiness fails OPEN on an unknown review status',
    file: `${WALLET}/src/issuance.ts`,
    from: `  if (program.reviewStatus !== 'approved') {`,
    to: `  if (!['draft', 'under_review', 'rejected'].includes(program.reviewStatus)) {
    return { ok: false, reason: 'class_not_approved', message: 'blocked' };
  }

  if (false) {`,
  },
  {
    name: 'issuance: readiness ignores a mismatched class id',
    file: `${WALLET}/src/issuance.ts`,
    from: `  if (program.classId !== expected) {`,
    to: `  if (false) {`,
  },
  {
    name: 'issuance: readiness derives from the row\'s tenant, not the requested one',
    file: `${WALLET}/src/issuance.ts`,
    from: `  const expected = classIdFor(program.issuerId, tenantId);`,
    to: `  const expected = classIdFor(program.issuerId, program.tenantId);`,
  },
  {
    name: 'issuance: the class-readiness order is swapped (id before review)',
    file: `${WALLET}/src/issuance.ts`,
    from: `  if (program.reviewStatus !== 'approved') {`,
    to: `  if (false) {`,
  },
  {
    name: 'issuance: ensureMemberCode returns its own candidate instead of the post-condition',
    file: `${WALLET}/src/issuance.ts`,
    from: `  if (claimed !== null && claimed !== undefined && isValidMemberCode(claimed)) {
    return claimed;
  }`,
    to: `  return candidate;`,
  },
  {
    name: 'issuance: ensureMemberCode obeys a malformed stored code',
    file: `${WALLET}/src/issuance.ts`,
    from: `  if (isValidMemberCode(storedCode)) {`,
    to: `  if (storedCode !== null && storedCode !== undefined) {`,
  },
  {
    name: 'issuance: ensureMemberCode returns null on failure instead of throwing',
    file: `${WALLET}/src/issuance.ts`,
    from: `  throw new MemberCodeUnavailableError(customerId, tenantId);
}`,
    to: `  return '';
}`,
  },
  {
    name: 'issuance: the balance is computed, not read from the ledger',
    file: `${WALLET}/src/issuance.ts`,
    from: `  const balancePoints = await deps.store.latestBalance(input.customerId, input.tenantId);`,
    to: `  await deps.store.latestBalance(input.customerId, input.tenantId);
  const balancePoints = 1000;`,
  },
  {
    name: 'issuance: the balance read is not tenant-scoped',
    file: `${WALLET}/src/issuance.ts`,
    from: `  const balancePoints = await deps.store.latestBalance(input.customerId, input.tenantId);`,
    to: `  const balancePoints = await deps.store.latestBalance(input.customerId, 'other');`,
  },
  {
    name: 'issuance: a missing loyalty program gets a default currency',
    file: `${WALLET}/src/issuance.ts`,
    from: `  if (pointsCurrency === null) {
    throw new LoyaltyProgramNotConfiguredError(input.tenantId);
  }`,
    to: `  const currency = pointsCurrency ?? 'puntos';`,
  },
  {
    name: 'issuance: the pass row is recorded as issued',
    file: `${WALLET}/src/issuance.ts`,
    from: `    objectId: loyaltyObject.id,
    lastSyncedAt: null,`,
    to: `    objectId: loyaltyObject.id,
    lastSyncedAt: new Date(),`,
  },
  {
    name: 'issuance: the object is signed with passState not_issued',
    file: `${WALLET}/src/issuance.ts`,
    from: `    passState: 'issued',`,
    to: `    passState: 'not_issued',`,
  },
  {
    name: 'issuance: the object id derives from the internal customer id',
    file: `${WALLET}/src/issuance.ts`,
    from: `    customerGlobalId: input.customerGlobalId,
    customerFullName: input.customerFullName,`,
    to: `    customerGlobalId: input.customerId,
    customerFullName: input.customerFullName,`,
  },
  {
    name: 'routes: GET /v1/wallet/pass allows an empty origins list',
    file: `${WALLET}/src/routes.ts`,
    from: `  if (origins.length === 0) {`,
    to: `  if (false) {`,
  },
  {
    name: 'routes: the pass route skips the class readiness check',
    file: `${WALLET}/src/routes.ts`,
    from: `  if (!readiness.ok) {`,
    to: `  if (false) {`,
  },
  {
    name: 'routes: the program sync drops the operator gate',
    file: `${WALLET}/src/routes.ts`,
    from: `  if (!gate.ok) {`,
    to: `  if (false) {`,
  },
  {
    name: 'routes: the sync route creates a class for an unprovisioned tenant',
    file: `${WALLET}/src/routes.ts`,
    from: `  if (!program) {`,
    to: `  if (false) {`,
  },
  {
    name: 'routes: a 409 for an unusable class becomes a 200',
    file: `${WALLET}/src/routes.ts`,
    from: `    return c.json({ error: { code: reasonCodeFor(readiness.reason), message: readiness.message } }, 409);`,
    to: `    return c.json({ data: { save_url: 'https://example.invalid' } }, 200);`,
  },
  {
    name: 'google-client: the scope is the plural host name',
    file: `${WALLET}/src/google-client.ts`,
    from: `export const WALLET_ISSUER_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';`,
    to: `export const WALLET_ISSUER_SCOPE = 'https://www.googleapis.com/auth/walletobjects';`,
  },
  {
    name: 'google-client: the access token is never renewed',
    file: `${WALLET}/src/google-client.ts`,
    from: `    if (cachedToken !== null && cachedToken.expiresAtMs > now().getTime()) {
      return cachedToken.accessToken;
    }
    return mintAccessToken();`,
    to: `    if (cachedToken !== null) {
      return cachedToken.accessToken;
    }
    return mintAccessToken();`,
  },
  {
    name: 'google-client: the assertion is not scoped',
    file: `${WALLET}/src/google-client.ts`,
    from: `    const assertion = await new SignJWT({ scope: WALLET_ISSUER_SCOPE })`,
    to: `    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/drive' })`,
  },
  {
    name: 'google-client: a 404 on a get is an error, not an absent class',
    file: `${WALLET}/src/google-client.ts`,
    from: `    if (method === 'GET' && response.status === 404) {`,
    to: `    if (false) {`,
  },
  {
    name: 'google-client: the error body is swallowed, leaving only the status',
    file: `${WALLET}/src/google-client.ts`,
    from: `  const details: GoogleWalletErrorDetail[] = (body.error?.errors ?? []).map((detail) => ({`,
    to: `  const details: GoogleWalletErrorDetail[] = [].map((detail) => ({`,
  },
  {
    name: 'google-client: a body-less success resolves as a created resource',
    file: `${WALLET}/src/google-client.ts`,
    from: `    if (result === null) {
      throw new GoogleWalletResponseError(`,
    to: `    if (result === null) {
      return undefined as unknown as T;
    }

    if (result === null) {
      throw new GoogleWalletResponseError(`,
  },
  {
    name: 'google-client: a missing class id is accepted',
    file: `${WALLET}/src/google-client.ts`,
    from: `    if (id.trim() === '') {
      throw new Error(`,
    to: `    if (id.trim() === ' never') {
      throw new Error(`,
  },
  {
    name: 'google-client: reviewStatusFor maps none onto DRAFT',
    file: `${WALLET}/src/google-client.ts`,
    from: `    default:
      return null;
  }
}

/** Google's reverse mapping`,
    to: `    case 'none':
      return 'DRAFT';
    default:
      return null;
  }
}

/** Google's reverse mapping`,
  },
  {
    name: 'helpers: parseAllowedOrigins keeps blank entries',
    file: `${WALLET}/src/helpers.ts`,
    from: `    if (origin === '') continue;
    if (seen.has(origin)) continue;`,
    to: `    if (seen.has(origin)) continue;`,
  },
  {
    name: 'helpers: requireOperatorRole admits the customer role',
    file: `${WALLET}/src/helpers.ts`,
    from: `  if (isCustomerRole(auth)) {`,
    to: `  if (false) {`,
  },
  {
    name: 'ids: the class id derives from the tenant slug instead of the UUID',
    file: `${WALLET}/src/ids.ts`,
    from: `  return qualify(issuerId, \`tenant-\${sanitizeIdPart(tenantId)}\`);`,
    to: `  return qualify(issuerId, \`tenant-\${sanitizeIdPart('cafe-central')}\`);`,
  },
  {
    name: 'object: the barcode carries the member code instead of the globalId',
    file: `${WALLET}/src/object.ts`,
    from: `    barcode: { type: 'QR_CODE', value: input.customerGlobalId },`,
    to: `    barcode: { type: 'QR_CODE', value: input.memberCode },`,
  },
  {
    name: 'balance: the balance is truncated past the display ceiling',
    file: `${WALLET}/src/balance.ts`,
    from: `  if (points > BALANCE_DISPLAY_MAX) {`,
    to: `  if (false) {`,
  },
  {
    name: 'jwt: an empty origins list is accepted',
    file: `${WALLET}/src/jwt.ts`,
    from: `  if (input.origins.length === 0) {`,
    to: `  if (false) {`,
  },
  {
    name: 'member-code: the code is derived without the pepper',
    file: `${WALLET}/src/member-code.ts`,
    from: `  if (input.pepper.length === 0) {`,
    to: `  if (false) {`,
  },
  {
    name: 'member-code: the code is not tenant-salted',
    file: `${WALLET}/src/member-code.ts`,
    from: `  const message = \`v1|\${tenant.length}|\${tenant}|\${customer.length}|\${customer}|\${attempt}\`;`,
    to: `  const message = \`v1|\${customer.length}|\${customer}\`;`,
  },
  {
    name: 'store: openTenantSession sets only the business variable',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `  await db.execute(setCurrentBusinessId(tenantId));
  await db.execute(setCurrentTenantId(tenantId));`,
    to: `  await db.execute(setCurrentBusinessId(tenantId));`,
  },
  {
    name: 'store: openTenantSession sets the variable session-wide, not transaction-locally',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `  await db.execute(setCurrentBusinessId(tenantId));
  await db.execute(setCurrentTenantId(tenantId));`,
    to: `  await db.execute(sql.raw(\`SELECT set_config('app.current_business_id', '\${tenantId}', false)\`));
  await db.execute(sql.raw(\`SELECT set_config('app.current_tenant_id', '\${tenantId}', false)\`));`,
  },

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  {
    name: 'reconcile: the class-readiness check is skipped entirely',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  const readiness = classReadinessFor(await store.findProgram(input.tenantId), input.tenantId);
  if (!readiness.ok) {`,
    to: `  const readiness = classReadinessFor(await store.findProgram(input.tenantId), input.tenantId);
  if (false) {`,
  },
  {
    name: 'reconcile: readiness is re-derived from the row\'s tenant, not the requested one',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  const readiness = classReadinessFor(await store.findProgram(input.tenantId), input.tenantId);`,
    to: `  const programRow = await store.findProgram(input.tenantId);
  const readiness = classReadinessFor(programRow, programRow?.tenantId ?? input.tenantId);`,
  },
  {
    name: 'reconcile: the idempotency gate is dropped, so every visit patches Google',
    // The single most important mutation in the file. Google documents GET
    // before PATCH precisely so a repeat write does not happen.
    file: `${WALLET}/src/reconcile.ts`,
    from: `  if (currentBalance === nextBalance) {`,
    to: `  if (false) {`,
  },
  {
    name: 'reconcile: the balance is computed instead of read from the ledger',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  const balancePoints = await store.latestBalance(input.customerId, input.tenantId);`,
    to: `  const balancePoints = 1000;`,
  },
  {
    name: 'reconcile: the balance read is not tenant-scoped',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  const balancePoints = await store.latestBalance(input.customerId, input.tenantId);`,
    to: `  const balancePoints = await store.latestBalance(input.customerId, 'other');`,
  },
  {
    name: 'reconcile: a missing pass row is reconciled from a derived object id',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  if (pass === null) {
    return { kind: 'no_tracking_row' };
  }`,
    to: `  if (pass === null) {
    pass = { customerId: input.customerId, tenantId: input.tenantId, objectId: 'derived', state: 'not_issued', lastSyncedAt: null };
  }`,
  },
  {
    name: 'reconcile: a 404 from Google is recorded as `issued`',
    // The exact defect being closed, in reverse: claiming a pass the customer
    // does not have.
    file: `${WALLET}/src/reconcile.ts`,
    from: `    await recordReconciliation(deps, input, 'not_saved', observedAt);
    return { kind: 'not_saved', objectId: pass.objectId };`,
    to: `    await recordReconciliation(deps, input, 'issued', observedAt);
    return { kind: 'not_saved', objectId: pass.objectId };`,
  },
  {
    name: 'reconcile: nothing is recorded when Google has no object',
    file: `${WALLET}/src/reconcile.ts`,
    from: `    await recordReconciliation(deps, input, 'not_saved', observedAt);`,
    to: `    await Promise.resolve();`,
  },
  {
    name: 'reconcile: the state is never advanced to `issued`',
    file: `${WALLET}/src/reconcile.ts`,
    from: `    await recordReconciliation(deps, input, 'issued', observedAt);
    return { kind: 'in_sync', objectId: pass.objectId };`,
    to: `    await recordReconciliation(deps, input, 'not_saved', observedAt);
    return { kind: 'in_sync', objectId: pass.objectId };`,
  },
  {
    name: 'reconcile: a non-ACTIVE object is patched like an active one',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  if (remote.state !== 'ACTIVE') {`,
    to: `  if (false) {`,
  },
  {
    name: 'reconcile: a non-ACTIVE object is recorded as reconciled',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  if (remote.state !== 'ACTIVE') {`,
    to: `  if (remote.state === 'ACTIVE') {`,
  },
  {
    name: 'reconcile: a balance past the display ceiling is pushed anyway',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  if (balanceDisplayFailure(balancePoints) !== null) {`,
    to: `  if (false) {`,
  },
  {
    name: 'reconcile: the display ceiling is decided by a second rule that disagrees',
    file: `${WALLET}/src/balance.ts`,
    from: `  if (points > BALANCE_DISPLAY_MAX) {
    return \`\${String(points).length} digits exceeds the \${BALANCE_DISPLAY_MAX_LENGTH}-character budget\`;
  }`,
    to: `  if (points > BALANCE_DISPLAY_MAX * 2) {
    return \`\${String(points).length} digits exceeds the \${BALANCE_DISPLAY_MAX_LENGTH}-character budget\`;
  }`,
  },
  {
    name: 'reconcile: the patch drops the points currency and sends the balance alone',
    file: `${WALLET}/src/reconcile.ts`,
    from: `    loyaltyPoints: { label: pointsCurrency, balance: { string: nextBalance } },`,
    to: `    loyaltyPoints: { balance: { string: nextBalance } } as never,`,
  },
  {
    name: 'reconcile: the patch also rewrites the tier row, which Google replaces wholesale',
    file: `${WALLET}/src/reconcile.ts`,
    from: `    loyaltyPoints: { label: pointsCurrency, balance: { string: nextBalance } },`,
    to: `    loyaltyPoints: { label: pointsCurrency, balance: { string: nextBalance } },
    textModulesData: [{ header: 'Rewards tier', body: 'Oro', id: 'REWARDS_TIER' }],`,
  },
  {
    name: 'reconcile: the patch activates the pass as a side effect',
    file: `${WALLET}/src/reconcile.ts`,
    from: `    loyaltyPoints: { label: pointsCurrency, balance: { string: nextBalance } },`,
    to: `    state: 'ACTIVE',
    loyaltyPoints: { label: pointsCurrency, balance: { string: nextBalance } },`,
  },
  {
    name: 'reconcile: the post-condition on the patch is not checked',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  if (applied !== nextBalance) {
    throw new PassPatchNotAppliedError(pass.objectId, nextBalance, applied);
  }`,
    to: `  if (false) {
    throw new PassPatchNotAppliedError(pass.objectId, nextBalance, applied);
  }`,
  },
  {
    name: 'reconcile: a missing currency is defaulted rather than refusing the patch',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  if (pointsCurrency === null) {`,
    to: `  if (false) {`,
  },
  {
    name: 'reconcile: the observation timestamp is the system clock, not the injected one',
    file: `${WALLET}/src/reconcile.ts`,
    from: `  const observedAt = deps.now ?? new Date();`,
    to: `  const observedAt = new Date();`,
  },
  {
    name: 'reconcile: the observation is recorded against a hardcoded tenant',
    file: `${WALLET}/src/reconcile.ts`,
    from: `    tenantId: input.tenantId,
    state,
    observedAt,`,
    to: `    tenantId: '00000000-0000-0000-0000-000000000000',
    state,
    observedAt,`,
  },

  // -------------------------------------------------------------------------
  // The store, on the reconciliation path
  // -------------------------------------------------------------------------

  {
    name: 'store: findPass narrows on the primary key alone, with no tenant filter',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `          and(
            eq(customerWalletPasses.customerId, customerId),
            // The second of the two tenant filters, and the one that matters
            // here: \`customer_id\` is the primary key, so the predicate already
            // narrows to a single row, and that row carries a \`tenant_id\` this
            // layer must still check. A row written against another tenant would
            // be patched at Google from this request.
            eq(customerWalletPasses.tenantId, tenantId),
          ),`,
    to: `          eq(customerWalletPasses.customerId, customerId),`,
  },
  {
    name: 'store: findPass ignores the customer it was asked about',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `            eq(customerWalletPasses.customerId, customerId),
            // The second of the two tenant filters`,
    to: `            eq(customerWalletPasses.customerId, '00000000-0000-0000-0000-000000000000'),
            // The second of the two tenant filters`,
  },
  {
    name: 'store: recordPassReconciliation drops the tenant filter on the write',
    // Re-anchored twice now. The guard's SQL moved into a `CASE` so that the
    // timestamp is no longer covered by it, which removed the old single-line
    // anchor and then the `WHERE`-shaped one. Without this the mutation would
    // report NOT-APPLIED, and a mutation that reports NOT-APPLIED is a
    // mutation that proves nothing.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
        RETURNING customer_id
      \`);

      return countRows(result);
    },

    /**
     * The lifecycle write, with its own predicate.`,
    to: `         WHERE customer_id = \${update.customerId}::uuid
        RETURNING customer_id
      \`);

      return countRows(result);
    },

    /**
     * The lifecycle write, with its own predicate.`,
  },
  {
    name: 'store: recordPassReconciliation drops the monotonicity guard',
    // The guard is a rank comparison wrapped around the state assignment. Turning
    // it into "any state" is the "accept any write" version of the defect: a pass
    // would be free to regress from `issued` back to `not_saved`.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `           SET state = CASE
                          WHEN state IN ('not_issued', 'not_saved', 'inactive')
                          THEN \${update.state}
                          ELSE state
                        END,`,
    to: `           SET state = CASE
                          WHEN state IS NOT NULL
                          THEN \${update.state}
                          ELSE state
                        END,`,
  },
  {
    name: 'store: the rank guard also covers the observation, so a terminal row is discarded',
    // The liveness half of the split. This is the mutation for the defect where
    // a definitive answer about a row in `expired` or `completed` matched nothing
    // and was thrown away, leaving that pass permanently in the sweep's due set.
    // The mutation puts the state predicate back in the `WHERE`, which is exactly
    // the shape that discards the timestamp along with the state.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
        RETURNING customer_id
      \`);

      return countRows(result);
    },

    /**
     * The lifecycle write, with its own predicate.`,
    to: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
           AND state IN ('not_issued', 'not_saved', 'inactive')
        RETURNING customer_id
      \`);

      return countRows(result);
    },

    /**
     * The lifecycle write, with its own predicate.`,
  },
  {
    name: 'store: recordPassReconciliation stops refreshing the observation time',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `                        END,
               last_synced_at = \${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = \${update.customerId}::uuid`,
    to: `                        END,
               updated_at = now()
         WHERE customer_id = \${update.customerId}::uuid`,
  },
  {
    name: 'store: recordPassReconciliation reports a row it never changed',
    // Under a `void` return this was the shape of every lifecycle write, and it
    // is how the sweep counted a lifecycle observation it had not recorded. The
    // write is still issued; only the fact that it changed nothing is lost.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `        RETURNING customer_id
      \`);

      return countRows(result);
    },

    /**
     * The lifecycle write, with its own predicate.`,
    to: `        RETURNING customer_id
      \`);

      return 1;
    },

    /**
     * The lifecycle write, with its own predicate.`,
  },

  {
    name: 'store: recordPass still refuses to move a state back to not_issued',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `         WHERE customer_wallet_passes.state = 'not_issued'
      \`);`,
    to: `         WHERE customer_wallet_passes.state IS NOT NULL
      \`);`,
  },

  // -------------------------------------------------------------------------
  // Demo Mode and the balance ceiling on the routes
  // -------------------------------------------------------------------------

  {
    name: 'helpers: parseDemoMode fails OPEN on an absent var',
    file: `${WALLET}/src/helpers.ts`,
    from: `  if (raw === undefined || raw === null) return true;`,
    to: `  if (raw === undefined || raw === null) return false;`,
  },
  {
    name: 'helpers: parseDemoMode fails OPEN on a value it does not recognise',
    file: `${WALLET}/src/helpers.ts`,
    from: `  if (normalised === 'false' || normalised === '0' || normalised === 'no') return false;

  return true;`,
    to: `  return normalised !== 'true' && normalised !== '1' && normalised !== 'yes';`,
  },
  {
    name: 'routes: the pass route ignores demo mode entirely',
    file: `${WALLET}/src/routes.ts`,
    from: `  if (parseDemoMode(c.env.WALLET_DEMO_MODE)) {`,
    to: `  if (false) {`,
  },
  {
    name: 'routes: demo mode is reported but the pass is still called available',
    file: `${WALLET}/src/routes.ts`,
    from: `  const reason = demoMode
    ? 'demo_mode'`,
    to: `  const reason = false
    ? 'demo_mode'`,
  },
  {
    name: 'routes: the status endpoint stops reporting the demo-mode fact',
    file: `${WALLET}/src/routes.ts`,
    from: `      demo_mode: demoMode,`,
    to: `      demo_mode: false,`,
  },
  {
    name: 'routes: the status endpoint stops reporting the pass tracking state',
    file: `${WALLET}/src/routes.ts`,
    from: `      pass_state: (await store.findPass(customer.id, tenantId))?.state ?? null,`,
    to: `      pass_state: null,`,
  },
  {
    name: 'routes: a balance past the display ceiling is a 500 again',
    file: `${WALLET}/src/routes.ts`,
    from: `    if (err instanceof BalanceNotDisplayableError) {`,
    to: `    if (false) {`,
  },
  {
    name: 'routes: the status endpoint stops refusing a pass it cannot display',
    file: `${WALLET}/src/routes.ts`,
    from: `  const balanceBlocked = balanceDisplayFailure(balancePoints) !== null;`,
    to: `  const balanceBlocked = false;`,
  },
  {
    name: 'routes: the status endpoint reads the balance without the tenant',
    file: `${WALLET}/src/routes.ts`,
    from: `    ? await store.latestBalance(customer.id, tenantId)`,
    to: `    ? await store.latestBalance(customer.id, '00000000-0000-0000-0000-000000000000')`,
  },
  {
    name: 'routes: a reconciliation failure takes the pass link down with it',
    // The invariant the whole side-effect shape exists for: a tap on a button
    // never fails because Google's API is having a bad minute.
    file: `${WALLET}/src/routes.ts`,
    from: `    } catch (err: unknown) {
      // Swallowed on purpose, and the reason is in the route's own doc comment:`,
    to: `    } catch (err: unknown) {
      if (true) throw err;
      // Swallowed on purpose, and the reason is in the route's own doc comment:`,
  },
  {
    name: 'routes: the reconciliation is never called at all',
    file: `${WALLET}/src/routes.ts`,
    from: `      const outcome = await reconcilePass(
        { store, client },
        { tenantId, customerId: customer.id },
      );`,
    to: `      const outcome = { kind: 'not_saved' as const, objectId: issued.objectId };`,
  },
  {
    name: 'routes: the reconciliation is handed a hardcoded tenant',
    file: `${WALLET}/src/routes.ts`,
    from: `        { tenantId, customerId: customer.id },
      );`,
    to: `        { tenantId: '00000000-0000-0000-0000-000000000000', customerId: customer.id },
      );`,
  },

  // -------------------------------------------------------------------------
  // The `not_saved` state
  // -------------------------------------------------------------------------

  {
    name: 'object: objectStateFor maps `not_saved` onto PENDING',
    file: `${WALLET}/src/object.ts`,
    from: `    case 'not_issued':
    case 'not_saved':
      throw new PassNotIssuedError(customerId, passState);`,
    to: `    case 'not_issued':
      throw new PassNotIssuedError(customerId, passState);
    case 'not_saved':
      return 'PENDING';`,
  },
  {
    name: 'object: the error no longer names the state that has no counterpart',
    file: `${WALLET}/src/object.ts`,
    from: `      \`Pass for customer \${customerId} is in state "\${passState}": no Google object exists \` +`,
    to: `      \`Pass for customer \${customerId} is in state "not_issued": no Google object exists \` +`,
  },

  // -------------------------------------------------------------------------
  // The reconciliation sweep
  // -------------------------------------------------------------------------
  //
  // Ordered by the failure each one would cause if the guard broke, not by the
  // order of the code. Every guard here is one whose absence writes to Google
  // on a schedule, drops a merchant's work silently, or reports a write that
  // never happened.

  {
    name: 'sweep: the scheduled sweep runs in Demo Mode anyway',
    // The single most damaging guard in the module. A background writer that
    // forgot this would patch Google's servers daily for a deployment that has
    // no publishing access and therefore no account it is permitted to write to.
    file: `${WALLET}/src/sweep.ts`,
    from: `  if (input.demoMode) {
    return report;
  }`,
    to: `  if (false) {
    return report;
  }`,
  },
  {
    name: 'sweep: the boundary opens the database in Demo Mode before refusing',
    // Checked at both boundaries on purpose. This one is the `createDb` guard,
    // so it fails independently of the one above.
    file: `${WALLET}/src/sweep.ts`,
    from: `  if (demoMode) {
    console.log(`,
    to: `  if (false) {
    console.log(`,
  },
  {
    name: 'sweep: the class-readiness check is skipped, so an unapproved class is swept',
    // The one code path in this worker that would write to Google for a class
    // Google has not approved, which is exactly what the pass route refuses.
    file: `${WALLET}/src/sweep.ts`,
    from: `    const readiness = classReadinessFor(program, program.tenantId);
    if (!readiness.ok) {`,
    to: `    const readiness = classReadinessFor(program, program.tenantId);
    if (false) {`,
  },
  {
    name: 'sweep: objects are listed by issuer id, so every merchant lands in one run',
    // One class per tenant makes the class filter the tenant boundary. Listing
    // by issuer would pull every merchant's passes into one worker's memory and
    // leave a local `if` as the only thing undoing it.
    file: `${WALLET}/src/sweep.ts`,
    from: `      const outcome = await sweepTenant(deps, program.tenantId, readiness.classId, observedAt, report);`,
    to: `      const outcome = await sweepTenant(deps, program.tenantId, readiness.issuerId, observedAt, report);`,
  },
  {
    name: 'sweep: the tenant enumeration is asked for without a bound',
    // The enumeration bound. An unbounded `listProgramTenants` in a scheduled
    // job is an outage with a delay before it.
    file: `${WALLET}/src/sweep.ts`,
    from: `      limit: MAX_TENANTS_PER_RUN,`,
    to: `      limit: 10_000,`,
  },
  {
    name: 'sweep: the per-run work bound is removed, so one tenant can spend the run',
    // The work bound, and the one that actually costs money: each acted-on pass
    // is a `getObject`, a ledger read and possibly a `patch`.
    file: `${WALLET}/src/sweep.ts`,
    from: `      if (report.passesActedOn >= MAX_RECONCILES_PER_TENANT) {
        budgetExhausted = true;
        break;
      }`,
    to: `      if (false) {
        budgetExhausted = true;
        break;
      }`,
  },
  {
    name: 'sweep: a tenant that ran out of budget is reported as swept',
    // The distinction the whole resumability story rests on: deferred work
    // counted as done is work the next run will never come back for.
    file: `${WALLET}/src/sweep.ts`,
    from: `    if (budgetExhausted) return 'deferred';`,
    to: `    if (budgetExhausted) return 'complete';`,
  },
  {
    name: 'sweep: a deferred tenant is counted as swept',
    file: `${WALLET}/src/sweep.ts`,
    from: `      if (outcome === 'deferred') {
        report.tenantsDeferred += 1;
      } else {
        report.tenantsSwept += 1;
      }`,
    to: `      if (outcome === 'deferred') {
        report.tenantsSwept += 1;
      } else {
        report.tenantsSwept += 1;
      }`,
  },
  {
    name: 'sweep: a failed tenant is counted as swept',
    file: `${WALLET}/src/sweep.ts`,
    from: `      report.tenantsFailed += 1;
      report.failures.push({`,
    to: `      report.tenantsSwept += 1;
      report.failures.push({`,
  },
  {
    name: 'sweep: one broken tenant ends the whole run',
    // A scheduled handler that throws has the entire invocation retried from
    // the first tenant, so one broken merchant means tenant two is never reached.
    file: `${WALLET}/src/sweep.ts`,
    from: `    } catch (err: unknown) {
      // Scoped to one tenant. The next tenant is swept, and this one is retried
      // on the next run because nothing recorded that it was done.
      report.tenantsFailed += 1;`,
    to: `    } catch (err: unknown) {
      if (true) throw err;
      // Scoped to one tenant. The next tenant is swept, and this one is retried
      // on the next run because nothing recorded that it was done.
      report.tenantsFailed += 1;`,
  },
  {
    name: 'sweep: the per-tenant page bound is removed',
    // The listing bound. Without it a single tenant can read the whole issuer
    // class before the run moves on, which is the cost the bound exists to cap.
    file: `${WALLET}/src/sweep.ts`,
    from: `  while (page < MAX_PAGES_PER_TENANT) {`,
    to: `  while (page < 5_000) {`,
  },
  {
    name: 'sweep: the page limit truncates the tenant instead of deferring it',
    // Out of page budget with a token still in hand. Returning `complete` here
    // is the silent-drop: everything past the fifth page is simply never
    // revisited, because nothing recorded that it was left.
    file: `${WALLET}/src/sweep.ts`,
    from: `    token = listed.nextPageToken;
  }

  // Out of page budget with a token still in hand: this tenant has more objects
  // than one invocation covers, and the next run continues from the passes it
  // has not stamped.
  return 'deferred';
}`,
    to: `    token = listed.nextPageToken;
  }

  // Out of page budget with a token still in hand: this tenant has more objects
  // than one invocation covers, and the next run continues from the passes it
  // has not stamped.
  return 'complete';
}`,
  },
  {
    name: 'sweep: the last page is not recognised, so a finished tenant looks deferred',
    file: `${WALLET}/src/sweep.ts`,
    from: `    if (listed.nextPageToken === null) return 'complete';`,
    to: `    if (listed.nextPageToken === null) return 'deferred';`,
  },
  {
    name: 'sweep: the page size sent to Google is unbounded',
    file: `${WALLET}/src/sweep.ts`,
    from: `        maxResults: OBJECT_PAGE_SIZE,`,
    to: `        maxResults: 100_000,`,
  },
  {
    name: 'sweep: the pass rows are resolved against the wrong tenant',
    // The crossing defence. `findPassesByObjectIds` carries `tenant_id` so a
    // row filed under another merchant is never returned, and never acted on.
    file: `${WALLET}/src/sweep.ts`,
    from: `        listed.objects.map((object) => object.id),
        tenantId,`,
    to: `        listed.objects.map((object) => object.id),
        '00000000-0000-0000-0000-000000000000',`,
  },
  {
    name: 'sweep: a failed row resolution is swallowed and the page is treated as empty',
    // The dangerous shape of this failure: not a crash, but a clean report that
    // says the tenant was swept having reconciled nobody. Every one of its
    // passes would be counted as `objectsWithoutPassRow` and never revisited.
    file: `${WALLET}/src/sweep.ts`,
    from: `    } catch (err: unknown) {
      throw new TenantStageError(tenantId, 'resolve_passes', err);
    }`,
    to: `    } catch (err: unknown) {
      void err;
      rows = [];
    }`,
  },
  {
    name: 'sweep: a failed row resolution is reported under the wrong stage',
    file: `${WALLET}/src/sweep.ts`,
    from: `      throw new TenantStageError(tenantId, 'resolve_passes', err);`,
    to: `      throw new TenantStageError(tenantId, 'reconcile', err);`,
  },
  {
    name: 'sweep: the lifecycle mapping is applied to a state that is not approved',
    // Written as a widening of the mapping table rather than of the check, so it
    // survives the readiness mutation above: a Google state nobody has reasoned
    // about must fail closed, not be recorded.
    file: `${WALLET}/src/sweep.ts`,
    from: `    case 'INACTIVE':
      return 'inactive';`,
    to: `    case 'ACTIVE':
      return 'inactive';
    case 'INACTIVE':
      return 'inactive';`,
  },
  {
    name: 'sweep: a PENDING object is recorded as a completed pass',
    // `PENDING` means the platform holds an object the user has not activated.
    // There is no `pending` in `PassTrackingState` and inventing one puts a
    // word in the schema no other code can read.
    file: `${WALLET}/src/sweep.ts`,
    from: `    case 'EXPIRED':
      return 'expired';`,
    to: `    case 'PENDING':
      return 'completed';
    case 'EXPIRED':
      return 'expired';`,
  },
  {
    name: 'sweep: an unrecognised Google state is recorded instead of failing closed',
    file: `${WALLET}/src/sweep.ts`,
    from: `    default:
      return null;
  }
}`,
    to: `    default:
      return 'inactive';
  }
}`,
  },
  {
    name: 'sweep: no lifecycle state is ever recorded',
    file: `${WALLET}/src/sweep.ts`,
    from: `  const lifecycle = lifecycleStateFor(object.state);
  if (lifecycle !== null) {`,
    to: `  const lifecycle = lifecycleStateFor(object.state);
  if (false) {`,
  },
  {
    name: 'sweep: a lifecycle write is recorded against the wrong tenant',
    file: `${WALLET}/src/sweep.ts`,
    from: `        customerId: row.customerId,
        tenantId: row.tenantId,
        state: lifecycle,`,
    to: `        customerId: row.customerId,
        tenantId: '00000000-0000-0000-0000-000000000000',
        state: lifecycle,`,
  },
  {
    name: 'sweep: the balance is reconciled against the wrong tenant',
    // The other write on the per-pass path. It reads `row.tenantId` rather than
    // the tenant being swept, which is the safe direction: a row filed under
    // the wrong merchant must not be patched at Google under the swept one.
    file: `${WALLET}/src/sweep.ts`,
    from: `      { tenantId: row.tenantId, customerId: row.customerId },`,
    to: `      { tenantId: '00000000-0000-0000-0000-000000000000', customerId: row.customerId },`,
  },
  {
    name: 'sweep: pagination never advances, so the same page is read five times',
    // Bounded by `MAX_PAGES_PER_TENANT`, so it terminates. The tenant is
    // reported as deferred having read page one five times, and every pass
    // after the first hundred is never reached.
    file: `${WALLET}/src/sweep.ts`,
    from: `        ...(token === undefined ? {} : { token }),`,
    to: `        ...{},`,
  },
  {
    name: 'sweep: a failed lifecycle write abandons the tenant',
    file: `${WALLET}/src/sweep.ts`,
    from: `      report.failures.push({
        tenantId: row.tenantId,
        stage: 'reconcile',
        reason: \`lifecycle \${lifecycle}: \${describe(err)}\`,
      });`,
    to: `      if (true) throw err;
      report.failures.push({
        tenantId: row.tenantId,
        stage: 'reconcile',
        reason: \`lifecycle \${lifecycle}: \${describe(err)}\`,
      });`,
  },
  {
    name: 'sweep: the due filter is removed, so one run pays twice for the same pass',
    // The filter the resumability claim rests on. Without it a deferred tenant
    // re-does the work it already did, and a large tenant never gets past the
    // budget it already spent.
    file: `${WALLET}/src/sweep.ts`,
    from: `      if (row.lastSyncedAt !== null && row.lastSyncedAt.getTime() >= observedAt.getTime()) {`,
    to: `      if (false) {`,
  },
  {
    name: 'sweep: the due filter is off by one, so a pass verified by this run is due again',
    file: `${WALLET}/src/sweep.ts`,
    from: `      if (row.lastSyncedAt !== null && row.lastSyncedAt.getTime() >= observedAt.getTime()) {`,
    to: `      if (row.lastSyncedAt !== null && row.lastSyncedAt.getTime() > observedAt.getTime()) {`,
  },
  {
    name: 'sweep: the cron is hourly, past Google\'s three-notifications-per-24h cap',
    file: `${WALLET}/src/sweep.ts`,
    from: `export const SWEEP_CRON = '0 6 * * *';`,
    to: `export const SWEEP_CRON = '0 * * * *';`,
  },

  // -------------------------------------------------------------------------
  // Liveness and honest reporting: the two defects where a write either did not
  // happen or was reported as though it had
  // -------------------------------------------------------------------------

  {
    name: 'reconcile: a non-ACTIVE object records no observation, so the pass is due for ever',
    // The liveness defect. `PENDING` and `STATE_UNSPECIFIED` have no lifecycle
    // mapping, so removing this write leaves those passes with no timestamp at
    // all: re-read on every run, and with a budget's worth of them the tenant
    // never gets past them.
    file: `${WALLET}/src/reconcile.ts`,
    from: `    const rowsChanged = await recordObservation(deps, input, observedAt);`,
    to: `    const rowsChanged = 0;`,
  },
  {
    name: 'reconcile: a non-ACTIVE object is reported as recorded without being written',
    // The same write, from the other side. The row count is the only thing that
    // tells the sweep a pass left the due set, so assuming it did is the
    // original defect wearing a different hat.
    file: `${WALLET}/src/reconcile.ts`,
    from: `    const rowsChanged = await recordObservation(deps, input, observedAt);
    return { kind: 'object_not_active', state: String(remote.state), observationRecorded: rowsChanged > 0 };`,
    to: `    await recordObservation(deps, input, observedAt);
    return { kind: 'object_not_active', state: String(remote.state), observationRecorded: true };`,
  },
  {
    name: 'sweep: a lifecycle write is counted even when it changed no row',
    // Defect 2, sweep side. `findPassesByObjectIds` resolves rows by object id
    // with no state filter, so a `not_saved` row reaches the lifecycle write,
    // matches nothing, and was counted as a lifecycle observation recorded.
    file: `${WALLET}/src/sweep.ts`,
    from: `      if (rowsChanged > 0) {
        report.lifecycleWrites[lifecycle] += 1;`,
    to: `      if (rowsChanged >= 0) {
        report.lifecycleWrites[lifecycle] += 1;`,
  },
  {
    name: 'sweep: a refused lifecycle write is not reported as skipped',
    // The other half. Counting it as a write was the first defect; dropping it
    // on the floor is how a report becomes evidence of nothing at all.
    file: `${WALLET}/src/sweep.ts`,
    from: `      } else {
        report.lifecycleWritesSkipped += 1;
      }`,
    to: `      } else {
        report.lifecycleWritesSkipped += 0;
      }`,
  },
  {
    name: 'sweep: an unrecordable observation is not reported, so a stuck pass reads as handled',
    // The last liveness hole. A pass counted here is still in the due set next
    // run, so the counter is the only thing that says the sweep is not making
    // progress on it.
    file: `${WALLET}/src/sweep.ts`,
    from: `    if (outcome.kind === 'object_not_active' && !outcome.observationRecorded) {
      report.observationsNotRecorded += 1;
    }`,
    to: `    if (false) {
      report.observationsNotRecorded += 1;
    }`,
  },

  // -------------------------------------------------------------------------
  // The lifecycle predicate, where the monotonic guard and the lifecycle
  // mapping are actually reconciled with each other
  // -------------------------------------------------------------------------

  {
    name: 'store: recordPassLifecycle drops its source set, so a lifecycle write asserts an existence',
    // The one invariant that survives the documented exception to the
    // monotonicity guard: a lifecycle answer may only be written against a row
    // that already says an object exists.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
           AND state IN ('issued', 'inactive')`,
    to: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid`,
  },
  {
    name: 'store: recordPassLifecycle drops the tenant filter on the write',
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
           AND state IN ('issued', 'inactive')`,
    to: `         WHERE customer_id = \${update.customerId}::uuid
           AND state IN ('issued', 'inactive')`,
  },
  {
    name: 'store: recordPassLifecycle lets a terminal state be moved backwards',
    // The monotonic regression, in the only place it can happen. `expired` is
    // absent from the source set precisely so nothing can move a row off it.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `           AND state IN ('issued', 'inactive')`,
    to: `           AND state IN ('issued', 'inactive', 'expired')`,
  },
  {
    name: 'store: recordPassReconciliation drops `inactive`, so a reactivated pass is unrecordable',
    // The other half of the same reconciliation: the lifecycle write can move a
    // pass to `inactive`, so the existence path has to be able to move it back.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `                          WHEN state IN ('not_issued', 'not_saved', 'inactive')`,
    to: `                          WHEN state IN ('not_issued', 'not_saved')`,
  },
  {
    name: 'store: recordPassLifecycle reports a row it never changed',
    // Defect 2, store side. The `not_saved` row that a `getObject` 404 produces
    // matches no rows here, and a fixed `1` is indistinguishable from a real
    // write, so the caller counts a lifecycle observation it never recorded and
    // the row keeps a stale timestamp.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `           AND state IN ('issued', 'inactive')
        RETURNING customer_id
      \`);

      return countRows(result);`,
    to: `           AND state IN ('issued', 'inactive')
      \`);

      return 1;`,
  },

  // -------------------------------------------------------------------------
  // The observation: the write that exists so a pass the sweep cannot act on
  // still leaves the due set
  // -------------------------------------------------------------------------

  {
    name: 'store: recordPassObservation drops the tenant filter on the write',
    // The one guard this method has. A scheduled sweep calls it, and a write
    // that stamps `last_synced_at` on another tenant's row would corrupt that
    // tenant's due set from outside.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `    async recordPassObservation(update: PassObservationUpdate): Promise<number> {
      const result = await db.execute(sql\`
        UPDATE customer_wallet_passes
           SET last_synced_at = \${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
        RETURNING customer_id
      \`);`,
    to: `    async recordPassObservation(update: PassObservationUpdate): Promise<number> {
      const result = await db.execute(sql\`
        UPDATE customer_wallet_passes
           SET last_synced_at = \${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = \${update.customerId}::uuid
        RETURNING customer_id
      \`);`,
  },
  {
    name: 'store: recordPassObservation invents a lifecycle state it has no word for',
    // The reason this method takes no `state` parameter. A caller that has a
    // Google value and nothing to map it to must not be able to write it.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `           SET last_synced_at = \${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
        RETURNING customer_id`,
    to: `           SET state = 'inactive',
               last_synced_at = \${update.observedAt}::timestamptz,
               updated_at = now()
         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
        RETURNING customer_id`,
  },
  {
    name: 'store: recordPassObservation filters on state, so excluded rows stay due for ever',
    // Exactly the starvation this method was written to end, reintroduced by
    // adding the guard that looks safest. A state filter here would strand
    // every state it excludes — including `expired` and `completed`, which this
    // worker writes itself.
    file: `${WALLET}/src/drizzle-store.ts`,
    from: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
        RETURNING customer_id
      \`);

      return countRows(result);
    },

    /**
     * One page of tenants, ascending by primary key.`,
    to: `         WHERE customer_id = \${update.customerId}::uuid
           AND tenant_id = \${update.tenantId}::uuid
           AND state IN ('issued', 'inactive')
        RETURNING customer_id
      \`);

      return countRows(result);
    },

    /**
     * One page of tenants, ascending by primary key.`,
  },
];


function runTests() {
  try {
    execSync('pnpm --filter @vyloop/wallet test 2>&1', { stdio: 'pipe' });
    return { failed: 0, output: '' };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // vitest prints "Tests  N failed | M passed" — take the failing count.
    const match = output.match(/Tests\s+(\d+)\s+failed/);
    return { failed: match ? Number(match[1]) : -1, output };
  }
}

const results = [];
let missed = 0;
let ambiguous = 0;

// Every file the harness is about to edit, snapshotted before the first write.
// The loop restores each file after its run, and a restore that is not
// byte-exact would mean every later mutation is measured against a source
// nobody has read. Comparing the whole set at the end is the only check that
// covers a process killed mid-run.
const targetFiles = [...new Set(MUTATIONS.map((m) => m.file))];
const pristine = new Map(targetFiles.map((f) => [f, readFileSync(f, 'utf8')]));

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8');
  const occurrences = original.split(mutation.from).length - 1;

  if (occurrences === 0) {
    // The anchor does not exist in the current source, so nothing was ever
    // edited. This is the failure a previous run of this harness hid: the
    // mutation counted as a result, and the result was fiction.
    results.push({ name: mutation.name, failed: 'NOT-APPLIED' });
    missed += 1;
    continue;
  }

  if (occurrences > 1) {
    // `replace` edits the first match, so the mutation may not be the one its
    // name describes. Reported rather than silently accepted.
    ambiguous += 1;
    console.log(`AMBIGUOUS x${occurrences}  ${mutation.name}`);
  }

  const mutated = original.replace(mutation.from, mutation.to);
  if (mutated === original) {
    // A replacement that changes nothing is not a mutation.
    results.push({ name: mutation.name, failed: 'NO-OP' });
    missed += 1;
    continue;
  }

  writeFileSync(mutation.file, mutated);
  const { failed, output } = runTests();
  writeFileSync(mutation.file, original);

  if (readFileSync(mutation.file, 'utf8') !== original) {
    // Stop rather than continue: from here on every result is untrustworthy.
    console.error(`\nABORT: ${mutation.file} was not restored byte-exactly.`);
    process.exitCode = 1;
    break;
  }

  if (failed === -1) {
    // The mutation broke the build rather than a test. That still counts as
    // caught, but it must be reported distinctly.
    results.push({ name: mutation.name, failed: 'BUILD-BROKEN' });
    missed += 1;
    continue;
  }
  results.push({ name: mutation.name, failed });
  if (failed === 0) missed += 1;
}

const drifted = targetFiles.filter((f) => readFileSync(f, 'utf8') !== pristine.get(f));
if (drifted.length > 0) {
  console.error(`\nABORT: these files were not left exactly as found: ${drifted.join(', ')}`);
  process.exitCode = 1;
}

console.log('\n=== MUTATION RESULTS ===\n');
for (const result of results) {
  const caught = typeof result.failed === 'number' && result.failed > 0;
  console.log(
    `${caught ? 'CAUGHT ' : 'MISSED '} ${String(result.failed).padStart(4)}  ${result.name}`,
  );
}
console.log(`\n${results.length} mutations, ${missed} uncaught.`);
if (ambiguous > 0) {
  console.log(`${ambiguous} mutation(s) had a non-unique anchor; each applied to its first match.`);
}
process.exit(0);
