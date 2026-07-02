export interface TierInfo {
  id: string;
  name: string;
  minPoints: number;
  multiplier: number;
  benefits: string;
}

export interface CustomerProfile {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  points: number;
  totalPointsEarned: number;
  totalPointsRedeemed: number;
  currentTier: TierInfo;
  nextTier?: TierInfo;
  progressToNextTier: number;
  memberSince: string;
  businessName: string;
  businessLogo?: string;
}

export interface Movement {
  id: string;
  type: 'earned' | 'redeemed';
  description: string;
  points: number;
  balance: number;
  date: string;
  referenceId?: string;
}

export const TIERS: TierInfo[] = [
  {
    id: 'bronze',
    name: 'Bronce',
    minPoints: 0,
    multiplier: 1,
    benefits: 'Sin beneficios especiales',
  },
  {
    id: 'silver',
    name: 'Plata',
    minPoints: 1000,
    multiplier: 1.5,
    benefits: 'Multiplicador de puntos ×1.5',
  },
  {
    id: 'gold',
    name: 'Oro',
    minPoints: 3000,
    multiplier: 2,
    benefits: 'Multiplicador de puntos ×2 y beneficios exclusivos',
  },
];

export const MOCK_CUSTOMER: CustomerProfile = {
  id: 'cust-001',
  fullName: 'Juan Pérez',
  phone: '+56912345678',
  email: 'juan@ejemplo.com',
  points: 1250,
  totalPointsEarned: 3250,
  totalPointsRedeemed: 2000,
  currentTier: TIERS[1],
  nextTier: TIERS[2],
  progressToNextTier: 12.5,
  memberSince: 'Marzo 2026',
  businessName: 'Café Central',
};

export const MOCK_MOVEMENTS: Movement[] = [
  {
    id: 'mov-001',
    type: 'earned',
    description: 'Compra café americano',
    points: 150,
    balance: 1250,
    date: '2026-06-28T10:30:00Z',
    referenceId: 'txn-001',
  },
  {
    id: 'mov-002',
    type: 'earned',
    description: 'Compra espresso doble',
    points: 200,
    balance: 1100,
    date: '2026-06-25T15:45:00Z',
    referenceId: 'txn-002',
  },
  {
    id: 'mov-003',
    type: 'redeemed',
    description: 'Canje café gratis',
    points: 350,
    balance: 900,
    date: '2026-06-22T09:00:00Z',
    referenceId: 'txn-003',
  },
  {
    id: 'mov-004',
    type: 'earned',
    description: 'Compra sandwich + café',
    points: 400,
    balance: 1250,
    date: '2026-06-20T12:15:00Z',
    referenceId: 'txn-004',
  },
  {
    id: 'mov-005',
    type: 'earned',
    description: 'Compra torta y capuchino',
    points: 500,
    balance: 850,
    date: '2026-06-18T17:30:00Z',
    referenceId: 'txn-005',
  },
  {
    id: 'mov-006',
    type: 'redeemed',
    description: 'Canje descuento $2.000',
    points: 1000,
    balance: 350,
    date: '2026-06-15T11:00:00Z',
    referenceId: 'txn-006',
  },
  {
    id: 'mov-007',
    type: 'earned',
    description: 'Compra desayuno completo',
    points: 300,
    balance: 1350,
    date: '2026-06-12T08:20:00Z',
    referenceId: 'txn-007',
  },
  {
    id: 'mov-008',
    type: 'earned',
    description: 'Compra café latte',
    points: 180,
    balance: 1050,
    date: '2026-06-10T14:00:00Z',
    referenceId: 'txn-008',
  },
  {
    id: 'mov-009',
    type: 'redeemed',
    description: 'Canje postre',
    points: 650,
    balance: 870,
    date: '2026-06-05T16:45:00Z',
    referenceId: 'txn-009',
  },
  {
    id: 'mov-010',
    type: 'earned',
    description: 'Compra bebida + snack',
    points: 220,
    balance: 1520,
    date: '2026-06-01T09:30:00Z',
    referenceId: 'txn-010',
  },
];

const VALID_PHONE = '+56912345678';

export function getCustomerByPhone(phone: string): CustomerProfile | null {
  const cleaned = phone.replace(/[\s-]/g, '');
  if (cleaned !== VALID_PHONE) return null;
  return MOCK_CUSTOMER;
}
