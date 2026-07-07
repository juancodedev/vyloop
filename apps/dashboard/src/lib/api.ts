// API client — real fetch() calls against the backend API gateway

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

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
      points: 0,  // Points not available in basic customer list — will improve later
      totalPointsEarned: 0,
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
  points_cost: number;
  category?: string | null;
  stock?: number | null;
  auto_grant_threshold?: number | null;
  valid_from?: string | null;
  valid_until?: string | null;
  image_url?: string | null;
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

    return Object.assign(
      {
        id: raw.id as string,
        fullName: raw.fullName as string,
        phone: raw.phone as string,
        points: raw.points as number || 0,
        totalPointsEarned: raw.totalPointsEarned as number || 0,
        currentTier: raw.currentTierId as string || '—',
        currentTierId: raw.currentTierId as string | undefined,
        createdAt: raw.createdAt ? (raw.createdAt as string).split('T')[0] : '—',
        customer_events: events,
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

  async getKpis(): Promise<KpiResponse> {
    return apiFetch('/v1/analytics/kpis') as Promise<KpiResponse>;
  },
};

function mapReward(r: ApiRewardRecord): Reward {
  return {
    id: r.id,
    name: r.name,
    pointsCost: r.points_cost,
    ...(r.description != null && { description: r.description }),
    ...(r.category != null && { category: r.category }),
    ...(r.stock != null && { stock: r.stock }),
    ...(r.auto_grant_threshold != null && { autoGrantThreshold: r.auto_grant_threshold }),
    ...(r.valid_from != null && { validFrom: r.valid_from }),
    ...(r.valid_until != null && { validUntil: r.valid_until }),
    ...(r.image_url != null && { imageUrl: r.image_url }),
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
