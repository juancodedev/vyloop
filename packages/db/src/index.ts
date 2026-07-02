import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(dbUrl: string) {
  const client = postgres(dbUrl);
  return drizzle(client, { schema });
}

// Re-export the full schema object
export { schema };

// Re-export all tables
export {
  tenants,
  branches,
  users,
  customers,
  customerEvents,
  consents,
  loyaltyPrograms,
  membershipTiers,
  pointsTransactions,
  crossLoyaltyAlliances,
  referrals,
  workflows,
  workflowExecutions,
  churnPredictions,
  localizationConfigs,
} from './schema';

// Re-export all type exports
export type {
  Tenant,
  NewTenant,
  Branch,
  NewBranch,
  User,
  NewUser,
  Customer,
  NewCustomer,
  CustomerEvent,
  NewCustomerEvent,
  Consent,
  NewConsent,
  LoyaltyProgram,
  NewLoyaltyProgram,
  MembershipTier,
  NewMembershipTier,
  PointsTransaction,
  NewPointsTransaction,
  CrossLoyaltyAlliance,
  NewCrossLoyaltyAlliance,
  Referral,
  NewReferral,
  Workflow,
  NewWorkflow,
  WorkflowExecution,
  NewWorkflowExecution,
  ChurnPrediction,
  NewChurnPrediction,
  LocalizationConfig,
  NewLocalizationConfig,
} from './schema';

// Re-export RLS helpers
export {
  enableRls,
  createRlsPolicies,
  dropRlsPolicies,
  setCurrentBusinessId,
  BUSINESS_ID_TABLES,
} from './rls';

// Re-export index definitions
export {
  idxCustomersPhone,
  idxCustomersLastVisit,
  idxPointsBalance,
  idxCustomersMetadata,
  idxCustomerEventsCustomer,
  idxCustomerEventsType,
  allIndexes,
} from './indexes';
