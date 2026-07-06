// API client — real fetch() calls against the backend API gateway

const API_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8787';
const JWT_KEY = 'vyloop_jwt';

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

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message || `Error ${res.status}`);
  }

  return data;
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

  async redeemReward(rewardId: string): Promise<unknown> {
    return apiFetch('/v1/loyalty/rewards/redeem', {
      method: 'POST',
      body: JSON.stringify({ rewardId }),
    });
  },

  async getProfile(): Promise<unknown> {
    return apiFetch('/v1/customers/me');
  },
};
