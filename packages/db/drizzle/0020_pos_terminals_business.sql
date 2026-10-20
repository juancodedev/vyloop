-- Index for `GET /v1/loyalty/terminals` (workers/growth/src/routes.ts): filter by
-- tenant, newest first. Shape matches the query, so the tenant scan goes away.
--
-- Applied in production by hand with `CONCURRENTLY`, because a plain
-- `CREATE INDEX` takes a write lock on `pos_terminals` and this table is on the
-- path of every terminal installation. The concurrent form cannot run inside a
-- transaction, which is why it is not the statement below.
CREATE INDEX "idx_pos_terminals_business" ON "pos_terminals" USING btree ("business_id","created_at" DESC NULLS LAST);
