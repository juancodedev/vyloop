import { createDb, messageLog, branches } from '@vyloop/db';
import { PUSH_CAMPAIGN_REQUESTED, createEnvelope, publish } from '@vyloop/event-bus';
import { getRequestId } from '@vyloop/request-context';
import { requireOperatorRole } from '@vyloop/types';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Bindings } from './helpers';
import { extractAuthHeaders, withRls } from './helpers';
import type { PushCampaignPayload, PushCampaignTarget } from './push-campaigns';
import { resolveCampaignAudience } from './push-campaigns';
import { findBranchesInRadius } from '../../../packages/db/src/proximity';

// ---------------------------------------------------------------------------
// Composing a push campaign.
//
// A campaign is a message a business sends to a place: to one venue, or to
// everything within a radius of a point. It is an operator action, it is
// composed as an event rather than delivered inline, and the audience is
// resolved on the server.
//
// ## Why the audience is resolved here
//
// The route never accepts a list of customers. A request that named them
// would be a request that could push to anybody, and the "audience" of a
// proximity campaign is a fact about the world — who was at which venue —
// not a fact the caller is entitled to assert. So the request names a target,
// and the count that comes back is the only thing the caller learns about
// who received it.
//
// The count is resolved here, and the campaign is delivered later, by the
// queue: the delivery re-checks the consent at the moment it sends, and a
// customer who withdrew in between must not be reached. The count in the
// response is therefore the audience as it was when the campaign was
// composed, which is the only honest thing to report.
//
// ## Idempotency
//
// A campaign composed twice with the same `reference_id` is one campaign. The
// deliveries of a campaign write their reference as `<reference id>:<the
// subscription id>`, so the probe looks for that prefix: the campaign's own
// rows are the evidence that it was already composed, and the other
// subscribers of that campaign are not blocked by it.
//
// ## The operator guard
//
// The same shared guard every operator route in this repository uses: it
// refuses the customer app's token and a counter's, with one code and one
// message, so the refusal is not an inventory of which kinds of subject
// exist. A customer is reached by the campaigns their business composes; a
// customer does not compose one.
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

/**
 * The largest radius a campaign may name.
 *
 * Fifty kilometres. A radius is a place a person could be, not a region of a
 * country: past this the "venues near this point" are not near anything, and
 * the campaign stops meaning what its target says it means.
 */
export const MAX_CAMPAIGN_RADIUS_METERS = 50_000;

/**
 * The message a refused operator route answers with.
 *
 * A parameter of the shared guard rather than a fact of it: the decision is
 * shared, and the prose about it is about this route.
 */
const OPERATOR_ROLE_REQUIRED_MESSAGE =
  'Only a merchant can compose a push campaign. Customers are reached by the campaigns their business composes.';

/** The shape of a uuid, so a malformed id is refused rather than queried. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A campaign request, once the body has been read and checked. */
interface ParsedCampaignRequest {
  title: string;
  body: string;
  url?: string;
  reference_id?: string;
  target: PushCampaignTarget;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Read the target of a campaign.
 *
 * **Exactly one** of the two forms. Both at once is ambiguous, and neither is
 * no target at all, and an ambiguous target that is quietly resolved one way
 * is how a campaign ends up reaching the wrong people.
 */
function parseTarget(value: unknown): ParseResult<PushCampaignTarget> {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, message: 'target is required.' };
  }

  const candidate = value as Record<string, unknown>;
  const hasBranch = 'branch_id' in candidate;
  const hasRadius =
    'latitude' in candidate || 'longitude' in candidate || 'radius_m' in candidate;

  if (hasBranch && hasRadius) {
    return {
      ok: false,
      message:
        'target is exactly one of a branch_id, or a latitude and a longitude and a radius_m — never both.',
    };
  }

  if (hasBranch) {
    const branchId = candidate.branch_id;

    // A uuid, because the id is compared against a uuid column and a
    // malformed one is a database error rather than an empty result.
    if (typeof branchId !== 'string' || !UUID_PATTERN.test(branchId)) {
      return { ok: false, message: 'target.branch_id must be a uuid.' };
    }

    return { ok: true, value: { branch_id: branchId } };
  }

  if (hasRadius) {
    const { latitude, longitude, radius_m: radiusMeters } = candidate;

    if (
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      return { ok: false, message: 'target.latitude must be a number between -90 and 90.' };
    }

    if (
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return { ok: false, message: 'target.longitude must be a number between -180 and 180.' };
    }

    if (
      typeof radiusMeters !== 'number' ||
      !Number.isInteger(radiusMeters) ||
      radiusMeters < 1 ||
      radiusMeters > MAX_CAMPAIGN_RADIUS_METERS
    ) {
      return {
        ok: false,
        message: `target.radius_m must be a positive integer of at most ${MAX_CAMPAIGN_RADIUS_METERS} metres.`,
      };
    }

    return { ok: true, value: { latitude, longitude, radius_m: radiusMeters } };
  }

  return {
    ok: false,
    message:
      'target is exactly one of a branch_id, or a latitude and a longitude and a radius_m.',
  };
}

/**
 * Read a campaign request.
 *
 * Everything the caller may say, and nothing it may not: the message itself,
 * the optional link it carries, its own reference, and the target.
 */
function parseCampaignRequest(body: unknown): ParseResult<ParsedCampaignRequest> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'The body must be a JSON object.' };
  }

  const candidate = body as Record<string, unknown>;

  if (typeof candidate.title !== 'string' || candidate.title.trim() === '') {
    return { ok: false, message: 'title is required and must be a non-empty string.' };
  }

  if (typeof candidate.body !== 'string' || candidate.body.trim() === '') {
    return { ok: false, message: 'body is required and must be a non-empty string.' };
  }

  if (candidate.url !== undefined && typeof candidate.url !== 'string') {
    return { ok: false, message: 'url must be a string when it is present.' };
  }

  if (
    candidate.reference_id !== undefined &&
    (typeof candidate.reference_id !== 'string' || candidate.reference_id.trim() === '')
  ) {
    return { ok: false, message: 'reference_id must be a non-empty string when it is present.' };
  }

  const target = parseTarget(candidate.target);
  if (!target.ok) {
    return target;
  }

  return {
    ok: true,
    value: {
      title: candidate.title,
      body: candidate.body,
      ...(candidate.url !== undefined ? { url: candidate.url } : {}),
      ...(candidate.reference_id !== undefined
        ? { reference_id: candidate.reference_id }
        : {}),
      target: target.value,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /v1/communication/push/campaigns
// ---------------------------------------------------------------------------

router.post('/v1/communication/push/campaigns', async (c) => {
  const auth = extractAuthHeaders(c);

  // Before the body, before the database, before anything is read: the guard
  // reads nothing and writes nothing, so an unauthorized caller cannot make
  // the route do work on their behalf.
  const gate = requireOperatorRole(auth, OPERATOR_ROLE_REQUIRED_MESSAGE);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }

  const { businessId } = auth;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'The body must be JSON.' } },
      422,
    );
  }

  const parsed = parseCampaignRequest(body);
  if (!parsed.ok) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.message } }, 422);
  }

  const dryRun = c.req.query('dry_run') === 'true';

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // The campaign's reference. A campaign that names none gets one, because
  // the reference is what names its rows and what a second composition of the
  // same campaign is refused on.
  const referenceId = parsed.value.reference_id ?? crypto.randomUUID();

  // -----------------------------------------------------------------------
  // The duplicate probe (skipped on dry-run: a preview is not a composition)
  // -----------------------------------------------------------------------
  if (!dryRun) {
    const [existing] = await db
    .select({ id: messageLog.id })
    .from(messageLog)
    .where(
      and(
        eq(messageLog.businessId, businessId),
        // A literal prefix comparison, not `LIKE`: an operator's reference may
        // hold `_` or `%`, and as a pattern `promo_1` would match `promo-1`.
        // `starts_with` and not `left(…, n)`: a length measured in JavaScript
        // counts UTF-16 units and Postgres counts characters, so an emoji in
        // the reference would make the two disagree.
        sql`starts_with(${messageLog.content}->>'reference_id', ${`${referenceId}:`})`,
      ),
    )
    .limit(1);

  if (existing) {
    return c.json(
      {
        error: {
          code: 'DUPLICATE_MESSAGE',
          message: 'A campaign with this reference already exists.',
        },
      },
      409,
    );
  }
  }

  // -----------------------------------------------------------------------
  // The audience
  // -----------------------------------------------------------------------
  // Resolved on the server, from the interactions at the target's venues.
  const audience = await resolveCampaignAudience(db, businessId, parsed.value.target);

  // Per-branch breakdown (name + distance) for the preview/detail views.
  let perBranch: Array<{ branch_id: string; name: string; distance_m: number }> = [];
  if ('branch_id' in parsed.value.target) {
    const [branch] = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.id, parsed.value.target.branch_id))
      .limit(1);
    if (branch) {
      perBranch = [{ branch_id: branch.id, name: branch.name, distance_m: 0 }];
    }
  } else {
    const found = await findBranchesInRadius(db, {
      businessId,
      latitude: parsed.value.target.latitude,
      longitude: parsed.value.target.longitude,
      radiusMeters: parsed.value.target.radius_m,
    });
    perBranch = found.map((b) => ({ branch_id: b.id, name: b.name, distance_m: b.distanceMeters }));
  }

  if (dryRun) {
    return c.json(
      { reference_id: referenceId, audience_size: audience.length, per_branch: perBranch },
      202,
    );
  }

  const payload: PushCampaignPayload = {
    business_id: businessId,
    title: parsed.value.title,
    body: parsed.value.body,
    ...(parsed.value.url !== undefined ? { url: parsed.value.url } : {}),
    reference_id: referenceId,
    target: parsed.value.target,
  };

  await publish(
    c.env.DELIVERY_QUEUE,
    createEnvelope(
      PUSH_CAMPAIGN_REQUESTED,
      { business_id: businessId, timestamp: new Date().toISOString(), request_id: getRequestId(c) },
      payload,
    ),
  );

  return c.json({ reference_id: referenceId, audience_size: audience.length }, 202);
});

export default router;
