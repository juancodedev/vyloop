// API client — real fetch() calls against the backend API gateway

import { CUSTOMER_PATCHABLE_FIELDS, type CustomerPatch } from '@vyloop/types';

import { presentPass, type WirePassState } from './pass-state';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

/** The three ways the counter can name the person in front of them. */
export type LookupIdentifier = 'phone' | 'email' | 'globalId';

/**
 * One customer, as the counter needs them.
 *
 * `pass.state` is the stored value, untouched — see `lib/pass-state.ts` for why
 * `not_issued` and `not_saved` must never be merged here.
 */
export interface LookupCustomer {
  id: string;
  globalId: string;
  fullName: string;
  phone: string;
  email: string;
  points: number;
  currentTier: string | null;
  tier: { id: string; name: string; multiplier: number } | null;
  pass: {
    state: WirePassState;
    lastSyncedAt: string | null;
    /** True when Google has never given us a definite answer. */
    unverified: boolean;
  };
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem('auth');
    if (stored) return JSON.parse(stored).token;
  } catch { /* ignore */ }
  return null;
}

interface ApiBenefit {
  title: string;
  description: string;
}

interface ApiTierRecord {
  id: string;
  name: string;
  minPoints: number;
  multiplier: number;
  benefits: ApiBenefit[];
  displayOrder: number;
}

/**
 * An API failure that still knows *which* failure it was.
 *
 * `apiFetch` used to throw a bare `Error` carrying only the server's prose, so a
 * caller could not tell "this customer is not registered" (404, an invitation to
 * register them) from "the request was malformed" (400) from "the system is
 * broken" (500). Answering a broken system with "register this customer" sends
 * a real person into a wrong form, so the distinction has to survive to the UI.
 *
 * It extends `Error` rather than replacing it: every existing `catch` reads
 * `err.message` and none of them need to change.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The server's `error.code`, or `''` when it sent none. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Raise the server's own failure, keeping its status and code. */
function apiError(status: number, data: unknown): ApiError {
  const error = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : '';
  const message =
    typeof error?.message === 'string' && error.message !== ''
      ? error.message
      : `Error ${status}`;
  return new ApiError(status, code, message);
}

/**
 * What a new business gets, and what the operator is shown afterwards.
 *
 * The slug is the load-bearing part: it is the customer-facing URL
 * (`/register?biz=<slug>`) and the QR the merchant prints, so a person who cannot
 * see it cannot onboard a single customer.
 */
export interface SignupBusinessResult {
  businessId: string;
  name: string;
  slug: string;
  adminUserId: string;
  loyaltyProgramId: string;
  firstTierId: string;
}

export interface SignupBusinessInput {
  /** The trading name. The slug is derived from it, so it is not chosen directly. */
  name: string;
  email: string;
  password: string;
  /** Optional: the person's own name for the operator record. */
  fullName?: string;
}

/**
 * Self-service business signup.
 *
 * Public, so it goes through bare `fetch` rather than `apiFetch`: that helper
 * attaches the operator's token and, on a 401, tries to refresh it — neither of
 * which means anything to a person who does not have an account yet, which is the
 * entire population of this call.
 *
 * The password is deliberately not retried or reported beyond the server's own
 * message. `VALIDATION_ERROR` from here is the length policy, and its text names the
 * rule.
 */
export async function signupBusiness(input: SignupBusinessInput): Promise<SignupBusinessResult> {
  const res = await fetch(`${API_URL}/v1/auth/business/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      password: input.password,
      ...(input.fullName ? { full_name: input.fullName } : {}),
    }),
  });

  const data = await res.json();

  if (!res.ok) throw apiError(res.status, data);

  const payload = (data as { data?: SignupBusinessResult } | null)?.data;
  if (!payload?.slug) {
    throw new ApiError(res.status, '', 'La creación del comercio no devolvió un slug.');
  }

  return payload;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (res.status === 204) return null;

  const data = await res.json();

  if (!res.ok) {
    if (res.status === 401 && getToken()) {
      // Token expired — try to refresh before giving up
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        // Retry the original request with the new token
        headers['Authorization'] = `Bearer ${getToken()}`;
        const retryRes = await fetch(`${API_URL}${path}`, { ...options, headers });
        if (retryRes.status === 204) return null;
        const retryData = await retryRes.json();
        if (!retryRes.ok) {
          throw apiError(retryRes.status, retryData);
        }
        return retryData;
      }
      // Refresh failed — clear auth and redirect
      clearAuthAndRedirect();
      throw new Error('Session expired. Redirecting to login…');
    }
    throw apiError(res.status, data);
  }

  return data;
}

async function tryRefreshToken(): Promise<boolean> {
  try {
    const stored = localStorage.getItem('auth');
    if (!stored) return false;
    const session = JSON.parse(stored);
    if (!session.refreshToken || !session.email) return false;

    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: session.refreshToken,
        email: session.email,
      }),
    });

    if (!res.ok) return false;

    const data = await res.json();

    // Update stored session with new tokens, keeping the same user
    localStorage.setItem('auth', JSON.stringify({
      ...session,
      token: data.access_token,
      refreshToken: data.refresh_token,
    }));

    return true;
  } catch {
    return false;
  }
}

function clearAuthAndRedirect(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('auth');
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

// Types (aligned with mock-data shapes so pages don't break)
export interface Customer {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  points: number;
  totalPointsEarned: number;
  currentTier: string;
  createdAt: string;
}

export interface LoyaltyConfig {
  earnRate: number;
  /** What the program counts: `'visit'` is a count, `'purchase'` is money. */
  earnBy: EarnBy;
  /** Pesos worth one unit of `earnRate`. Only read when `earnBy` is purchase. */
  earnUnitAmount: number;
  programName: string;
}

/**
 * The two accumulation mechanics. Mirrors `EARN_BY_VALUES` in the growth worker
 * (`workers/growth/src/routes.ts`); `'visit'` is the fallback for a response that
 * predates the field, matching the worker's own default.
 */
export const EARN_BY_VALUES = ['visit', 'purchase'] as const;
export type EarnBy = (typeof EARN_BY_VALUES)[number];

function readEarnBy(value: unknown): EarnBy {
  return EARN_BY_VALUES.includes(value as EarnBy) ? (value as EarnBy) : 'visit';
}

/**
 * The wire shape of `/v1/loyalty/config`.
 *
 * Every numeric field is `number | string` because `numeric` columns come back
 * from Postgres as strings and older fixtures wrote numbers. A field is
 * optional because a worker predating the accumulation rule does not send it, and
 * a required one would make this a lie about what the API actually guarantees.
 */
interface LoyaltyConfigWire {
  data: {
    earn_rate: number | string;
    earn_by?: string;
    earn_unit_amount?: number | string;
    program_name: string;
  };
}

/**
 * Normalise the wire shape into what the page renders.
 *
 * The fallbacks are the worker's own defaults, not this client's opinion of them
 * (`DEFAULT_EARN_BY` and `earn_unit_amount`'s `1000.00` in
 * `workers/growth/src/routes.ts`). Reading them from two places is how a client
 * ends up describing a program the backend is not running.
 */
export function readLoyaltyConfig(d: LoyaltyConfigWire['data']): LoyaltyConfig {
  return {
    earnRate: Number(d.earn_rate),
    earnBy: readEarnBy(d.earn_by),
    earnUnitAmount: Number(d.earn_unit_amount ?? 1000),
    programName: d.program_name,
  };
}

export interface Tier {
  id: string;
  name: string;
  minPoints: number;
  multiplier: number;
  benefits: string;
  displayOrder: number;
  customerCount: number;
}

// Helpers
async function getCustomersWithPoints(search?: string, page: number = 1, perPage: number = 20) {
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  params.set('page', String(page));
  params.set('limit', String(perPage));

  const raw = await apiFetch(`/v1/customers?${params}`) as {
    data: Array<Record<string, unknown>>;
    total: number;
    page: number;
    limit: number;
  };

  // Fetch tiers for mapping tier IDs → names
  const tierMap: Record<string, string> = {};
  try {
    const tiersData = await apiFetch('/v1/loyalty/tiers') as { data: ApiTierRecord[] };
    if (tiersData?.data) {
      for (const t of tiersData.data) {
        tierMap[t.id] = t.name;
      }
    }
  } catch { /* no tiers yet */ }

  // Map API response to Customer interface
  const items: Customer[] = (raw.data || []).map((c) => {
    const email = c.email as string | undefined;
    const item: Customer = {
      id: c.id as string,
      fullName: c.fullName as string,
      phone: c.phone as string,
      points: Number(c.points ?? 0),
      totalPointsEarned: Number(c.totalPointsEarned ?? 0),
      currentTier: c.currentTierId ? (tierMap[c.currentTierId as string] || '—') : 'Bronce',
      createdAt: c.createdAt ? (c.createdAt as string).split('T')[0] : '—',
    };
    if (email) item.email = email;
    return item;
  });

  return { items, total: raw.total, page: raw.page, perPage: raw.limit };
}

export interface CustomerDetail extends Customer {
  birthDate?: string;
  points: number;
  totalPointsEarned: number;
  currentTier: string;
  currentTierId?: string;
  customer_events: Array<{
    id: string;
    eventType: string;
    payload: Record<string, unknown>;
    points: number | null;
    createdAt: string;
  }>;
  recent_transactions: Array<{
    id: string;
    type: string;
    points: number;
    balanceAfter: number;
    note: string | null;
    createdAt: string;
  }>;
  consents: Array<Record<string, unknown>>;
}

export interface Reward {
  id: string;
  name: string;
  description?: string;
  pointsCost: number;
  category?: string;
  stock?: number;
  autoGrantThreshold?: number;
  validFrom?: string;
  validUntil?: string;
  imageUrl?: string;
  /**
   * Venues where the reward can be redeemed. Empty means every venue of the
   * business, which is what every reward meant before venue scoping existed —
   * so an empty array is the default, not a missing value.
   */
  branchIds?: string[];
}

interface ApiRewardRecord {
  id: string;
  name: string;
  description?: string | null;
  pointsCost: number;
  category?: string | null;
  stock?: number | null;
  autoGrantThreshold?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  imageUrl?: string | null;
  branch_ids?: string[];
}

/**
 * What a successful accumulation returns: the ledger row, and the balance the
 * worker accumulated from the points *it* computed. Identical under both mechanics
 * — the caller never reads its own estimate back out of this.
 */
export interface AssignPointsResult {
  id: string;
  points: number;
  balance_after: number;
}

/**
 * One POST to `/v1/loyalty/points/assign`, for either accumulation mechanic.
 *
 * The mechanic decides which input field the body carries, and the worker refuses
 * the wrong one — so the field is passed in fully formed and this helper adds only
 * what is identical across both: the customer, the sale's reference id, and the
 * note. Keeping the reference id here is what stops the two methods from drifting
 * into two different id schemes, which would be invisible until a duplicate sale
 * turned into a 409 on the second one.
 */
async function postAssignPoints(
  input: { customer_id: string; points?: number; amount_pesos?: number },
  note?: string,
): Promise<AssignPointsResult> {
  const result = await apiFetch('/v1/loyalty/points/assign', {
    method: 'POST',
    body: JSON.stringify({
      ...input,
      reference_id: `sale-${input.customer_id}-${Date.now()}`,
      ...(note ? { note } : {}),
    }),
  }) as { data: AssignPointsResult };
  return result.data;
}

export const api = {
  async getCustomer(id: string): Promise<CustomerDetail> {
    const raw = await apiFetch(`/v1/customers/${id}`) as Record<string, unknown>;
    const events = (raw.customer_events as Array<Record<string, unknown>> || []).map((e) => ({
      id: e.id as string,
      eventType: e.eventType as string,
      payload: (e.payload || {}) as Record<string, unknown>,
      points: e.points as number | null,
      createdAt: e.createdAt as string,
    }));
    const transactions = (raw.recent_transactions as Array<Record<string, unknown>> || []).map((t) => ({
      id: t.id as string,
      type: t.type as string,
      points: Number(t.points ?? 0),
      balanceAfter: Number(t.balanceAfter ?? 0),
      note: t.note as string | null,
      createdAt: t.createdAt as string,
    }));

    return Object.assign(
      {
        id: raw.id as string,
        fullName: raw.fullName as string,
        phone: raw.phone as string,
        points: Number(raw.points ?? 0),
        totalPointsEarned: Number(raw.totalPointsEarned ?? 0),
        currentTier: raw.currentTierId as string || '—',
        currentTierId: raw.currentTierId as string | undefined,
        createdAt: raw.createdAt ? (raw.createdAt as string).split('T')[0] : '—',
        customer_events: events,
        recent_transactions: transactions,
        consents: raw.consents as Array<Record<string, unknown>> || [],
      },
      raw.email ? { email: raw.email as string } : {},
      raw.birthDate ? { birthDate: raw.birthDate as string } : {},
    ) as CustomerDetail;
  },

  async getCustomers(search?: string): Promise<Customer[]> {
    const result = await getCustomersWithPoints(search, 1, 100);
    return result.items;
  },

  /**
   * Save an edit to one customer.
   *
   * ## Why the body is the patch, verbatim
   *
   * This method did not exist while `PATCH /v1/customers/:id` did, which is how
   * the endpoint sat there spreading whatever it was given into an UPDATE for as
   * long as it existed. With the route now refusing everything outside
   * `CUSTOMER_PATCHABLE_FIELDS`, a client that added a field of its own would
   * make every save fail; one that renamed a field would make every save succeed
   * and change nothing.
   *
   * So this adds nothing and fills in nothing. The keys it sends are exactly the
   * keys it was handed, `lib/customer-edit.ts` is what decides those, and no
   * tenant field appears: the tenant is the token the gateway injected.
   */
  async updateCustomer(id: string, patch: CustomerPatch): Promise<CustomerDetail> {
    // The type says this cannot happen and a caller will find a way. Dropping a
    // disallowed key quietly is the failure this whole change is about, so it is
    // refused here, at the boundary, where the mistake is still legible.
    const forbidden = Object.keys(patch).filter(
      (field) => !(CUSTOMER_PATCHABLE_FIELDS as readonly string[]).includes(field),
    );
    if (forbidden.length > 0) {
      throw new ApiError(
        0,
        'CLIENT_CONTRACT_VIOLATION',
        `Este cliente no puede enviar: ${forbidden.join(', ')}. Editable: ${CUSTOMER_PATCHABLE_FIELDS.join(', ')}.`,
      );
    }

    await apiFetch(`/v1/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });

    // The route answers with the updated row, which is a `customers` row and not
    // the 360° profile `getCustomer` assembles. Re-read so the screen shows one
    // shape rather than two, and so the balance and tier on screen cannot drift
    // from what a second reader would see.
    return this.getCustomer(id);
  },

  async getLoyaltyConfig(): Promise<LoyaltyConfig> {
    const result = (await apiFetch('/v1/loyalty/config')) as LoyaltyConfigWire;
    return readLoyaltyConfig(result.data);
  },

  async updateLoyaltyConfig(data: Partial<LoyaltyConfig>): Promise<LoyaltyConfig> {
    const result = (await apiFetch('/v1/loyalty/config', {
      method: 'PUT',
      body: JSON.stringify({
        earn_rate: data.earnRate,
        // `earn_by: 'purchase'` without `earn_unit_amount` is refused by the
        // worker with INVALID_EARN_UNIT_AMOUNT, so a partial edit that switches
        // the mechanic has to carry the unit it is switching to.
        earn_by: data.earnBy,
        earn_unit_amount: data.earnUnitAmount,
        program_name: data.programName,
      }),
    })) as LoyaltyConfigWire;
    return readLoyaltyConfig(result.data);
  },

  async getTiers(): Promise<Tier[]> {
    const result = await apiFetch('/v1/loyalty/tiers');
    const data = result as { data: ApiTierRecord[] };
    const tiers: Tier[] = (data.data || []).map((t) => ({
      id: t.id,
      name: t.name,
      minPoints: t.minPoints,
      multiplier: Number(t.multiplier),
      benefits: Array.isArray(t.benefits)
        ? t.benefits.map((b: ApiBenefit) => b.title || b.description || JSON.stringify(b)).join(', ')
        : '',
      displayOrder: t.displayOrder,
      customerCount: 0, // Not available from this endpoint
    }));
    return tiers.sort((a: Tier, b: Tier) => a.displayOrder - b.displayOrder);
  },

  async createTier(data: Omit<Tier, 'id' | 'customerCount'>): Promise<Tier> {
    const result = await apiFetch('/v1/loyalty/tiers', {
      method: 'POST',
      body: JSON.stringify({
        name: data.name,
        min_points: data.minPoints,
        multiplier: data.multiplier,
        benefits: [{ title: data.benefits, description: data.benefits }],
        display_order: data.displayOrder,
      }),
    });
    const created = result as { data: ApiTierRecord };
    const t = created.data;
    return {
      id: t.id,
      name: t.name,
      minPoints: t.minPoints,
      multiplier: Number(t.multiplier),
      benefits: Array.isArray(t.benefits) ? t.benefits.map((b: ApiBenefit) => b.title || '').join(', ') : '',
      displayOrder: t.displayOrder,
      customerCount: 0,
    };
  },

  async updateTier(id: string, data: Partial<Tier>): Promise<Tier> {
    const body: Record<string, unknown> = {};
    if (data.name !== undefined) body.name = data.name;
    if (data.minPoints !== undefined) body.min_points = data.minPoints;
    if (data.multiplier !== undefined) body.multiplier = data.multiplier;
    if (data.displayOrder !== undefined) body.display_order = data.displayOrder;
    if (data.benefits !== undefined) body.benefits = [{ title: data.benefits, description: data.benefits }];

    const result = await apiFetch(`/v1/loyalty/tiers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    const updated = result as { data: ApiTierRecord };
    const t = updated.data;
    return {
      id: t.id,
      name: t.name,
      minPoints: t.minPoints,
      multiplier: Number(t.multiplier),
      benefits: Array.isArray(t.benefits) ? t.benefits.map((b: ApiBenefit) => b.title || '').join(', ') : '',
      displayOrder: t.displayOrder,
      customerCount: 0,
    };
  },

  async deleteTier(id: string): Promise<void> {
    await apiFetch(`/v1/loyalty/tiers/${id}`, { method: 'DELETE' });
  },

  async getCustomerPoints(search?: string, page: number = 1, perPage: number = 10): Promise<{
    items: Customer[];
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  }> {
    const result = await getCustomersWithPoints(search, page, perPage);
    return {
      ...result,
      totalPages: Math.ceil(result.total / perPage),
    };
  },

  async getRewards(): Promise<Reward[]> {
    const result = await apiFetch('/v1/loyalty/rewards') as { data: ApiRewardRecord[] };
    return (result.data || []).map(mapReward);
  },

  async createReward(data: Omit<Reward, 'id'>): Promise<Reward> {
    const result = await apiFetch('/v1/loyalty/rewards', {
      method: 'POST',
      body: JSON.stringify(toRewardPayload(data)),
    });
    const created = result as { data: ApiRewardRecord };
    return mapReward(created.data);
  },

  async updateReward(id: string, data: Partial<Reward>): Promise<Reward> {
    const result = await apiFetch(`/v1/loyalty/rewards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(toRewardPayload(data)),
    });
    const updated = result as { data: ApiRewardRecord };
    return mapReward(updated.data);
  },

  async deleteReward(id: string): Promise<void> {
    await apiFetch(`/v1/loyalty/rewards/${id}`, { method: 'DELETE' });
  },

  /**
   * Accumulate under a **visit** program: `points` is the qualifying count.
   *
   * `POST /v1/loyalty/points/assign` reads the tenant's `earn_by` and consumes a
   * different field per mechanic, so this and `assignPurchasePoints` are two
   * methods rather than one with an optional argument: a single helper would let a
   * caller send the wrong field, and the worker refuses it with a 400 the cashier
   * reads as a broken system. What travels as the count is the caller's business —
   * the POS sends its subtotal, which is what it has.
   *
   * Not to be confused with the estimate: the base is what travels, never the
   * preview, because the server applies the rate and the tier itself.
   */
  async assignPoints(
    customerId: string,
    points: number,
    note?: string,
  ): Promise<AssignPointsResult> {
    return postAssignPoints({ customer_id: customerId, points }, note);
  },

  /**
   * Accumulate under a **purchase** program: `amount_pesos` is the money, and the
   * points are derived from it by the tenant's rule.
   *
   * No `points` key is sent alongside it — `AMOUNT_REQUIRED` says a caller-supplied
   * count is refused rather than trusted, because a count next to a money amount is
   * the hole `docs/17-Estrategia-Competitiva.md` §7.5 describes: whoever sends it
   * decides the customer's balance.
   */
  async assignPurchasePoints(
    customerId: string,
    amountPesos: number,
    note?: string,
  ): Promise<AssignPointsResult> {
    return postAssignPoints({ customer_id: customerId, amount_pesos: amountPesos }, note);
  },

  async redeemPoints(
    customerId: string,
    points: number,
    rewardName?: string,
  ): Promise<{ id: string; points: number; balance_after: number; partial?: boolean }> {
    const result = await apiFetch('/v1/loyalty/rewards/redeem', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        points,
        reference_id: `pos-redeem-${customerId}-${Date.now()}`,
        partial: true,
        ...(rewardName ? { reward_name: rewardName } : {}),
      }),
    }) as { data: { id: string; points: number; balance_after: number }; partial?: boolean };
    return {
      id: result.data.id,
      points: result.data.points,
      balance_after: result.data.balance_after,
      ...(result.partial ? { partial: result.partial } : {}),
    };
  },

  /**
   * Resolve **one** customer at the counter, by phone, email or pass id.
   *
   * ## Why exactly one identifier, enforced here
   *
   * The server refuses two identifiers, but catching it here means a confused
   * caller gets a precise error instead of a 400, and — more importantly — that
   * this helper cannot grow a `q` parameter later without tripping this guard.
   * A free-text box plus `LIKE` is how "find the customer in front of me"
   * becomes "list every customer", which is a different product surface with
   * different privacy consequences.
   *
   * No `businessId` is sent: the tenant comes from the token the gateway injects.
   */
  async lookupCustomer(identifier: {
    phone?: string;
    email?: string;
    globalId?: string;
  }): Promise<LookupCustomer> {
    const entries = Object.entries(identifier).filter(
      ([, value]) => typeof value === 'string' && value.trim() !== '',
    ) as Array<[LookupIdentifier, string]>;

    if (entries.length !== 1) {
      throw new Error(
        'Buscá por teléfono, correo o el código del pase: exactamente un dato, no una lista.',
      );
    }

    const [key, value] = entries[0]!;
    const query = new URLSearchParams({ [key]: value.trim() });
    const result = (await apiFetch(`/v1/customers/lookup?${query.toString()}`)) as {
      data: Record<string, unknown>;
    };
    const d = result.data;

    // `state` is carried through verbatim. It is never folded into a boolean:
    // `not_issued` (we never checked) and `not_saved` (Google says it is not
    // there) are opposite facts and the UI renders them differently.
    const state = (d.pass as { state?: string | null } | undefined)?.state ?? null;

    return {
      id: d.id as string,
      globalId: d.globalId as string,
      fullName: d.fullName as string,
      phone: (d.phone as string) ?? '',
      email: (d.email as string) ?? '',
      points: Number(d.points ?? 0),
      currentTier: (d.currentTier as string | null) ?? null,
      tier: (d.tier as { id: string; name: string; multiplier: number } | null) ?? null,
      pass: {
        state,
        lastSyncedAt: (d.pass as { lastSyncedAt?: string | null } | undefined)
          ?.lastSyncedAt ?? null,
        // Derived once, here, from the same module the page renders from — so
        // the flag cannot disagree with the words next to it.
        unverified: presentPass(state).unverified,
      },
    };
  },

  async getCustomerByGlobalId(globalId: string): Promise<{
    id: string;
    globalId: string;
    fullName: string;
    phone: string;
    points: number;
    currentTier: string | null;
    tier?: { id: string; name: string; multiplier: number } | null;
  }> {
    const result = await apiFetch(`/v1/customers/by-global-id/${globalId}`) as { data: Record<string, unknown> };
    const d = result.data;
    return {
      id: d.id as string,
      globalId: d.globalId as string,
      fullName: d.fullName as string,
      phone: d.phone as string,
      points: Number(d.points ?? 0),
      currentTier: d.currentTier as string | null,
      tier: d.tier ? d.tier as { id: string; name: string; multiplier: number } : null,
    };
  },

  async getKpis(): Promise<KpiResponse> {
    return apiFetch('/v1/analytics/kpis') as Promise<KpiResponse>;
  },

  async getTimeline(): Promise<TimelineEvent[]> {
    return apiFetch('/v1/analytics/timeline') as Promise<TimelineEvent[]>;
  },

  // ============================================================================
  // Venues (Branches)
  // ============================================================================

  /**
   * List the business's venues with pagination and filters.
   *
   * Uses `/v1/businesses/me/branches` (the gateway injects `business_id` from the token).
   */
  async getVenues(filters: VenueFilters = {}): Promise<{
    branches: BranchView[];
    total: number;
  }> {
    const params = new URLSearchParams();
    if (filters.page) params.set('page', String(filters.page));
    if (filters.per_page) params.set('per_page', String(filters.per_page));
    if (filters.includeInactive) params.set('include_inactive', 'true');

    const raw = await apiFetch(`/v1/businesses/me/branches?${params}`) as {
      branches: BranchView[];
      total: number;
    };
    return raw;
  },

  /**
   * Create a new venue.
   *
   * Location is sent as `{ latitude, longitude }` when both are provided;
   * `null` when both are omitted (clears position).
   */
  async createVenue(data: VenueFormData): Promise<BranchView> {
    const raw = await apiFetch('/v1/businesses/me/branches', {
      method: 'POST',
      body: JSON.stringify({
        name: data.name,
        address: data.address ?? null,
        city: data.city ?? null,
        country: data.country,
        timezone: data.timezone ?? null,
        location: data.latitude !== null && data.longitude !== null
          ? { latitude: data.latitude, longitude: data.longitude }
          : null,
      }),
    }) as { branch: BranchView };
    return raw.branch;
  },

  /**
   * Update an existing venue.
   *
   * Only changed fields are sent. Location is handled specially:
   * - `undefined` → leave unchanged
   * - `null` (both lat/long null) → clear position
   * - object with both lat/long → set position
   */
  async updateVenue(id: string, data: Partial<VenueFormData>): Promise<BranchView> {
    const body: Record<string, unknown> = {};

    if (data.name !== undefined) body.name = data.name;
    if (data.address !== undefined) body.address = data.address;
    if (data.city !== undefined) body.city = data.city;
    if (data.country !== undefined) body.country = data.country;
    if (data.timezone !== undefined) body.timezone = data.timezone;

    if (data.latitude !== undefined && data.longitude !== undefined) {
      if (data.latitude !== null && data.longitude !== null) {
        body.location = { latitude: data.latitude, longitude: data.longitude };
      } else {
        body.location = null;
      }
    }

    const raw = await apiFetch(`/v1/businesses/me/branches/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }) as { branch: BranchView };
    return raw.branch;
  },

  /**
   * Deactivate a venue (soft delete).
   */
  async deactivateVenue(id: string): Promise<void> {
    await apiFetch(`/v1/businesses/me/branches/${id}`, { method: 'DELETE' });
  },
};

/**
 * A venue of the business, as the dashboard needs it: an id to send back and a
 * name to show. `isActive` is carried so a closed venue can be labelled rather
 * than silently offered.
 */
export interface Venue {
  id: string;
  name: string;
  city?: string;
  isActive: boolean;
}

/**
 * Full venue view as returned by the identity worker.
 * Matches the `BranchView` shape from `workers/identity/src/branches.ts`.
 */
export interface BranchView {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string;
  timezone: string | null;
  is_active: boolean;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  geohash_precision: number | null;
  located_at: string | null;
}

/** Filters for listing venues. */
export interface VenueFilters {
  page?: number;
  per_page?: number;
  includeInactive?: boolean;
}

/** Form data for creating/updating a venue. */
export interface VenueFormData {
  name: string;
  address?: string | null;
  city?: string | null;
  country: string;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isActive?: boolean;
}

/** Server error codes for location validation. */
export const LOCATION_ERROR_CODES = {
  BRANCH_LOCATION_INCOMPLETE: 'Ambas coordenadas son obligatorias si se proporciona una',
  BRANCH_LOCATION_INVALID: 'Latitud debe estar entre -90 y 90, longitud entre -180 y 180',
  BRANCH_LOCATION_OUT_OF_RANGE: 'El valor supera el rango permitido',
} as const;

export type LocationErrorCode = keyof typeof LOCATION_ERROR_CODES;

/** Map a server error code to a user-readable message for location fields. */
export function locationErrorMessage(code: string): string {
  return LOCATION_ERROR_CODES[code as LocationErrorCode] ?? `Error de ubicación: ${code}`;
}

/** Check if an ApiError is a location validation error. */
export function isLocationError(err: unknown): err is ApiError & { code: LocationErrorCode } {
  return err instanceof ApiError && err.code in LOCATION_ERROR_CODES;
}

/**
 * The tenant, read once from the signed token.
 *
 * Cached for the page load only: a reload re-reads it, so a token swap cannot
 * leave the dashboard pointed at the previous business.
 */

function mapReward(r: ApiRewardRecord): Reward {
  return {
    id: r.id,
    name: r.name,
    pointsCost: r.pointsCost,
    ...(r.description != null && { description: r.description }),
    ...(r.category != null && { category: r.category }),
    ...(r.stock != null && { stock: r.stock }),
    ...(r.autoGrantThreshold != null && { autoGrantThreshold: r.autoGrantThreshold }),
    ...(r.validFrom != null && { validFrom: r.validFrom }),
    ...(r.validUntil != null && { validUntil: r.validUntil }),
    ...(r.imageUrl != null && { imageUrl: r.imageUrl }),
    ...(r.branch_ids != null && { branchIds: r.branch_ids }),
  };
}

export interface KpiResponse {
  totalCustomers: number;
  activeCustomers: number;
  totalPointsIssued: number;
  totalPointsRedeemed: number;
  redemptionRate: number;
  tierDistribution: Record<string, number>;
  rewardsClaimed: number;
}

export interface TimelineEvent {
  type: 'customer.created' | 'points.earned' | 'points.redeemed' | 'customer.event' | 'customer.profile_viewed';
  customerName: string;
  description: string;
  timestamp: string;
}

function toRewardPayload(data: Partial<Reward>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (data.name !== undefined) body.name = data.name;
  if (data.description !== undefined) body.description = data.description;
  if (data.pointsCost !== undefined) body.points_cost = data.pointsCost;
  if (data.category !== undefined) body.category = data.category;
  if (data.stock !== undefined) body.stock = data.stock;
  if (data.autoGrantThreshold !== undefined) body.auto_grant_threshold = data.autoGrantThreshold;
  if (data.validFrom !== undefined) body.valid_from = data.validFrom;
  if (data.validUntil !== undefined) body.valid_until = data.validUntil;
  if (data.imageUrl !== undefined) body.image_url = data.imageUrl;
  if (data.branchIds !== undefined) body.branch_ids = data.branchIds;
  return body;
}
