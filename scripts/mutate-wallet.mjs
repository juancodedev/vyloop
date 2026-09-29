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

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8');
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, failed: 'NOT-APPLIED' });
    missed += 1;
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
  const { failed, output } = runTests();
  writeFileSync(mutation.file, original);

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

console.log('\n=== MUTATION RESULTS ===\n');
for (const result of results) {
  const caught = typeof result.failed === 'number' && result.failed > 0;
  console.log(
    `${caught ? 'CAUGHT ' : 'MISSED '} ${String(result.failed).padStart(4)}  ${result.name}`,
  );
}
console.log(`\n${results.length} mutations, ${missed} uncaught.`);
process.exit(0);
