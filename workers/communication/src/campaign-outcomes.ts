import { sql } from 'drizzle-orm';

/**
 * What became of a campaign's browser notifications, read back from
 * `message_log`.
 *
 * A campaign's outcome is not stored anywhere of its own: `runPushCampaign`
 * computes it and returns it to the queue, and `push_campaigns` has no count
 * columns. What *is* stored is one `message_log` row per delivery attempt,
 * whose `content->>'reference_id'` is `<campaign reference>:<subscription id>`
 * (`push-delivery.ts`). So the counts are derived from those rows:
 *
 * - one delivery per distinct `reference_id`, because a retried delivery
 *   writes a new `queued` row each attempt;
 * - its outcome is `sent` if any attempt was sent, else `failed` if any
 *   failed, else still `queued`.
 *
 * Customers skipped for lack of consent or of a browser write no row, so they
 * are not counted here; the audience size is the campaign's own figure.
 */
export interface CampaignOutcome {
  delivered: number;
  failed: number;
  pending: number;
}

export interface CampaignFailure {
  customer_name: string | null;
  error: string | null;
  created_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { execute: (query: any) => Promise<{ rows: unknown[] }> };

const NO_DELIVERIES: CampaignOutcome = { delivered: 0, failed: 0, pending: 0 };

/**
 * The outcome of each campaign in `referenceIds`, keyed by reference.
 *
 * Matched with `starts_with` on `<reference>:`, like the composing route's
 * duplicate probe, so a reference holding `_`, `%` or `:` is compared
 * literally.
 */
export async function readCampaignOutcomes(
  db: Db,
  businessId: string,
  referenceIds: string[],
): Promise<Map<string, CampaignOutcome>> {
  const outcomes = new Map<string, CampaignOutcome>();
  if (referenceIds.length === 0) return outcomes;

  const refs = sql.join(
    referenceIds.map((ref) => sql`${ref}`),
    sql`, `,
  );

  const result = await db.execute(sql`
    SELECT ref AS reference_id,
      count(*) FILTER (WHERE outcome = 'sent')::int AS delivered,
      count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
      count(*) FILTER (WHERE outcome = 'queued')::int AS pending
    FROM (
      SELECT r.ref,
        CASE
          WHEN bool_or(m.status = 'sent') THEN 'sent'
          WHEN bool_or(m.status = 'failed') THEN 'failed'
          ELSE 'queued'
        END AS outcome
      FROM unnest(ARRAY[${refs}]::text[]) AS r(ref)
      JOIN message_log m
        ON m.business_id = ${businessId}
        AND m.channel = 'push'
        AND starts_with(m.content->>'reference_id', r.ref || ':')
      GROUP BY r.ref, m.content->>'reference_id'
    ) deliveries
    GROUP BY ref
  `);

  for (const row of result.rows as Array<Record<string, unknown>>) {
    outcomes.set(String(row.reference_id), {
      delivered: Number(row.delivered ?? 0),
      failed: Number(row.failed ?? 0),
      pending: Number(row.pending ?? 0),
    });
  }
  for (const ref of referenceIds) {
    if (!outcomes.has(ref)) outcomes.set(ref, { ...NO_DELIVERIES });
  }
  return outcomes;
}

/**
 * The deliveries of one campaign that failed for good, newest first, with the
 * customer's name and the reason the worker stored in `metadata.error`.
 *
 * A delivery that failed and then succeeded on a retry is not a failure, so
 * only references with no `sent` attempt are listed. The customer is joined
 * on the business as well as the id.
 */
export async function readCampaignFailures(
  db: Db,
  businessId: string,
  referenceId: string,
  limit = 50,
): Promise<CampaignFailure[]> {
  const result = await db.execute(sql`
    SELECT customer_name, error, created_at FROM (
      SELECT DISTINCT ON (m.content->>'reference_id')
        c.full_name AS customer_name,
        m.metadata->>'error' AS error,
        m.created_at
      FROM message_log m
      LEFT JOIN customers c
        ON c.id = m.customer_id AND c.business_id = m.business_id
      WHERE m.business_id = ${businessId}
        AND m.channel = 'push'
        AND m.status = 'failed'
        AND starts_with(m.content->>'reference_id', ${`${referenceId}:`})
        AND NOT EXISTS (
          SELECT 1 FROM message_log s
          WHERE s.business_id = m.business_id
            AND s.channel = 'push'
            AND s.status = 'sent'
            AND s.content->>'reference_id' = m.content->>'reference_id'
        )
      ORDER BY m.content->>'reference_id', m.created_at DESC
    ) failures
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>)
    .map((row) => ({
      customer_name: row.customer_name == null ? null : String(row.customer_name),
      error: row.error == null ? null : String(row.error),
      // A raw query hands timestamptz back as Postgres text
      // (`2026-10-28 12:00:00+00`), which Safari cannot parse; send ISO like
      // the rest of the response.
      created_at: new Date(String(row.created_at)).toISOString(),
    }));
}
