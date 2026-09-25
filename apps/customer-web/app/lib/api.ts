// API client — real fetch() calls against the backend API gateway

const API_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8787';
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

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

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

export interface Reward {
  id: string;
  name: string;
  description?: string;
  pointsCost: number;
  category?: string;
  stock?: number;
  imageUrl?: string;
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
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface Transaction {
  id: string;
  customer_id: string;
  type: 'earn' | 'redeem';
  points: number;
  balance_after: number;
  reference_id?: string;
  note?: string;
  created_at: string;
}

export interface PaginatedTransactions {
  data: Transaction[];
  meta: { total: number; page: number; per_page: number };
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

  async getRewards(): Promise<Reward[]> {
    const result = await apiFetch('/v1/loyalty/rewards?active=true') as {
      data: Reward[];
    };
    return result?.data ?? [];
  },

  async redeemReward(params: {
    customer_id: string;
    points: number;
    reward_id: string;
    reference_id: string;
  }): Promise<unknown> {
    return apiFetch('/v1/loyalty/rewards/redeem', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async getProfile(): Promise<CustomerProfile> {
    const result = await apiFetch('/v1/customers/me') as { data: CustomerProfile };
    return result.data;
  },

  async updateConsent(consent: { whatsapp: boolean }): Promise<unknown> {
    return apiFetch('/v1/customers/me/consent', {
      method: 'PUT',
      body: JSON.stringify(consent),
    });
  },

  async getTransactions(filters?: {
    customer_id?: string;
    type?: 'earn' | 'redeem';
    page?: number;
    limit?: number;
  }): Promise<PaginatedTransactions> {
    const params = new URLSearchParams();
    if (filters?.customer_id) params.set('customer_id', filters.customer_id);
    if (filters?.type) params.set('type', filters.type);
    if (filters?.page) params.set('page', String(filters.page));
    if (filters?.limit) params.set('limit', String(filters.limit));
    const qs = params.toString();
    const result = await apiFetch(`/v1/loyalty/points/transactions${qs ? `?${qs}` : ''}`) as PaginatedTransactions;
    return result;
  },
};
