// API client — real fetch() calls against the backend API gateway

import { gatewayUrl } from './gateway-url';
import type { SupportAccepted } from './support';
import { WALLET_RESPONSE_MALFORMED, type WalletPass } from './wallet';

const JWT_KEY = 'vyloop_jwt';

/**
 * Error thrown by `apiFetch` for every non-2xx response.
 *
 * It exists so callers can tell an HTTP outcome apart from a local failure.
 * The previous bare `Error` discarded both `status` and `code`, which forced
 * the UI to guess whether a request failed because of the user or because the
 * gateway was down.
 *
 * `ApiError` extends `Error`, so every existing `instanceof Error` guard and
 * every `err.message` read keeps working exactly as before. The human-readable
 * `message` is unchanged, so no user-visible copy shifts.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(JWT_KEY);
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${gatewayUrl()}${path}`, { ...options, headers });

  if (res.status === 204) return null;

  if (!res.ok) {
    // A gateway, proxy or crash page can answer an error status with HTML or
    // text instead of JSON. The status is the only thing the caller classifies
    // on, so parsing must never be able to mask it: a rejected parse falls back
    // to a synthetic code and message while preserving the real status.
    const data = await res.json().catch(() => null);

    throw new ApiError(
      res.status,
      data?.error?.code || 'UNKNOWN_ERROR',
      data?.error?.message || `Error ${res.status}`,
    );
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerLoginResponse {
  token: string;
  customer: { name: string; globalId: string };
  expiresIn: number;
}

/**
 * One catalog row from `GET /v1/loyalty/rewards`.
 *
 * Field names are camelCase because the handler answers with a bare
 * `db.select().from(rewards)`, which emits the Drizzle *property* names. This
 * is the opposite of the transactions endpoint below, which selects explicit
 * snake_case aliases. Both shapes are real; neither is a typo to "fix" here.
 */
export interface Reward {
  id: string;
  name: string;
  /** Absent on the wire when the merchant left it blank. Not an empty string. */
  description?: string | null;
  pointsCost: number;
  category?: string | null;
  /**
   * Three distinct states, and they must not be collapsed:
   *
   *   `n > 0`  tracked, and `n` units remain.
   *   `0`      sold out. Redeeming is impossible.
   *   `null`   stock is NOT tracked. Says nothing about availability.
   *
   * Reading `0` as "untracked" would disable a redeem the server would happily
   * accept; reading `null` as sold out would block a real one.
   */
  stock?: number | null;
  autoGrantThreshold?: number | null;
  imageUrl?: string | null;
}

/** The catalog page the server returns, including its `meta` block. */
export interface CatalogPage {
  data: Reward[];
  meta: { total: number; page: number; per_page: number };
}

export interface CustomerEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RecentTransaction {
  id: string;
  type: string;
  points: number;
  balanceAfter: number;
  note?: string | null;
  createdAt: string;
}

/** The tenant the customer belongs to. `null` when the row cannot be resolved. */
export interface CustomerBusiness {
  id: string;
  name: string;
  slug: string;
}

/** The tenant's loyalty program. `null` when the tenant has none configured. */
export interface CustomerProgram {
  id: string;
  name: string;
  /** Tenant-authored unit label for points, e.g. "puntos" or "pts". */
  pointsCurrency: string;
}

/** One rung of the tenant's tier ladder, in canonical display order. */
export interface CustomerTier {
  id: string;
  name: string;
  minPoints: number;
  multiplier: number;
  displayOrder: number;
}

export interface CustomerProfile {
  id: string;
  globalId: string;
  fullName: string;
  phone: string;
  email?: string;
  birthDate?: string;
  points: number;
  totalPointsEarned: number;
  pointsLast30Days?: number;
  currentTierId?: string;
  currentTier: string | null;
  tier?: { id: string; name: string; multiplier: number } | null;
  customer_events?: CustomerEvent[];
  recent_transactions?: RecentTransaction[];
  business: CustomerBusiness | null;
  program: CustomerProgram | null;
  tiers: CustomerTier[];
  /**
   * The first tier whose `minPoints` is strictly greater than the current
   * balance, or `null` when the customer is at or above the top tier.
   *
   * This is derived SERVER-SIDE and must stay that way: the client renders it,
   * it never recomputes it. A second implementation of the rule is a second
   * source of truth, and the two would silently drift.
   */
  nextTier: CustomerTier | null;
  createdAt: string;
}

/**
 * One row from `GET /v1/loyalty/points/transactions`.
 *
 * The endpoint selects explicit snake_case aliases, so these names are the
 * wire names.
 *
 * On `points`: the direction of a movement is carried by `type`, NOT by the
 * sign of this number. Every writer in the growth worker inserts a positive
 * magnitude — an earn inserts `effectivePoints` and a redeem inserts
 * `redeemPoints` — and the spend is expressed by `balance_after` going down.
 * So a `redeem` row here is normally a positive number.
 *
 * Callers must therefore take the direction from `type` and the magnitude from
 * `Math.abs(points)`. Doing the opposite (sign from the number, direction from
 * anything else) mislabels every redemption in the history.
 */
export interface Transaction {
  id: string;
  customer_id: string;
  type: 'earn' | 'redeem';
  points: number;
  balance_after: number;
  reference_id?: string | null;
  note?: string | null;
  created_at: string;
}

export interface PaginatedTransactions {
  data: Transaction[];
  meta: { total: number; page: number; per_page: number };
}

/**
 * The 201 body of `POST /v1/loyalty/rewards/redeem`.
 *
 * `data` is the `points_transactions` row that was just written, so
 * `data.balance_after` is the authoritative post-redeem balance. It is used as
 * the displayed truth rather than a balance recomputed on the client, which
 * would be a second implementation of the arithmetic and would drift.
 */
export interface RedeemResult {
  data: {
    id: string;
    type: string;
    points: number;
    balance_after: number;
    reference_id?: string | null;
    note?: string | null;
    created_at: string;
  };
  /** True when `partial: true` spent less than was asked for. */
  partial: boolean;
  /** Points actually spent. */
  fulfilled: number;
  /** Points that were asked for. */
  requested: number;
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export const api = {
  /**
   * Login or verify a customer by phone (demo mode — no OTP required).
   * Returns a JWT token scoped to rewards:read and rewards:redeem.
   */
  async loginCustomer(
    phone: string,
    businessSlug?: string,
  ): Promise<CustomerLoginResponse> {
    const body: Record<string, string> = { phone };
    if (businessSlug) body.businessSlug = businessSlug;

    const result = await apiFetch('/v1/auth/customer/token', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return result as CustomerLoginResponse;
  },

  /**
   * The active reward catalog. Readable by a customer; no role check.
   *
   * `?active=true` is the server's own filter, and it also drops rows whose
   * `stock` is 0 — so a sold-out reward normally never reaches this list. The
   * card still renders a `stock === 0` row correctly for the case where one
   * does arrive, and the authoritative sold-out signal is the server's
   * `REWARD_OUT_OF_STOCK` on redeem.
   */
  async getRewards(): Promise<Reward[]> {
    const result = (await apiFetch('/v1/loyalty/rewards?active=true')) as CatalogPage | null;
    return result?.data ?? [];
  },

  /**
   * Redeem a reward against the CALLER's own balance.
   *
   * There is no `customer_id` in this signature, on purpose. The server
   * resolves the customer from the token and treats an absent `customer_id` as
   * "my own record", so sending one is both unnecessary and — since #115 —
   * grounds for a 403 when it disagrees with the subject. Making the field
   * unrepresentable in the type means no page can reintroduce the footgun
   * without a compile error.
   */
  async redeemReward(params: {
    reward_id: string;
    points: number;
    /**
     * Unique per attempt. The server holds a unique constraint on
     * (customer_id, reference_id) and answers a repeat with 409
     * DUPLICATE_REFERENCE, which is the backstop behind the in-flight lock.
     */
    reference_id: string;
  }): Promise<RedeemResult> {
    return (await apiFetch('/v1/loyalty/rewards/redeem', {
      method: 'POST',
      body: JSON.stringify(params),
    })) as RedeemResult;
  },

  async getProfile(): Promise<CustomerProfile> {
    const result = (await apiFetch('/v1/customers/me')) as { data: CustomerProfile };
    return result.data;
  },

  /**
   * A Google Wallet save link for the **caller's own** pass.
   *
   * No `customer_id`, on purpose, for the same reason `redeemReward` has none:
   * the server resolves the customer from the token and a parameter would be
   * both unnecessary and a 403 waiting to happen.
   *
   * ## What a successful call actually costs
   *
   * Not a read. This is the endpoint that **creates the `LoyaltyObject` at
   * Google** and reconciles it afterwards, so every call is a Google API
   * request — 200 on the first visit, 409-then-patch once the customer already
   * holds it. That is why the caller asks once per visit and never on re-render.
   * The alternative, `GET /v1/wallet/status`, is free and answers "should the
   * button exist" — worth reaching for if prefetching every profile view turns
   * out to be a rate-limit problem.
   *
   * ## Failures are `ApiError`, and the code is the whole point
   *
   * `apiFetch` already carries `status` and `error.code` out of the envelope,
   * which is what lets the caller tell a merchant's unfinished onboarding from a
   * 500 in this deployment. Both are the same number otherwise, and rendering
   * them identically is how a refusal turns into "you have no pass". See
   * `walletFailureFor`.
   */
  async getWalletPass(): Promise<WalletPass> {
    const result = (await apiFetch('/v1/wallet/pass')) as { data: WalletPass } | null;

    if (result?.data === undefined || result.data === null) {
      // A 200 with no `data` is not a pass, and returning `null as unknown as
      // WalletPass` would push an undefined `save_url` into an `href`.
      //
      // The code comes from `wallet.ts` because a code decides a message, and
      // `delivery.contract.test.ts` holds every code there — spelling one here
      // would put customer-facing wording one module away from its mapping.
      throw new ApiError(200, WALLET_RESPONSE_MALFORMED, 'The wallet response had no pass in it.');
    }

    return result.data;
  },

  /**
   * The caller's OWN points history. Readable by a customer; no role check.
   *
   * `customer_id` is deliberately absent from the filter type. The server
   * narrows a customer to their own rows from the token when the parameter is
   * omitted, and rejects naming anyone else with a 403 — so the honest client
   * call is the one that names nobody. The previous `getTransactions` took a
   * `customer_id` filter, which let a page source it from `localStorage`.
   */
  async getOwnTransactions(filters?: {
    // `| undefined` because this project sets `exactOptionalPropertyTypes`: a
    // caller holding a computed filter must be able to pass an absent one
    // explicitly rather than rebuilding the object to drop the key.
    type?: 'earn' | 'redeem' | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  }): Promise<PaginatedTransactions> {
    const params = new URLSearchParams();
    if (filters?.type) params.set('type', filters.type);
    if (filters?.page) params.set('page', String(filters.page));
    if (filters?.limit) params.set('limit', String(filters.limit));
    const qs = params.toString();
    const result = (await apiFetch(
      `/v1/loyalty/points/transactions${qs ? `?${qs}` : ''}`,
    )) as PaginatedTransactions | null;
    return result ?? { data: [], meta: { total: 0, page: 0, per_page: 0 } };
  },

  /**
   * Post a message to the support inbox from the card's refusal screen.
   *
   * ## Why this bypasses `apiFetch`
   *
   * Two reasons, and the second is the one that matters for correctness.
   *
   * 1. `apiFetch` attaches the caller's JWT from `localStorage`. This route needs
   *    no session — and the person using it, by definition, may not have one:
   *    their registration is what failed. Attaching a token the gateway does not
   *    ask for would also mean this request carries an identity into a route whose
   *    entire design is that it identifies nobody.
   *
   * 2. Everything `apiFetch` does *after* the header is still wanted, so it is
   *    repeated rather than replaced: a non-2xx becomes an `ApiError` carrying the
   *    server's `code` and `message`. That is what lets the form say **the
   *    server's** words for "it did not arrive" instead of inventing a sentence
   *    that might be kinder and less true. A 503 from a deployment with no Resend
   *    key is exactly this case: the customer is told the channel is unavailable,
   *    which is true, rather than told a message was received.
   *
   * The payload is built by `buildSupportPayload` in `lib/support.ts`, which owns
   * the field names and holds the rule that this request carries no field the
   * form does not collect.
   */
  async sendSupportMessage(payload: Record<string, unknown>): Promise<SupportAccepted> {
    const res = await fetch(`${gatewayUrl()}/v1/support`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);

      throw new ApiError(
        res.status,
        data?.error?.code ?? 'UNKNOWN_ERROR',
        data?.error?.message ?? `Error ${res.status}`,
      );
    }

    return (await res.json()) as SupportAccepted;
  },
};
