-- Store the purchase amount behind a points transaction.
--
-- ## What this closes
--
-- Unit 2 of `openspec/changes/customer-profile-redesign`: the profile timeline
-- shows what a customer spent, not only how many points they earned. Until now
-- `points_transactions` carried `points` and `balance_after` but never the sale
-- amount, so the profile could not answer "what did I spend".
--
-- ## Shape
--
-- `purchase_amount` is nullable: visits, redemptions and manual adjustments have
-- no sale behind them. A positive CHECK keeps a negative or zero amount from
-- being recorded as a purchase. The column is `numeric(12,2)` to match the
-- currency precision used elsewhere.
--
-- Applied in production by hand. `ADD COLUMN ... NULL` takes no lock on existing
-- rows, so no `CONCURRENTLY` is needed.
ALTER TABLE "points_transactions" ADD COLUMN "purchase_amount" numeric(12, 2);

ALTER TABLE "points_transactions" ADD CONSTRAINT "points_transactions_purchase_amount_positive"
  CHECK ("purchase_amount" IS NULL OR "purchase_amount" > 0);
