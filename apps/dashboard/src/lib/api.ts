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
  programName: string;
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
    const result = await apiFetch('/v1/loyalty/config') as { data: { earn_rate: number; program_name: string } };
    const d = result.data;
    return {
      earnRate: Number(d.earn_rate),
      programName: d.program_name,
    };
  },

  async updateLoyaltyConfig(data: Partial<LoyaltyConfig>): Promise<LoyaltyConfig> {
    const result = await apiFetch('/v1/loyalty/config', {
      method: 'PUT',
      body: JSON.stringify({
        earn_rate: data.earnRate,
        program_name: data.programName,
      }),
    }) as { data: { earn_rate: number; program_name: string } };
    const d = result.data;
    return {
      earnRate: Number(d.earn_rate),
      programName: d.program_name,
    };
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

  async assignPoints(
    customerId: string,
    points: number,
    note?: string,
  ): Promise<{ id: string; points: number; balance_after: number }> {
    const result = await apiFetch('/v1/loyalty/points/assign', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerId,
        points,
        reference_id: `sale-${customerId}-${Date.now()}`,
        ...(note ? { note } : {}),
      }),
    }) as { data: { id: string; points: number; balance_after: number } };
    return result.data;
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
};

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
  return body;
}
