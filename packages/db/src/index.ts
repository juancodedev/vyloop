import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';

import * as schema from './schema';

export function createDb(dbUrl: string) {
  const pool = new Pool({ connectionString: dbUrl });
  return drizzle(pool, { schema });
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
  rewards,
  rewardGrants,
  messageLog,
  whatsappTemplates,
  tenantWalletPrograms,
  customerWalletPasses,
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
  MessageLog,
  NewMessageLog,
  WhatsAppTemplate,
  NewWhatsAppTemplate,
  Reward,
  NewReward,
  RewardGrant,
  NewRewardGrant,
  TenantWalletProgram,
  NewTenantWalletProgram,
  CustomerWalletPass,
  NewCustomerWalletPass,
} from './schema';

// Re-export password hashing and the admission policy
export {
  hashPassword,
  verifyPassword,
  checkPasswordPolicy,
  PASSWORD_MIN_LENGTH,
  type PasswordPolicyResult,
} from './password';

// Re-export slug derivation
export { slugify } from './slug';

// Re-export RLS helpers
export {
  enableRls,
  createRlsPolicies,
  dropRlsPolicies,
  setCurrentBusinessId,
  withTenantRls,
  setCurrentTenantId,
  enableTenantRls,
  createTenantRlsPolicies,
  dropTenantRlsPolicies,
  BUSINESS_ID_TABLES,
  TENANT_ID_TABLES,
  BUSINESS_ID_SETTING,
  TENANT_ID_SETTING,
  RLS_POLICY_NAME,
} from './rls';

// Re-export index definitions
export {
  idxCustomersPhone,
  idxCustomersLastVisit,
  idxPointsBalance,
  idxCustomersMetadata,
  idxCustomerEventsCustomer,
  idxCustomerEventsType,
  idxRewardsCategory,
  idxRewardsAutoGrant,
  idxRewardGrantsCustomer,
  idxMessageLogCustomer,
  idxMessageLogStatus,
  idxWhatsappTemplatesName,
  idxCustomersMemberCode,
  idxCustomerWalletPassesTenant,
  idxWalletCallbackDeliveriesReceived,
  indexByName,
  allIndexes,
} from './indexes';
