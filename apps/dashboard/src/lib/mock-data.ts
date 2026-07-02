// Mock data for dashboard PMV
// All data is static — no real API calls

export interface Business {
  id: string;
  name: string;
  logoUrl?: string;
}

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

export interface User {
  email: string;
  name: string;
}

export const DEMO_USER: User = {
  email: 'demo@cafecentral.com',
  name: 'Administrador',
};

export const DEMO_PASSWORD = 'demo123';

export const business: Business = {
  id: 'biz-1',
  name: 'Café Central',
};

export const tiers: Tier[] = [
  {
    id: 'tier-bronce',
    name: 'Bronce',
    minPoints: 0,
    multiplier: 1,
    benefits: 'Acceso a promociones básicas y cumpleaños',
    displayOrder: 1,
    customerCount: 5,
  },
  {
    id: 'tier-plata',
    name: 'Plata',
    minPoints: 1000,
    multiplier: 1.5,
    benefits: '15% extra en puntos + descuento especial mensual',
    displayOrder: 2,
    customerCount: 3,
  },
  {
    id: 'tier-oro',
    name: 'Oro',
    minPoints: 3000,
    multiplier: 2,
    benefits: 'Doble puntos + descuentos VIP + envío gratis',
    displayOrder: 3,
    customerCount: 2,
  },
];

export const loyaltyConfig: LoyaltyConfig = {
  earnRate: 1.0,
  programName: 'Programa de Lealtad Café Central',
};

export const customers: Customer[] = [
  {
    id: 'c-1',
    fullName: 'María González',
    phone: '+569 1234 5678',
    email: 'maria.gonzalez@email.com',
    points: 4200,
    totalPointsEarned: 8500,
    currentTier: 'Oro',
    createdAt: '2025-03-15',
  },
  {
    id: 'c-2',
    fullName: 'Carlos Muñoz',
    phone: '+569 2345 6789',
    points: 3100,
    totalPointsEarned: 6200,
    currentTier: 'Oro',
    createdAt: '2025-01-20',
  },
  {
    id: 'c-3',
    fullName: 'Ana Soto',
    phone: '+569 3456 7890',
    email: 'ana.soto@email.com',
    points: 2500,
    totalPointsEarned: 4000,
    currentTier: 'Plata',
    createdAt: '2025-04-01',
  },
  {
    id: 'c-4',
    fullName: 'Pedro Ramírez',
    phone: '+569 4567 8901',
    points: 1800,
    totalPointsEarned: 3500,
    currentTier: 'Plata',
    createdAt: '2025-02-10',
  },
  {
    id: 'c-5',
    fullName: 'Lucía Fernández',
    phone: '+569 5678 9012',
    email: 'lucia.fernandez@email.com',
    points: 1200,
    totalPointsEarned: 2800,
    currentTier: 'Plata',
    createdAt: '2025-05-22',
  },
  {
    id: 'c-6',
    fullName: 'Jorge Valenzuela',
    phone: '+569 6789 0123',
    points: 850,
    totalPointsEarned: 1800,
    currentTier: 'Bronce',
    createdAt: '2025-06-15',
  },
  {
    id: 'c-7',
    fullName: 'Carmen Díaz',
    phone: '+569 7890 1234',
    email: 'carmen.diaz@email.com',
    points: 620,
    totalPointsEarned: 1500,
    currentTier: 'Bronce',
    createdAt: '2025-07-03',
  },
  {
    id: 'c-8',
    fullName: 'Roberto Vega',
    phone: '+569 8901 2345',
    points: 480,
    totalPointsEarned: 950,
    currentTier: 'Bronce',
    createdAt: '2025-08-10',
  },
  {
    id: 'c-9',
    fullName: 'Daniela Pizarro',
    phone: '+569 9012 3456',
    email: 'daniela.pizarro@email.com',
    points: 300,
    totalPointsEarned: 600,
    currentTier: 'Bronce',
    createdAt: '2025-09-01',
  },
  {
    id: 'c-10',
    fullName: 'Felipe Torres',
    phone: '+569 0123 4567',
    points: 920,
    totalPointsEarned: 2100,
    currentTier: 'Bronce',
    createdAt: '2025-09-20',
  },
];

export function getTierName(minPoints: number): string {
  const sorted = [...tiers].sort((a, b) => b.minPoints - a.minPoints);
  const tier = sorted.find((t) => minPoints >= t.minPoints);
  return tier?.name ?? tiers[0].name;
}

export function getTierById(id: string): Tier | undefined {
  return tiers.find((t) => t.id === id);
}
