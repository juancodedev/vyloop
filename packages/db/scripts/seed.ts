#!/usr/bin/env node

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../src/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join('');

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(saltHex), iterations: 100_000, hash: 'SHA-256' },
    key,
    512,
  );

  const hashHex = Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${saltHex}:${hashHex}`;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function hoursAgo(hours: number): Date {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d;
}

// ---------------------------------------------------------------------------
// Customer definitions with transaction histories
// ---------------------------------------------------------------------------

interface TxDef {
  type: 'earned' | 'redeemed';
  points: number; // positive for earned, positive for redeemed (we negate in the insert)
  balanceAfter: number;
  note: string;
  daysAgo: number;
}

interface CustomerDef {
  fullName: string;
  phone: string;
  earned: number;
  redeemed: number;
  balance: number;
  tier: 'bronce' | 'plata' | 'oro';
  transactions: TxDef[];
}

const customerDefs: CustomerDef[] = [
  {
    fullName: 'María González',
    phone: '+569 1234 5678',
    earned: 8000,
    redeemed: 3800,
    balance: 4200,
    tier: 'oro',
    transactions: [
      { type: 'earned', points: 1500, balanceAfter: 1500, note: 'Compra #001 - Café y pastelería', daysAgo: 82 },
      { type: 'earned', points: 2000, balanceAfter: 3500, note: 'Compra #002 - Pedido corporativo', daysAgo: 65 },
      { type: 'redeemed', points: 1000, balanceAfter: 2500, note: 'Canje - Café americano + sándwich', daysAgo: 50 },
      { type: 'earned', points: 2500, balanceAfter: 5000, note: 'Compra #003 - Catering evento', daysAgo: 38 },
      { type: 'redeemed', points: 800, balanceAfter: 4200, note: 'Canje - Bebidas especiales', daysAgo: 25 },
      { type: 'earned', points: 1500, balanceAfter: 5700, note: 'Compra #004 - Pedido mensual', daysAgo: 14 },
      { type: 'redeemed', points: 2000, balanceAfter: 3700, note: 'Canje - Mesa de regalos', daysAgo: 7 },
      { type: 'earned', points: 500, balanceAfter: 4200, note: 'Compra #005 - Café matutino', daysAgo: 1 },
    ],
  },
  {
    fullName: 'Carlos Muñoz',
    phone: '+569 2345 6789',
    earned: 5000,
    redeemed: 1900,
    balance: 3100,
    tier: 'oro',
    transactions: [
      { type: 'earned', points: 1200, balanceAfter: 1200, note: 'Compra #101 - Desayuno ejecutivo', daysAgo: 75 },
      { type: 'earned', points: 1800, balanceAfter: 3000, note: 'Compra #102 - Almuerzo negocios', daysAgo: 55 },
      { type: 'redeemed', points: 500, balanceAfter: 2500, note: 'Canje - Bebidas calientes', daysAgo: 40 },
      { type: 'earned', points: 1000, balanceAfter: 3500, note: 'Compra #103 - Pedido oficina', daysAgo: 28 },
      { type: 'redeemed', points: 1400, balanceAfter: 2100, note: 'Canje - Combo ejecutivo', daysAgo: 15 },
      { type: 'earned', points: 1000, balanceAfter: 3100, note: 'Compra #104 - Café espresso', daysAgo: 3 },
    ],
  },
  {
    fullName: 'Ana Soto',
    phone: '+569 3456 7890',
    earned: 3500,
    redeemed: 1000,
    balance: 2500,
    tier: 'plata',
    transactions: [
      { type: 'earned', points: 800, balanceAfter: 800, note: 'Compra #201 - Café matutino', daysAgo: 70 },
      { type: 'earned', points: 1200, balanceAfter: 2000, note: 'Compra #202 - Postres y café', daysAgo: 52 },
      { type: 'earned', points: 1000, balanceAfter: 3000, note: 'Compra #203 - Pedido familiar', daysAgo: 35 },
      { type: 'redeemed', points: 500, balanceAfter: 2500, note: 'Canje - Bebidas frías', daysAgo: 22 },
      { type: 'earned', points: 500, balanceAfter: 3000, note: 'Compra #204 - Té y pastelería', daysAgo: 10 },
      { type: 'redeemed', points: 500, balanceAfter: 2500, note: 'Canje - Descuento en compra', daysAgo: 4 },
    ],
  },
  {
    fullName: 'Pedro Ramírez',
    phone: '+569 4567 8901',
    earned: 2800,
    redeemed: 1000,
    balance: 1800,
    tier: 'plata',
    transactions: [
      { type: 'earned', points: 600, balanceAfter: 600, note: 'Compra #301 - Café americano', daysAgo: 68 },
      { type: 'earned', points: 1200, balanceAfter: 1800, note: 'Compra #302 - Bebidas y snacks', daysAgo: 45 },
      { type: 'redeemed', points: 300, balanceAfter: 1500, note: 'Canje - Café para llevar', daysAgo: 30 },
      { type: 'earned', points: 800, balanceAfter: 2300, note: 'Compra #303 - Pedido semanal', daysAgo: 18 },
      { type: 'redeemed', points: 700, balanceAfter: 1600, note: 'Canje - Bebidas especiales', daysAgo: 8 },
      { type: 'earned', points: 200, balanceAfter: 1800, note: 'Compra #304 - Café express', daysAgo: 1 },
    ],
  },
  {
    fullName: 'Lucía Fernández',
    phone: '+569 5678 9012',
    earned: 3200,
    redeemed: 2000,
    balance: 1200,
    tier: 'plata',
    transactions: [
      { type: 'earned', points: 1000, balanceAfter: 1000, note: 'Compra #401 - Café y medialunas', daysAgo: 60 },
      { type: 'redeemed', points: 500, balanceAfter: 500, note: 'Canje - Café americano', daysAgo: 45 },
      { type: 'earned', points: 1200, balanceAfter: 1700, note: 'Compra #402 - Almuerzo ejecutivo', daysAgo: 30 },
      { type: 'redeemed', points: 1500, balanceAfter: 200, note: 'Canje - Mesa de regalos', daysAgo: 18 },
      { type: 'earned', points: 1000, balanceAfter: 1200, note: 'Compra #403 - Pedido catering', daysAgo: 5 },
    ],
  },
  {
    fullName: 'Jorge Valenzuela',
    phone: '+569 6789 0123',
    earned: 850,
    redeemed: 0,
    balance: 850,
    tier: 'bronce',
    transactions: [
      { type: 'earned', points: 300, balanceAfter: 300, note: 'Compra #501 - Café matutino', daysAgo: 40 },
      { type: 'earned', points: 250, balanceAfter: 550, note: 'Compra #502 - Té y pastelería', daysAgo: 22 },
      { type: 'earned', points: 300, balanceAfter: 850, note: 'Compra #503 - Bebidas frías', daysAgo: 5 },
    ],
  },
  {
    fullName: 'Carmen Díaz',
    phone: '+569 7890 1234',
    earned: 620,
    redeemed: 0,
    balance: 620,
    tier: 'bronce',
    transactions: [
      { type: 'earned', points: 200, balanceAfter: 200, note: 'Compra #601 - Café espresso', daysAgo: 55 },
      { type: 'earned', points: 180, balanceAfter: 380, note: 'Compra #602 - Té y galletas', daysAgo: 30 },
      { type: 'earned', points: 240, balanceAfter: 620, note: 'Compra #603 - Bebida especial', daysAgo: 8 },
    ],
  },
  {
    fullName: 'Roberto Vega',
    phone: '+569 8901 2345',
    earned: 480,
    redeemed: 0,
    balance: 480,
    tier: 'bronce',
    transactions: [
      { type: 'earned', points: 150, balanceAfter: 150, note: 'Compra #701 - Café para llevar', daysAgo: 48 },
      { type: 'earned', points: 180, balanceAfter: 330, note: 'Compra #702 - Pastelería', daysAgo: 25 },
      { type: 'earned', points: 150, balanceAfter: 480, note: 'Compra #703 - Bebida fría', daysAgo: 6 },
    ],
  },
  {
    fullName: 'Daniela Pizarro',
    phone: '+569 9012 3456',
    earned: 300,
    redeemed: 0,
    balance: 300,
    tier: 'bronce',
    transactions: [
      { type: 'earned', points: 100, balanceAfter: 100, note: 'Compra #801 - Café americano', daysAgo: 35 },
      { type: 'earned', points: 120, balanceAfter: 220, note: 'Compra #802 - Té', daysAgo: 18 },
      { type: 'earned', points: 80, balanceAfter: 300, note: 'Compra #803 - Galletas artesanales', daysAgo: 3 },
    ],
  },
  {
    fullName: 'Felipe Torres',
    phone: '+569 0123 4567',
    earned: 920,
    redeemed: 0,
    balance: 920,
    tier: 'bronce',
    transactions: [
      { type: 'earned', points: 350, balanceAfter: 350, note: 'Compra #901 - Desayuno completo', daysAgo: 42 },
      { type: 'earned', points: 280, balanceAfter: 630, note: 'Compra #902 - Café y pastelería', daysAgo: 20 },
      { type: 'earned', points: 290, balanceAfter: 920, note: 'Compra #903 - Pedido especial', daysAgo: 4 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Main seed logic
// ---------------------------------------------------------------------------

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const pool = new Pool({ connectionString: dbUrl });
  const db = drizzle(pool, { schema });

  // ---- Idempotency check ----
  const existing = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'cafe-central'));
  if (existing.length > 0) {
    console.log('✅ Database already seeded (tenant "cafe-central" exists). Skipping.');
    return;
  }

  console.log('🌱 Seeding demo data for Café Central...\n');

  // ---- 1. Tenant ----
  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      name: 'Café Central',
      slug: 'cafe-central',
      plan: 'premium',
      status: 'active',
      country: 'CL',
      baseCurrency: 'CLP',
      timezone: 'America/Santiago',
      language: 'es-CL',
    })
    .returning();
  console.log(`  ✓ Tenant: ${tenant.name} (${tenant.id})`);

  // ---- 2. Branch ----
  const [branch] = await db
    .insert(schema.branches)
    .values({
      businessId: tenant.id,
      name: 'Sucursal Principal',
      address: 'Av. Providencia 1234, Santiago',
      city: 'Santiago',
      country: 'CL',
      timezone: 'America/Santiago',
      isActive: true,
    })
    .returning();
  console.log(`  ✓ Branch: ${branch.name} (${branch.id})`);

  // ---- 3. Dashboard user ----
  const [user] = await db
    .insert(schema.users)
    .values({
      businessId: tenant.id,
      email: 'demo@cafecentral.com',
      fullName: 'Admin Café Central',
      role: 'admin',
      branchId: branch.id,
      passwordHash: await hashPassword('demo123'),
      isActive: true,
    })
    .returning();
  console.log(`  ✓ User: ${user.email} (password: demo123)`);

  // ---- 4. Loyalty program ----
  const [program] = await db
    .insert(schema.loyaltyPrograms)
    .values({
      businessId: tenant.id,
      name: 'Programa de Lealtad Café Central',
      pointsCurrency: 'puntos',
      earnRate: '1.0',
      minRedeemPoints: 100,
      isActive: true,
    })
    .returning();
  console.log(`  ✓ Loyalty Program: ${program.name}`);

  // ---- 5. Tiers ----
  const [bronce] = await db
    .insert(schema.membershipTiers)
    .values({
      businessId: tenant.id,
      programId: program.id,
      name: 'Bronce',
      minPoints: 0,
      multiplier: '1.0',
      displayOrder: 1,
      benefits: [{ title: 'Beneficios básicos', description: 'Acceso al programa y acumulación de puntos' }],
    })
    .returning();

  const [plata] = await db
    .insert(schema.membershipTiers)
    .values({
      businessId: tenant.id,
      programId: program.id,
      name: 'Plata',
      minPoints: 1000,
      multiplier: '1.5',
      displayOrder: 2,
      benefits: [
        { title: 'Multiplicador 1.5x', description: 'Gana 50% más puntos en cada compra' },
        { title: 'Bebida gratis mes', description: 'Una bebida gratis cada mes' },
      ],
    })
    .returning();

  const [oro] = await db
    .insert(schema.membershipTiers)
    .values({
      businessId: tenant.id,
      programId: program.id,
      name: 'Oro',
      minPoints: 3000,
      multiplier: '2.0',
      displayOrder: 3,
      benefits: [
        { title: 'Multiplicador 2x', description: 'Gana el doble de puntos en cada compra' },
        { title: 'Descuento exclusivo 10%', description: '10% de descuento en todos los productos' },
        { title: 'Eventos especiales', description: 'Invitación a catas y eventos exclusivos' },
      ],
    })
    .returning();
  console.log(`  ✓ Tiers: ${bronce.name}, ${plata.name}, ${oro.name}`);

  // ---- 6. Localization config ----
  await db
    .insert(schema.localizationConfigs)
    .values({
      businessId: tenant.id,
      country: 'CL',
      language: 'es-CL',
      currency: 'CLP',
      idFormat: 'RUT',
      privacyLaw: 'Ley 19.628',
      dataRetentionDays: 1825,
    })
    .returning();
  console.log('  ✓ Localization config (CL)');

  // ---- 7. Customers + Points Transactions ----
  const tierMap = { bronce, plata, oro } as const;

  for (let i = 0; i < customerDefs.length; i++) {
    const c = customerDefs[i];
    const optInDate = daysAgo(90);

    const [customer] = await db
      .insert(schema.customers)
      .values({
        businessId: tenant.id,
        phone: c.phone,
        fullName: c.fullName,
        currentTierId: tierMap[c.tier].id,
        optedInAt: optInDate,
        lastVisitAt: hoursAgo(i * 3 + 2),
        language: 'es',
      })
      .returning();

    let txCount = 0;
    for (const tx of c.transactions) {
      txCount++;
      const points = tx.type === 'redeemed' ? -tx.points : tx.points;

      await db.insert(schema.pointsTransactions).values({
        businessId: tenant.id,
        customerId: customer.id,
        branchId: branch.id,
        type: tx.type,
        points,
        balanceAfter: tx.balanceAfter,
        referenceId: `DEMO-${String(i + 1).padStart(2, '0')}-${String(txCount).padStart(2, '0')}`,
        note: tx.note,
        createdAt: daysAgo(tx.daysAgo),
      });
    }

    console.log(`  ✓ ${c.fullName} — ${c.balance.toLocaleString()} pts (${c.tier}) — ${txCount} movimientos`);
  }

  console.log('\n✅ Seed complete. Demo tenant "Café Central" is ready.');
  console.log(`   Login: demo@cafecentral.com / demo123`);

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exitCode = 1;
});
