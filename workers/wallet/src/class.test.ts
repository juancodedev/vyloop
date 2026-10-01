import { describe, expect, it } from 'vitest';

import {
  buildLoyaltyClass,
  GOOGLE_LABEL_MAX_LENGTHS,
  PROMO_COPY_HEADER,
  PROMO_COPY_MODULE_ID,
  reviewStatusBlocksObjects,
} from './class';
import {
  heroImageFor,
  MAX_STAMP_LEVEL,
  STAMP_LEVEL_IMAGE_COUNT,
  STAMPS_FOR_REWARD,
} from './hero-image';
import { isValidGoogleId } from './ids';
import { buildLoyaltyObject } from './object';

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
      hexBackgroundColor: '#1F3A2E',
      accountNameLabel: 'Nombre',
      accountIdLabel: 'Código',
      rewardsTierLabel: 'Nivel',
    });
    expect(loyaltyClass.programLogo).toEqual(programLogo);
    expect(loyaltyClass.hexBackgroundColor).toBe('#1F3A2E');
    expect(loyaltyClass.accountNameLabel).toBe('Nombre');
    expect(loyaltyClass.accountIdLabel).toBe('Código');
    expect(loyaltyClass.rewardsTierLabel).toBe('Nivel');
  });

  // -------------------------------------------------------------------------
  // Fields Google does not have
  // -------------------------------------------------------------------------

  it('emits no field Google does not declare, so nothing is silently discarded', () => {
    // `issuerLogo` used to be declared on `LoyaltyClass`, accepted by
    // `BuildLoyaltyClassInput` and copied into the payload. Google has no such
    // field on a loyalty class — verified against the API discovery document,
    // revision 20261001, where no schema declares it. docs/11 records the same
    // for `logo`, `largeLogo` and `smallLogo`: sending them "no da error, los
    // descarta en silencio".
    //
    // The circular logo on the reference product is `programLogo`, which is
    // `programLogo` in Google's vocabulary, and `provision.ts` already points it
    // at the gateway brand route.
    //
    // So this is a whitelist rather than a blacklist: any field this builder
    // grows that Google does not accept is caught here, including the next one.
    // The list is Google's `LoyaltyClass` property set, verbatim.
    const GOOGLE_LOYALTY_CLASS_FIELDS = new Set([
      'kind',
      'programName',
      'programLogo',
      'wideProgramLogo',
      'accountNameLabel',
      'accountIdLabel',
      'rewardsTierLabel',
      'rewardsTier',
      'localizedProgramName',
      'localizedAccountNameLabel',
      'localizedAccountIdLabel',
      'localizedRewardsTierLabel',
      'localizedRewardsTier',
      'secondaryRewardsTierLabel',
      'secondaryRewardsTier',
      'localizedSecondaryRewardsTierLabel',
      'localizedSecondaryRewardsTier',
      'discoverableProgram',
      'classTemplateInfo',
      'id',
      'version',
      'issuerName',
      'messages',
      'allowMultipleUsersPerObject',
      'homepageUri',
      'locations',
      'reviewStatus',
      'review',
      'infoModuleData',
      'imageModulesData',
      'textModulesData',
      'linksModuleData',
      'redemptionIssuers',
      'countryCode',
      'heroImage',
      'wordMark',
      'enableSmartTap',
      'hexBackgroundColor',
      'localizedIssuerName',
      'multipleDevicesAndHoldersAllowedStatus',
      'callbackOptions',
      'securityAnimation',
      'viewUnlockRequirement',
      'appLinkData',
      'merchantLocations',
      'valueAddedModuleData',
      'notifyPreference',
    ]);

    const fullyPopulated = buildLoyaltyClass({
      ...baseInput,
      programLogo: { sourceUri: { uri: 'https://media.juancode.dev/brand/t.jpg' } },
      homepageUri: { uri: 'https://vyloop-customer-web.pages.dev/program', description: 'Programa' },
      hexBackgroundColor: '#1F3A2E',
      accountNameLabel: 'Cliente',
      accountIdLabel: 'Código',
      rewardsTierLabel: 'Nivel',
      promoCopy: '¡Cada 10 sellos, un burger gratis!',
      links: [
        { uri: 'https://vyloop-customer-web.pages.dev/profile', description: 'Ver mi perfil' },
      ],
    });

    const undeclared = Object.keys(fullyPopulated).filter(
      (key) => !GOOGLE_LOYALTY_CLASS_FIELDS.has(key),
    );
    expect(undeclared).toEqual([]);
  });

  it('omits issuerLogo even when a caller still passes one', () => {
    // Belt and braces against the old declaration coming back through a spread
    // or a cast. The type no longer offers it, so this passes a value the way
    // JavaScript still can.
    const loyaltyClass = buildLoyaltyClass({
      ...baseInput,
      issuerLogo: { sourceUri: { uri: 'https://cdn.vyloop.app/logo.png' } },
    } as Parameters<typeof buildLoyaltyClass>[0]);

    expect(loyaltyClass).not.toHaveProperty('issuerLogo');
    expect(JSON.stringify(loyaltyClass)).not.toContain('issuerLogo');
  });

  // -------------------------------------------------------------------------
  // Merchant copy, on the class
  // -------------------------------------------------------------------------

  it('carries the merchant promo copy as a class text module', () => {
    const loyaltyClass = buildLoyaltyClass({
      ...baseInput,
      promoCopy: '¡Cada 10 sellos, un burger gratis!',
    });

    expect(loyaltyClass.textModulesData).toEqual([
      {
        id: PROMO_COPY_MODULE_ID,
        header: PROMO_COPY_HEADER,
        body: '¡Cada 10 sellos, un burger gratis!',
      },
    ]);
  });

  it('omits the promo copy rather than substituting a default or an empty row', () => {
    // The case that is actually a merchant: a business that wrote no promotion.
    // Every other text column in `loyalty_programs` has a default, and copying
    // that here would put a generic sentence in front of a real comensal. An
    // empty `body` is worse still: Google renders a header over nothing.
    expect(buildLoyaltyClass(baseInput).textModulesData).toBeUndefined();
    expect(buildLoyaltyClass({ ...baseInput, promoCopy: '' }).textModulesData).toBeUndefined();
    expect(buildLoyaltyClass({ ...baseInput, promoCopy: '   ' }).textModulesData).toBeUndefined();
  });

  it('puts the merchant copy on the class, so one patch reaches every customer', () => {
    // Not a rendering assertion. Google combines class and object text modules
    // ("both will be displayed", 10 each), so the object's tier row survives —
    // and the promotion is per-merchant, so N object patches would be the wrong
    // shape for it.
    const withCopy = buildLoyaltyClass({ ...baseInput, promoCopy: 'Diez sellos, uno gratis' });

    const object = buildLoyaltyObject({
      issuerId: ISSUER,
      classId: `${ISSUER}.tenant-${TENANT_UUID}`,
      customerId: 'c-1',
      customerGlobalId: '9f2504e0-4f89-11d3-9a0c-0305e82c3301',
      customerFullName: 'Juan Muñoz',
      memberCode: 'K7M2QP',
      balancePoints: 3,
      pointsCurrency: 'puntos',
      tierName: 'Burger',
      tierHeader: 'Nivel',
      passState: 'issued',
    });

    // The object's own tier row is intact and separate.
    expect(object.textModulesData).toEqual([
      { id: 'REWARDS_TIER', header: 'Nivel', body: 'Burger' },
    ]);
    expect(withCopy.textModulesData?.[0]?.id).toBe(PROMO_COPY_MODULE_ID);
  });

  it('carries the links on the class, as uris under linksModuleData', () => {
    // Not `links`: that is not a Google field. `linksModuleData.uris` is, and it
    // exists on both sides — the class is right because a link is per-merchant.
    const loyaltyClass = buildLoyaltyClass({
      ...baseInput,
      links: [
        { uri: 'https://vyloop-customer-web.pages.dev/profile', description: 'Ver mi perfil' },
        { uri: 'https://vyloop-customer-web.pages.dev/profile/history', description: 'Mi historial' },
      ],
    });

    expect(loyaltyClass.linksModuleData).toEqual({
      uris: [
        { uri: 'https://vyloop-customer-web.pages.dev/profile', description: 'Ver mi perfil' },
        { uri: 'https://vyloop-customer-web.pages.dev/profile/history', description: 'Mi historial' },
      ],
    });
  });

  it('omits linksModuleData rather than sending an empty list', () => {
    expect(buildLoyaltyClass(baseInput).linksModuleData).toBeUndefined();
    expect(buildLoyaltyClass({ ...baseInput, links: [] }).linksModuleData).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Character limits
  // -------------------------------------------------------------------------

  it('refuses a label Google would ellipsise, before the insert', () => {
    // "Puntos disponibles" is 18 characters against a documented 15 for
    // `rewardsTierLabel`. Google does not reject it: it ellipsises and the
    // insert returns 200, so the only symptom is a comensal reading
    // "Puntos disponibl…". The build has to refuse instead, and name the limit.
    const tooLong = 'x'.repeat(GOOGLE_LABEL_MAX_LENGTHS.rewardsTierLabel + 1);

    expect(() => buildLoyaltyClass({ ...baseInput, rewardsTierLabel: tooLong })).toThrow(
      /rewardsTierLabel.*\b9\b|max(?:imum)? of 9|maximum of 9/s,
    );
  });

  it('names the field and the limit in the error, not just that something is long', () => {
    const tooLong = 'x'.repeat(GOOGLE_LABEL_MAX_LENGTHS.accountNameLabel + 1);
    expect(() => buildLoyaltyClass({ ...baseInput, accountNameLabel: tooLong })).toThrow(
      new RegExp(`accountNameLabel[\\s\\S]{0,80}?${GOOGLE_LABEL_MAX_LENGTHS.accountNameLabel}\\b`),
    );
  });

  it('accepts a label exactly at the limit and refuses one character past it', () => {
    const max = GOOGLE_LABEL_MAX_LENGTHS.accountIdLabel;
    expect(buildLoyaltyClass({ ...baseInput, accountIdLabel: 'x'.repeat(max) }).accountIdLabel).toBe(
      'x'.repeat(max),
    );
    expect(() => buildLoyaltyClass({ ...baseInput, accountIdLabel: 'x'.repeat(max + 1) })).toThrow(
      /accountIdLabel/,
    );
  });

  it('refuses promo copy longer than Google displays on a text module', () => {
    const tooLong = 'x'.repeat(GOOGLE_LABEL_MAX_LENGTHS.textModuleBody + 1);
    expect(() => buildLoyaltyClass({ ...baseInput, promoCopy: tooLong })).toThrow(
      /textModulesData\[PROMO_COPY\]|PROMO_COPY|body/,
    );
  });

  it('refuses a link description longer than Google displays next to the link', () => {
    const tooLong = 'x'.repeat(GOOGLE_LABEL_MAX_LENGTHS.uriDescription + 1);
    expect(() =>
      buildLoyaltyClass({
        ...baseInput,
        links: [{ uri: 'https://vyloop-customer-web.pages.dev/profile', description: tooLong }],
      }),
    ).toThrow(/description/);
  });

  it('keeps its own promo header inside the limit it enforces', () => {
    // The guard would reject the builder's own constant and every merchant with
    // a promo would fail to provision, which reads as a database fault.
    expect(PROMO_COPY_HEADER.length).toBeLessThanOrEqual(
      GOOGLE_LABEL_MAX_LENGTHS.textModuleHeader,
    );
  });

  // -------------------------------------------------------------------------
  // No hero image
  // -------------------------------------------------------------------------

  it('emits no heroImage, because a placeholder renders as a broken asset', () => {
    // Google fetches `heroImage` from the URL itself, so a placeholder filename
    // is a 404 rendered as an empty band across the top of the card. There is
    // no image generation in this repository, so every URL available today
    // would fail. No hero is a clean card; a broken hero is not.
    const loyaltyClass = buildLoyaltyClass({
      ...baseInput,
      programLogo: { sourceUri: { uri: 'https://media.juancode.dev/brand/t.jpg' } },
      promoCopy: 'Diez sellos, uno gratis',
      links: [{ uri: 'https://vyloop-customer-web.pages.dev/profile', description: 'Perfil' }],
    });

    expect(loyaltyClass).not.toHaveProperty('heroImage');
  });

  it('emits no heroImage on the object either', () => {
    const object = buildLoyaltyObject({
      issuerId: ISSUER,
      classId: `${ISSUER}.tenant-${TENANT_UUID}`,
      customerId: 'c-1',
      customerGlobalId: '9f2504e0-4f89-11d3-9a0c-0305e82c3301',
      memberCode: 'K7M2QP',
      balancePoints: 3,
      pointsCurrency: 'puntos',
      passState: 'issued',
    });

    expect(object).not.toHaveProperty('heroImage');
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

describe('heroImageFor', () => {
  const MEDIA = 'https://media.juancode.dev';
  const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
  const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  it('keys the URL by tenant id and stamp level on the media host', () => {
    expect(heroImageFor({ mediaBaseUrl: MEDIA, tenantId: TENANT, stampLevel: 3 })).toEqual({
      sourceUri: { uri: `https://media.juancode.dev/hero/${TENANT}/3.jpg` },
    });
  });

  it('is a function of the merchant and the level, never of the customer', () => {
    // The product decision, and a cost decision: ten stamps are eleven images
    // for a merchant, not one per customer. Every customer on the same level
    // resolves to the same URL.
    const levels = new Set(
      Array.from({ length: STAMP_LEVEL_IMAGE_COUNT }, (_unused, level) =>
        heroImageFor({ mediaBaseUrl: MEDIA, tenantId: TENANT, stampLevel: level }).sourceUri.uri,
      ),
    );

    expect(levels.size).toBe(STAMP_LEVEL_IMAGE_COUNT);
    expect(STAMP_LEVEL_IMAGE_COUNT).toBe(11);
  });

  it('needs eleven images for ten stamps, not ten and not one per customer', () => {
    expect(STAMPS_FOR_REWARD).toBe(10);
    // Level 0 is a member who has earned nothing; level 10 is the completed
    // card, a different image from level 9.
    expect(STAMP_LEVEL_IMAGE_COUNT).toBe(STAMPS_FOR_REWARD + 1);
  });

  it('does not collide between two merchants at the same level', () => {
    const mine = heroImageFor({ mediaBaseUrl: MEDIA, tenantId: TENANT, stampLevel: 7 }).sourceUri
      .uri;
    const theirs = heroImageFor({ mediaBaseUrl: MEDIA, tenantId: OTHER_TENANT, stampLevel: 7 })
      .sourceUri.uri;

    expect(mine).not.toBe(theirs);
  });

  it('strips a trailing slash so the path never doubles', () => {
    expect(
      heroImageFor({ mediaBaseUrl: `${MEDIA}/`, tenantId: TENANT, stampLevel: 0 }).sourceUri.uri,
    ).toBe(`https://media.juancode.dev/hero/${TENANT}/0.jpg`);
  });

  it('refuses a level outside the range a hero exists for', () => {
    expect(() =>
      heroImageFor({ mediaBaseUrl: MEDIA, tenantId: TENANT, stampLevel: MAX_STAMP_LEVEL + 1 }),
    ).toThrow(/stampLevel/);
    expect(() => heroImageFor({ mediaBaseUrl: MEDIA, tenantId: TENANT, stampLevel: -1 })).toThrow(
      /stampLevel/,
    );
    expect(() =>
      heroImageFor({ mediaBaseUrl: MEDIA, tenantId: TENANT, stampLevel: 2.5 }),
    ).toThrow(/stampLevel/);
  });

  it('refuses a blank host or tenant rather than addressing the wrong merchant', () => {
    expect(() =>
      heroImageFor({ mediaBaseUrl: '  ', tenantId: TENANT, stampLevel: 0 }),
    ).toThrow(/mediaBaseUrl/);
    expect(() => heroImageFor({ mediaBaseUrl: MEDIA, tenantId: ' ', stampLevel: 0 })).toThrow(
      /tenantId/,
    );
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
