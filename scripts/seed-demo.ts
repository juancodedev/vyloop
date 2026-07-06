#!/usr/bin/env node

/**
 * Seed script for the demo-shop tenant.
 *
 * Idempotent — safe to re-run. Uses ON CONFLICT DO NOTHING on natural keys.
 * Run:  DATABASE_URL=... npx tsx scripts/seed-demo.ts
 */

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from '../packages/db/src/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

const TENANT_SLUG = 'demo-shop';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  // Warn if targeting production
  if (dbUrl.includes('ep-') && !dbUrl.includes('test') && !dbUrl.includes('dev')) {
    console.warn('⚠️  WARNING: DATABASE_URL appears to target a production Neon branch.');
    console.warn('   Press Ctrl+C within 5 seconds to abort...');
    await new Promise((r) => setTimeout(r, 5000));
  }

  const pool = new Pool({ connectionString: dbUrl });
  const db = drizzle(pool, { schema });

  // ---- Idempotency: check if tenant already exists ----
  const existing = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, TENANT_SLUG));

  if (existing.length > 0) {
    console.log(`✅ Demo tenant "${TENANT_SLUG}" already exists. Skipping seed.`);
    await pool.end();
    return;
  }

  console.log(`🌱 Seeding demo data for "${TENANT_SLUG}"...\n`);

  // ---- 1. Tenant ----
  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      name: 'Demo Shop',
      slug: TENANT_SLUG,
      plan: 'premium',
      status: 'active',
      country: 'CL',
      baseCurrency: 'CLP',
      timezone: 'America/Santiago',
      language: 'es-CL',
    })
    .onConflictDoNothing({ target: schema.tenants.slug })
    .returning();

  const tenantId = tenant?.id ?? (
    await db.select().from(schema.tenants).where(eq(schema.tenants.slug, TENANT_SLUG)).limit(1)
  )[0].id;

  console.log(`  ✓ Tenant: Demo Shop (${tenantId})`);

  // ---- 2. Loyalty program ----
  const [program] = await db
    .insert(schema.loyaltyPrograms)
    .values({
      businessId: tenantId,
      name: 'Programa de Lealtad Demo',
      pointsCurrency: 'puntos',
      earnRate: '1.0',
      minRedeemPoints: 100,
      isActive: true,
    })
    .returning();

  const programId = program?.id ?? (
    await db.select().from(schema.loyaltyPrograms)
      .where(eq(schema.loyaltyPrograms.businessId, tenantId)).limit(1)
  )[0].id;

  console.log(`  ✓ Loyalty Program`);

  // ---- 3. Tiers ----
  const tierDefs = [
    { name: 'Bronce', minPoints: 0, multiplier: '1.00', displayOrder: 1 },
    { name: 'Plata', minPoints: 500, multiplier: '1.50', displayOrder: 2 },
    { name: 'Oro', minPoints: 2000, multiplier: '2.00', displayOrder: 3 },
  ] as const;

  const tierIds: Record<string, string> = {};

  for (const t of tierDefs) {
    const [inserted] = await db
      .insert(schema.membershipTiers)
      .values({
        businessId: tenantId,
        programId,
        name: t.name,
        minPoints: t.minPoints,
        multiplier: t.multiplier,
        displayOrder: t.displayOrder,
      })
      .returning();

    if (inserted) {
      tierIds[t.name.toLowerCase()] = inserted.id;
    } else {
      const [found] = await db
        .select()
        .from(schema.membershipTiers)
        .where(eq(schema.membershipTiers.businessId, tenantId))
        .limit(10);
      const match = found.find((r) => r.name === t.name);
      if (match) tierIds[t.name.toLowerCase()] = match.id;
    }
  }

  console.log(`  ✓ Tiers: Bronce (0/1.0x), Plata (500/1.5x), Oro (2000/2.0x)`);

  // ---- 4. Rewards ----
  const rewardDefs = [
    { name: 'Café Americano', description: 'Un café americano de cortesía', pointsCost: 100, category: 'Bebidas', stock: null },
    { name: 'Descuento 10%', description: '10% de descuento en tu próxima compra', pointsCost: 500, category: 'Descuentos', stock: 100 },
    { name: 'Producto Exclusivo', description: 'Producto exclusivo de edición limitada', pointsCost: 2000, category: 'Exclusivos', stock: 10 },
    { name: 'Desayuno Completo', description: 'Desayuno completo para dos personas', pointsCost: 800, category: 'Alimentos', stock: 25 },
  ];

  for (const r of rewardDefs) {
    await db
      .insert(schema.rewards)
      .values({
        businessId: tenantId,
        name: r.name,
        description: r.description,
        pointsCost: r.pointsCost,
        category: r.category,
        stock: r.stock,
      })
      .onConflictDoNothing({ target: [schema.rewards.businessId, schema.rewards.name] });
  }

  console.log(`  ✓ Rewards: ${rewardDefs.map((r) => `${r.name} (${r.pointsCost}pts)`).join(', ')}`);

  // ---- 5. Customers (one per tier) ----
  const customerDefs = [
    { fullName: 'Ana Demo', phone: '+56911111111', tier: 'bronce' },
    { fullName: 'Carlos Demo', phone: '+56922222222', tier: 'plata' },
    { fullName: 'María Demo', phone: '+56933333333', tier: 'oro' },
  ];

  const customerIds: string[] = [];

  for (const c of customerDefs) {
    const [inserted] = await db
      .insert(schema.customers)
      .values({
        businessId: tenantId,
        fullName: c.fullName,
        phone: c.phone,
        currentTierId: tierIds[c.tier],
        optedInAt: daysAgo(60),
        language: 'es',
      })
      .onConflictDoNothing({ target: [schema.customers.businessId, schema.customers.phone] })
      .returning();

    if (inserted) {
      customerIds.push(inserted.id);
    } else {
      const [found] = await db
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.phone, c.phone))
        .limit(1);
      if (found) customerIds.push(found.id);
    }
  }

  console.log(`  ✓ Customers: ${customerDefs.map((c) => c.fullName).join(', ')}`);

  // ---- 6. Transactions (~5 historical, mix of earn and redeem) ----
  const txDefs = [
    { customerIdx: 0, type: 'earn', points: 200, balanceAfter: 200, note: 'Compra inicial', daysBack: 45, ref: 'DEMO-D-01' },
    { customerIdx: 1, type: 'earn', points: 800, balanceAfter: 800, note: 'Compra grande', daysBack: 40, ref: 'DEMO-D-02' },
    { customerIdx: 1, type: 'redeem', points: -100, balanceAfter: 700, note: 'Canje Café Americano', daysBack: 30, ref: 'DEMO-D-03' },
    { customerIdx: 2, type: 'earn', points: 2500, balanceAfter: 2500, note: 'Compra premium', daysBack: 25, ref: 'DEMO-D-04' },
    { customerIdx: 2, type: 'redeem', points: -500, balanceAfter: 2000, note: 'Canje Descuento 10%', daysBack: 10, ref: 'DEMO-D-05' },
  ];

  for (const tx of txDefs) {
    const custId = customerIds[tx.customerIdx];
    if (!custId) continue;

    await db
      .insert(schema.pointsTransactions)
      .values({
        businessId: tenantId,
        customerId: custId,
        type: tx.type,
        points: tx.points,
        balanceAfter: tx.balanceAfter,
        referenceId: tx.ref,
        note: tx.note,
        createdAt: daysAgo(tx.daysBack),
      })
      .onConflictDoNothing({ target: [schema.pointsTransactions.customerId, schema.pointsTransactions.referenceId] });
  }

  console.log(`  ✓ Transactions: ${txDefs.length} historical entries`);

  console.log(`\n✅ Demo seed complete. Tenant slug: "${TENANT_SLUG}"`);
  console.log(`   Customers: +56911111111 (Bronce), +56922222222 (Plata), +56933333333 (Oro)`);

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exitCode = 1;
});
