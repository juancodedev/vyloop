# Delta for migration-drift-gate

## ADDED Requirements

### Requirement: Row-Level Security Evidence

`extractAssertions` in `scripts/check-migration-drift.mjs` MUST recognise `ALTER TABLE "<t>" ENABLE ROW LEVEL SECURITY` as an `rls` assertion named `<t>`, and `CREATE POLICY <p> ON "<t>" ...` as a `policy` assertion named `<t>.<p>`. `observeDatabase` MUST collect the matching facts from `pg_class.relrowsecurity` (for tables in the current schema) and from `pg_policies`, and `unsatisfiedBaseline` MUST report a registered `rls` or `policy` assertion that the live database does not satisfy.

`FORCE ROW LEVEL SECURITY`, `CREATE ROLE` and `GRANT` MUST remain unsupported statements that the gate refuses.

#### Scenario: An RLS migration is registered as evidence

- GIVEN a migration containing `ALTER TABLE "customer_wallet_passes" ENABLE ROW LEVEL SECURITY` and `CREATE POLICY tenant_isolation ON "customer_wallet_passes" ...`
- WHEN `extractAssertions` reads it
- THEN it returns `{ kind: 'rls', name: 'customer_wallet_passes' }` and `{ kind: 'policy', name: 'customer_wallet_passes.tenant_isolation' }`

#### Scenario: The database did not get the policy

- GIVEN a baseline entry asserting `customer_wallet_passes.tenant_isolation`
- WHEN the live `pg_policies` has no such policy
- THEN `pnpm db:drift` fails and names the missing policy

#### Scenario: A role statement is still refused

- GIVEN a migration containing `GRANT SELECT ON "customers" TO vyloop_app`
- WHEN `extractAssertions` reads it
- THEN it throws an unsupported-statement error
