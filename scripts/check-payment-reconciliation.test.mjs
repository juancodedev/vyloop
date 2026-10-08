// The reconciliation report is only worth having if it is honest about what it
// cannot do.
//
// Three properties, and they are the whole value of the script:
//
//   1. A settled payment with no checkin is reported, and exits non-zero.
//   2. The same payment with a checkin is not reported — otherwise the report is
//      noise and an operator learns to ignore it.
//   3. An unreachable database is reported BLOCKED, never as a clean reconciliation.
//
// Development tool test: kept beside the script it covers, outside `src`, so it is
// neither linted nor typechecked as product code.
import { describe, expect, it } from 'vitest';

import {
  BY_BUSINESS_SQL,
  LOST_SQL,
  SUMMARY_SQL,
  formatReport,
  observe,
} from './check-payment-reconciliation.mjs';

describe('the SQL it asks the database', () => {
  // Asserted on the text rather than on a database, because these run against a
  // live database in production and against no database here. The property that
  // matters is the `NOT EXISTS`, and a rewrite that drops it would make this script
  // report *every* payment as lost — which is a report nobody can read and an alert
  // that is immediately muted.
  it('looks for payments with no checkin, on every query', () => {
    for (const sql of [SUMMARY_SQL, BY_BUSINESS_SQL, LOST_SQL]) {
      expect(sql, 'a query would report every settled payment as lost').toContain('NOT EXISTS');
      expect(sql).toContain('settled_payments');
    }
  });

  it('matches on payment_id, because that is the column the terminal sends', () => {
    // `checkins.payment_id` exists precisely so the two sides can be compared; see
    // §4 of `api/docs/README.md`. Matching on anything else — a customer id, an
    // amount, a timestamp — would compare things that are not the same event.
    for (const sql of [SUMMARY_SQL, BY_BUSINESS_SQL, LOST_SQL]) {
      expect(sql).toContain('c.payment_id = s.payment_id');
    }
  });

  it('scopes the per-merchant queries by business as well', () => {
    // The rollup and the detail list report a merchant *by name*, so a payment id
    // matched across tenants would blame one merchant for another's un-attributed
    // sale. The summary deliberately does not: it counts payments, and a payment is
    // a payment.
    expect(BY_BUSINESS_SQL).toContain('c.business_id = s.business_id');
    expect(LOST_SQL).toContain('c.business_id = s.business_id');
  });

  it('bounds the list a person reads, and leaves the count unbounded', () => {
    // A merchant with ten thousand unattributed sales is a conversation, not a list.
    // The summary is what a monitoring job alerts on, so it must not be truncated —
    // a truncated count under-reports, which is the direction this script must
    // never fail in.
    expect(LOST_SQL).toContain('LIMIT 50');
    expect(SUMMARY_SQL).not.toMatch(/LIMIT/i);
    expect(BY_BUSINESS_SQL).not.toMatch(/LIMIT/i);
  });

  it('joins tenants so the report can name a merchant', () => {
    for (const sql of [BY_BUSINESS_SQL, LOST_SQL]) {
      expect(sql).toContain('JOIN tenants t ON t.id = s.business_id');
    }
  });
});

describe('a settled payment with no checkin is reported', () => {
  const observation = {
    reachable: true,
    summary: {
      perdidas: '2',
      monto_cents: '7500',
      mas_vieja: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      mas_reciente: new Date().toISOString(),
    },
    byBusiness: [{ negocio: 'Acme Coffee', business_id: 'b1', perdidas: '2', monto_cents: '7500', mas_vieja: new Date().toISOString() }],
    lost: [
      { payment_id: 'mp-1', negocio: 'Acme Coffee', amount_cents: 4500, received_at: new Date().toISOString() },
      { payment_id: 'mp-2', negocio: 'Acme Coffee', amount_cents: 3000, received_at: new Date().toISOString() },
    ],
  };

  it('names the count, the money and the merchant', () => {
    const { lines } = formatReport(observation);
    const report = lines.join('\n');

    expect(report).toContain('[LOST] 2 settled payment(s) with no checkin');
    expect(report).toContain('$75.00');
    expect(report).toContain('Acme Coffee');
    expect(report).toContain('mp-1');
    expect(report).toContain('mp-2');
  });

  it('exits non-zero, because there is something to look at', () => {
    expect(formatReport(observation).exitCode).toBe(1);
    // `--report` exists so a scheduled job can print the report without failing a
    // pipeline; the report itself must not change shape when it is used that way.
    expect(formatReport(observation, { reportOnly: true }).exitCode).toBe(0);
  });

  it('says what it cannot repair, in the report itself', () => {
    // The limitation has to travel with the output. A report that says "lost
    // attribution" and nothing else sends the reader looking for a repair button,
    // and the repair button must not exist: the webhook carries the payment and the
    // amount, and only the terminal knows a pass was scanned.
    // Whitespace-normalised, because the paragraph is wrapped to a terminal width
    // and a phrase that happens to straddle a line break is still the phrase. An
    // assertion that only survives at one wrap width is an assertion about the
    // wrapping, not about the warning.
    const report = formatReport(observation).lines.join('\n').replace(/\s+/g, ' ');

    expect(report).toMatch(/detects a lost attribution/i);
    expect(report).toMatch(/cannot repair one/i);
    expect(report).toMatch(/never WHOSE/i);
    expect(report).toMatch(/terminal resending the checkin, or a person asking the cashier/i);
    expect(report).toMatch(/no repair from here/i);
  });
});

describe('a settled payment that does have a checkin is not reported', () => {
  it('is clean and exits zero', () => {
    // The other half of the report's worth. `observe` would return this shape when
    // the `NOT EXISTS` matched nothing, which is every healthy merchant.
    const observation = {
      reachable: true,
      summary: {
        perdidas: '0',
        monto_cents: '0',
        mas_vieja: null,
        mas_reciente: null,
      },
      byBusiness: [],
      lost: [],
    };

    const { lines, exitCode } = formatReport(observation);

    expect(lines.join('\n')).toContain('[OK] every settled payment we recorded has a checkin');
    expect(exitCode).toBe(0);
  });

  it('does not print the recovery paragraph when there is nothing to recover', () => {
    // Printing "a webhook cannot repair one" under a clean report trains the reader
    // to skip the block, and then it is not there when there is something in it.
    const report = formatReport({
      reachable: true,
      summary: { perdidas: '0', monto_cents: '0', mas_vieja: null, mas_reciente: null },
      byBusiness: [],
      lost: [],
    })
      .lines.join('\n');

    expect(report).not.toContain('cannot repair one');
    expect(report).not.toContain('by merchant');
  });
});

describe('an unreachable database fails closed', () => {
  it('reports BLOCKED rather than a clean reconciliation, and exits non-zero', () => {
    // The failure mode this whole class of script exists to prevent: reporting
    // "every sale is attributed" from a database nobody could open. That is
    // indistinguishable from a real clean run, and the ambiguity is the bug.
    for (const error of [
      'DATABASE_URL is not set',
      'the database did not honour a read-only session; refusing to continue',
      'connect ECONNREFUSED 127.0.0.1:5432',
    ]) {
      const { lines, exitCode } = formatReport({ reachable: false, error });

      expect(lines.join('\n')).toContain('[BLOCKED]');
      expect(lines.join('\n')).not.toContain('[OK]');
      expect(lines.join('\n')).not.toContain('[LOST]');
      expect(exitCode).toBe(1);
    }
  });

  it('does not honour --report as a way to report blocked as clean', () => {
    // `--report` suppresses the exit code, not the finding. A blocked check that
    // exited 0 would be a green pipeline over an unanswered question.
    expect(formatReport({ reachable: false, error: 'boom' }, { reportOnly: true }).exitCode).toBe(1);
  });
});

describe('observe', () => {
  it('refuses to run without a database url, before opening anything', async () => {
    await expect(observe(undefined)).resolves.toEqual({
      reachable: false,
      error: 'DATABASE_URL is not set',
    });
  });

  it('fails closed on an unreachable database instead of returning a clean report', async () => {
    // Port 1 is reserved and nothing listens on it, so the connection genuinely
    // fails rather than reaching a real database. Without a timeout this would hang
    // rather than fail, which is why one is passed.
    const result = await observe('postgres://user:pass@127.0.0.1:1/nope', {
      connectTimeoutMs: 2_000,
    });

    // A resolved "not reachable" rather than a rejection: an operational script that
    // dumps a stack trace tells an operator less than one that says BLOCKED, and
    // distinguishing the two is this script's entire reason to exist.
    expect(result.reachable).toBe(false);
    expect(result.summary).toBeUndefined();
    expect(result.error).toMatch(/could not read the database/);
    // The driver's own message is kept -- it is the only part that tells "the host
    // is down" from "the password is wrong" -- and truncated so it cannot smear.
    expect(result.error.split('\n')).toHaveLength(1);

    const report = formatReport(result);
    expect(report.lines.join('\n')).toContain('[BLOCKED]');
    expect(report.exitCode).toBe(1);
  });
});