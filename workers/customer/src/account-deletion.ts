import {
  checkins,
  churnPredictions,
  consents,
  createDb,
  customerEvents,
  customers,
  messageLog,
  pointsTransactions,
  pushSubscriptions,
  withTenantTransaction,
} from '@vyloop/db';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';

import type { Bindings } from './helpers';

// ---------------------------------------------------------------------------
// Account deletion
//
// Shared by `DELETE /v1/customers/me` (the customer) and
// `DELETE /v1/customers/:id` (the staff), so what `docs/08-API-Design.md`
// promises is true for both. The design is in
// `openspec/changes/archive/2026-10-27-customer-profile-redesign/design.md`, "Account deletion".
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof createDb>;
/** The transaction handle `withTenantTransaction` passes to its callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Strip a customer of personal data, inside the caller's tenant transaction.
 *
 * Rows are kept, never hard-deleted: the merchant's ledger and visit history
 * hang off `customers.id`, and `referrals` and `workflow_executions` reference
 * it with no `ON DELETE` action. What the rows keep is the arithmetic, not the
 * person.
 *
 * The customer UPDATE is guarded by `deleted_at IS NULL` and goes first. When
 * two deletes race, the second one blocks on the row lock, re-reads the row
 * after the first commits, matches nothing, and leaves the child tables to the
 * one that won. Returns whether this call did the anonymisation.
 */
export async function anonymiseCustomer(
  tx: Tx,
  customer: { id: string; businessId: string },
): Promise<boolean> {
  const now = new Date();
  const stamped = await tx
    .update(customers)
    .set({
      fullName: null,
      // A null phone and email free `uq_customers_business_phone` and
      // `uq_customers_business_email`: the number can register again as a
      // new customer.
      phone: null,
      email: null,
      birthDate: null,
      identityDoc: null,
      identityType: null,
      memberCode: null,
      metadata: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(customers.id, customer.id),
        eq(customers.businessId, customer.businessId),
        isNull(customers.deletedAt),
      ),
    )
    .returning({ id: customers.id });

  if (stamped.length === 0) return false;

  // Every kept row of this customer, in this business only.
  const own = (table: { customerId: AnyPgColumn; businessId: AnyPgColumn }) =>
    and(eq(table.customerId, customer.id), eq(table.businessId, customer.businessId));

  await tx.update(pointsTransactions).set({ note: null }).where(own(pointsTransactions));
  await tx.update(checkins).set({ note: null, items: null }).where(own(checkins));
  // `payload` is NOT NULL; an empty object is the emptiest value it accepts.
  await tx.update(customerEvents).set({ payload: {} }).where(own(customerEvents));
  await tx.update(messageLog).set({ content: null, metadata: null }).where(own(messageLog));
  await tx.update(consents).set({ ipAddress: null }).where(own(consents));
  await tx.delete(pushSubscriptions).where(own(pushSubscriptions));
  await tx.delete(churnPredictions).where(own(churnPredictions));

  return true;
}

/**
 * The whole delete, after the route has decided who may ask for it.
 *
 * `match` names the customer (by global id for the customer, by id for the
 * staff); the business is always the token's. A customer that is already
 * deleted answers 204 and changes nothing: the only thing worth retrying is a
 * wallet expiry that did not land the first time.
 */
export async function deleteCustomerAccount(
  c: Context<{ Bindings: Bindings }>,
  businessId: string,
  match: SQL,
): Promise<Response> {
  const db = createDb(c.env.DATABASE_URL);

  // The lookup and the anonymisation share one tenant transaction; the wallet
  // expiry below is scheduled only after it has committed.
  const customer = await withTenantTransaction(db, { businessId }, async (tx) => {
    // No `deleted_at` filter here, unlike every read: a deleted customer is the
    // idempotent 204, not a 404.
    const [found] = await tx
      .select()
      .from(customers)
      .where(and(match, eq(customers.businessId, businessId)))
      .limit(1);

    if (found && !found.deletedAt) {
      await anonymiseCustomer(tx, { id: found.id, businessId });
    }

    return found;
  });

  if (!customer) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
  }

  scheduleWalletExpiry(c, { tenantId: businessId, customerId: customer.id });

  return c.body(null, 204);
}

/**
 * Ask the wallet worker to expire the customer's pass, after the anonymisation
 * has committed.
 *
 * The mirror of growth's `schedulePassReconcile`: the database is the fact,
 * the pass is a projection of it. Nothing here may fail or roll back a delete
 * that already happened. A failure is logged and the pass stays marked as not
 * expired, so the wallet's daily sweep retries it.
 */
export function scheduleWalletExpiry(
  c: Context<{ Bindings: Bindings }>,
  customer: { tenantId: string; customerId: string },
): void {
  const wallet = c.env?.WALLET;

  // Optional in `Bindings` and in practice: tests drive this app without it,
  // and a deploy that predates the binding has none either.
  if (!wallet) {
    console.error(
      `[customer] No WALLET service binding, so the pass for customer ${customer.customerId} in ` +
        `tenant ${customer.tenantId} was not expired. The daily sweep will pick it up.`,
    );
    return;
  }

  // Guarded apart from its promise: a binding that throws synchronously would
  // otherwise surface as a 500 for an account that is already deleted.
  let expiry: Promise<unknown>;
  try {
    expiry = wallet.expireCustomerPass(customer);
  } catch (err: unknown) {
    console.error(
      `[customer] Could not reach the wallet to expire the pass for customer ` +
        `${customer.customerId} in tenant ${customer.tenantId}:`,
      err,
    );
    return;
  }

  // Handled before it is handed over, so the promise `waitUntil` receives
  // cannot reject.
  const handled = expiry.catch((err: unknown) => {
    console.error(
      `[customer] Pass expiry failed for customer ${customer.customerId} in tenant ` +
        `${customer.tenantId}; the account is deleted and the daily sweep will expire the pass:`,
      err,
    );
  });

  // `c.executionCtx` throws when the app is driven without an ExecutionContext.
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }

  if (waitUntil === undefined) {
    console.error('[customer] No ExecutionContext to hand the pass expiry to, so it runs unattached.');
    return;
  }

  waitUntil(handled);
}
