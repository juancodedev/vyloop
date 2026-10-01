import { describe, expect, it } from 'vitest';

import { buildLoyaltyClass, reviewStatusBlocksObjects } from './class';
import { isValidGoogleId } from './ids';

const ISSUER = '338800013922057609515';
const TENANT_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const baseInput = {
  issuerId: ISSUER,
  tenantId: TENANT_UUID,
  issuerName: 'Café Origen',
  programName: 'Puntos Café Origen',
  countryCode: 'CL',
  reviewStatus: 'DRAFT' as const,
};

describe('buildLoyaltyClass', () => {
  it('carries only the documented fields when given nothing optional', () => {
    const loyaltyClass = buildLoyaltyClass(baseInput);
    expect(loyaltyClass).toEqual({
      id: `${ISSUER}.tenant-${TENANT_UUID}`,
      issuerName: 'Café Origen',
      // Not optional: `localizedIssuerName` is the field Google's loyalty pass
      // renders at the top, and it is derived from the same required
      // `issuerName` rather than being a second thing the caller has to supply.
      localizedIssuerName: { defaultValue: { language: 'es-CL', value: 'Café Origen' } },
      programName: 'Puntos Café Origen',
      reviewStatus: 'DRAFT',
      countryCode: 'CL',
    });
  });

  it('localises the issuer name rather than leaving a flat string for the header', () => {
    // `issuerName` is the deprecated flat field. Google's own loyalty pass reads
    // `localizedIssuerName`, so a class carrying only the flat one shows the
    // platform's name — or nothing the merchant recognises — where their own
    // business name belongs.
    const loyaltyClass = buildLoyaltyClass(baseInput);

    expect(loyaltyClass.localizedIssuerName).toEqual({
      defaultValue: { language: 'es-CL', value: 'Café Origen' },
    });
  });

  it('localises the very name it was given, including one Google will ellipsise', () => {
    // The merchant's real name, whole. Truncating the localised copy while
    // keeping the flat one would produce a class whose two names disagree.
    const longName = 'Café Central de Providencia';
    const loyaltyClass = buildLoyaltyClass({ ...baseInput, issuerName: longName });

    expect(loyaltyClass.localizedIssuerName).toEqual({
      defaultValue: { language: 'es-CL', value: longName },
    });
    expect(loyaltyClass.issuerName).toBe(longName);
  });

  it('carries the homepage the pass links to, because Google rejects a class without one', () => {
    // docs/11 records `homepageUri` as the most common reason a loyalty class
    // fails Google's review, so it is not a cosmetic field.
    const loyaltyClass = buildLoyaltyClass({
      ...baseInput,
      homepageUri: {
        uri: 'https://media.juancode.dev/program',
        description: 'Programa de lealtad',
      },
    });

    expect(loyaltyClass.homepageUri).toEqual({
      uri: 'https://media.juancode.dev/program',
      description: 'Programa de lealtad',
    });
  });

  it('produces a Google-valid class id', () => {
    expect(isValidGoogleId(buildLoyaltyClass(baseInput).id)).toBe(true);
  });

  it('omits every optional field rather than substituting a placeholder', () => {
    // Constraint 3: no placeholder merchant name, no fake logo URL, no default
    // background colour. A `programLogo` pointing at a Google stock image would
    // put a stranger's branding in front of a real customer.
    const loyaltyClass = buildLoyaltyClass(baseInput);
    expect(loyaltyClass).not.toHaveProperty('programLogo');
    expect(loyaltyClass).not.toHaveProperty('issuerLogo');
    expect(loyaltyClass).not.toHaveProperty('hexBackgroundColor');
    expect(loyaltyClass).not.toHaveProperty('accountNameLabel');
    expect(loyaltyClass).not.toHaveProperty('accountIdLabel');
    expect(loyaltyClass).not.toHaveProperty('rewardsTierLabel');
    // Nothing invents a homepage either: there is no tenant homepage this
    // repository can derive, so the field is absent unless a caller supplied
    // one. A made-up URL is a link a merchant's customer taps.
    expect(loyaltyClass).not.toHaveProperty('homepageUri');
  });

  it('includes the optional fields it is given', () => {
    const programLogo = { sourceUri: { uri: 'https://cdn.vyloop.app/cafe-origen/logo.png' } };
    const loyaltyClass = buildLoyaltyClass({
      ...baseInput,
      programLogo,
      issuerLogo: programLogo,
      hexBackgroundColor: '#1F3A2E',
      accountNameLabel: 'Nombre',
      accountIdLabel: 'Código',
      rewardsTierLabel: 'Nivel',
    });
    expect(loyaltyClass.programLogo).toEqual(programLogo);
    expect(loyaltyClass.issuerLogo).toEqual(programLogo);
    expect(loyaltyClass.hexBackgroundColor).toBe('#1F3A2E');
    expect(loyaltyClass.accountNameLabel).toBe('Nombre');
    expect(loyaltyClass.accountIdLabel).toBe('Código');
    expect(loyaltyClass.rewardsTierLabel).toBe('Nivel');
  });

  it('does not truncate issuerName or programName', () => {
    // Google may ellipsise both after 20 characters in its own display. That is
    // Google's decision; truncating here would store a corrupted merchant name
    // that a later patch carrying the full value could not be distinguished
    // from a deliberate rename.
    const longIssuerName = 'Panadería y Cafetería La Esquina Nr. 42';
    const longProgramName = 'Programa de Puntos y Recompensas La Esquina';
    const loyaltyClass = buildLoyaltyClass({
      ...baseInput,
      issuerName: longIssuerName,
      programName: longProgramName,
    });
    expect(loyaltyClass.issuerName).toBe(longIssuerName);
    expect(loyaltyClass.programName).toBe(longProgramName);
    expect(loyaltyClass.issuerName.length).toBeGreaterThan(20);
    expect(loyaltyClass.programName.length).toBeGreaterThan(20);
  });

  it('normalises the country code to uppercase without truncating it', () => {
    // Normalisation, not truncation: ISO 3166-1 alpha-2 is defined in
    // uppercase and `tenants.country` is free text, so `cl` and `CL` are one
    // country and must not produce two classes.
    expect(classForCountry(' cl ').countryCode).toBe('CL');
    expect(classForCountry('cl').countryCode).toBe('CL');
    expect(classForCountry('CL').countryCode).toBe('CL');
    expect(classForCountry('cl').id).toBe(classForCountry('CL').id);
  });

  it('rejects a blank issuer name rather than sending an empty required field', () => {
    expect(() => buildLoyaltyClass({ ...baseInput, issuerName: '' })).toThrow(/tenants\.name/);
    expect(() => buildLoyaltyClass({ ...baseInput, issuerName: '   ' })).toThrow(/tenants\.name/);
  });

  it('rejects a blank program name', () => {
    expect(() => buildLoyaltyClass({ ...baseInput, programName: '' })).toThrow(
      /loyalty_programs\.name/,
    );
  });

  it('rejects a blank country code', () => {
    expect(() => buildLoyaltyClass({ ...baseInput, countryCode: '  ' })).toThrow(
      /tenants\.country/,
    );
  });

  it('passes the review status through unchanged', () => {
    for (const reviewStatus of ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'] as const) {
      expect(buildLoyaltyClass({ ...baseInput, reviewStatus }).reviewStatus).toBe(reviewStatus);
    }
  });

  it('never emits the deprecated camelCase review status spellings', () => {
    // Google's `ReviewStatus` documents `draft`, `underReview`, `approved` and
    // `rejected` as legacy aliases. They still work, so nothing would fail
    // loudly if one leaked in.
    for (const [legacy, current] of [
      ['draft', 'DRAFT'],
      ['underReview', 'UNDER_REVIEW'],
      ['approved', 'APPROVED'],
      ['rejected', 'REJECTED'],
    ] as const) {
      const emitted = buildLoyaltyClass({
        ...baseInput,
        reviewStatus: current,
      });
      expect(emitted.reviewStatus).toBe(current);
      expect(emitted.reviewStatus).not.toBe(legacy);
    }
  });
});

describe('reviewStatusBlocksObjects', () => {
  it('blocks object creation for every state Google will not accept', () => {
    // A `DRAFT` class "cannot be used to create any object", and an object
    // requires an approved class. A rejected class is terminal and equally
    // unusable.
    expect(reviewStatusBlocksObjects('DRAFT')).toBe(true);
    expect(reviewStatusBlocksObjects('UNDER_REVIEW')).toBe(true);
    expect(reviewStatusBlocksObjects('REJECTED')).toBe(true);
  });

  it('allows object creation only once approved', () => {
    expect(reviewStatusBlocksObjects('APPROVED')).toBe(false);
  });
});

function classForCountry(countryCode: string) {
  return buildLoyaltyClass({ ...baseInput, countryCode });
}
