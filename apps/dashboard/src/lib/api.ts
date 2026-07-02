// API client stub — simulates async calls against mock data
// Replace with real fetch() calls when backend is ready

import {
  customers as mockCustomers,
  tiers as mockTiers,
  loyaltyConfig as mockConfig,
  type Customer,
  type Tier,
  type LoyaltyConfig,
} from './mock-data';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let configStore: LoyaltyConfig = { ...mockConfig };
let tiersStore: Tier[] = [...mockTiers];

export const api = {
  async getCustomers(search?: string): Promise<Customer[]> {
    await delay(150);
    if (search) {
      const q = search.toLowerCase();
      return mockCustomers.filter(
        (c) =>
          c.fullName.toLowerCase().includes(q) ||
          c.phone.includes(q) ||
          (c.email && c.email.toLowerCase().includes(q))
      );
    }
    return [...mockCustomers];
  },

  async getLoyaltyConfig(): Promise<LoyaltyConfig> {
    await delay(80);
    return { ...configStore };
  },

  async updateLoyaltyConfig(
    data: Partial<LoyaltyConfig>
  ): Promise<LoyaltyConfig> {
    await delay(200);
    configStore = { ...configStore, ...data };
    return { ...configStore };
  },

  async getTiers(): Promise<Tier[]> {
    await delay(80);
    return [...tiersStore].sort((a, b) => a.displayOrder - b.displayOrder);
  },

  async createTier(
    data: Omit<Tier, 'id' | 'customerCount'>
  ): Promise<Tier> {
    await delay(200);
    const newTier: Tier = {
      ...data,
      id: `tier-${Date.now()}`,
      customerCount: 0,
    };
    tiersStore.push(newTier);
    return { ...newTier };
  },

  async updateTier(id: string, data: Partial<Tier>): Promise<Tier> {
    await delay(200);
    const idx = tiersStore.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error('Nivel no encontrado');
    tiersStore[idx] = { ...tiersStore[idx], ...data };
    return { ...tiersStore[idx] };
  },

  async deleteTier(id: string): Promise<void> {
    await delay(200);
    const tier = tiersStore.find((t) => t.id === id);
    if (!tier) throw new Error('Nivel no encontrado');
    if (tier.customerCount > 0) {
      throw new Error(
        `No se puede eliminar "${tier.name}" porque tiene ${tier.customerCount} cliente(s) asignado(s)`
      );
    }
    tiersStore = tiersStore.filter((t) => t.id !== id);
  },

  async getCustomerPoints(
    search?: string,
    page: number = 1,
    perPage: number = 10
  ): Promise<{
    items: Customer[];
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  }> {
    await delay(150);
    let filtered = [...mockCustomers];
    if (search) {
      const q = search.toLowerCase();
      filtered = mockCustomers.filter((c) =>
        c.fullName.toLowerCase().includes(q)
      );
    }
    const total = filtered.length;
    const start = (page - 1) * perPage;
    const items = filtered.slice(start, start + perPage);
    return { items, total, page, perPage, totalPages: Math.ceil(total / perPage) };
  },
};
