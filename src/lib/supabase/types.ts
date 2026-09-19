export type TaskOrderStatus = 
  | 'pending'
  | 'escrowed'
  | 'processing'
  | 'delivered'
  | 'verified'
  | 'disputed'
  | 'refunded';

export type PayoutRailType = 
  | 'fiat_stripe'
  | 'fiat_wise'
  | 'fiat_payoneer'
  | 'crypto_usdc';

export interface PayoutPreference {
  rail: PayoutRailType;
  accountIdentifier: string; // EVM address, IBAN, Wise email, or Payoneer ID
  targetCurrency?: string; // USD, EUR, etc.
  minimumThresholdUsd?: number; // default 20
}

export interface TaskOrder {
  id: string;
  agentId: string;
  agentName: string;
  subdomain: string;
  taskTitle: string;
  taskDescription: string;
  parameters?: Record<string, any>;
  budgetUsd: number;
  platformFeeUsd: number;
  status: TaskOrderStatus;
  createdAt: string;
  userEmail?: string;
  resultPayload?: any;
  orderType?: 'result_based' | 'task_based';
  quantity?: number;
  unitPriceUsd?: number;
  resultMetric?: string;
  slaThreshold?: string;
  disputeReason?: string;
  updatedAt?: string;
  // Dynamic Quotation & Estimate Fields
  estimatedComputeUsd?: number;
  estimatedLoopSteps?: number;
  urgencyMultiplier?: number;
  priceCeilingUsd?: number;
  reauthorizationRequired?: boolean;
  actualCostUsd?: number;
  costBreakdown?: {
    baseCompute: number;
    loopComplexity: number;
    urgencyMultiplier: number;
    platformTakeRate: number;
    refundedRemainder?: number;
  };
  // Global Dual-Rail Payout & Clearing Fields
  payoutRail?: PayoutRailType;
  payoutAddress?: string;
  payoutStatus?: 'pending' | 'escrowed' | 'settled' | 'failed';
  payoutTxHash?: string;
  // Phase 5: Automated Arbitration & Deliverable Schema Fingerprint
  deliverableFingerprint?: {
    sha256Checksum: string;
    verifiedCount: number;
    integrityScore: number;
    verifiedAt: string;
  };
  arbitrationVerdict?: {
    ruling: 'refund_client' | 'settle_developer' | 'split';
    rationale: string;
    confidence: number;
    evidenceHash: string;
    arbitratedAt: string;
  };
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  role: 'client' | 'developer' | 'admin';
}

export interface DripPulseResult {
  success: boolean;
  source: 'pulse' | 'cooldown_skip' | 'mock_fallback' | 'error';
  timestamp: number;
  nextEligibleTime: number;
  message: string;
}

export interface PulseStatus {
  isConfigured: boolean;
  lastPulseTimestamp: number | null;
  nextEligibleTimestamp: number | null;
  isEligible: boolean;
  cooldownMinutes: number;
}

export interface OrderAccountingLedger {
  orderId: string;
  currency: 'USD';
  budgetUsd: number;
  priceCeilingUsd: number;
  actualCostUsd: number;
  refundedToClientUsd: number;
  platformTakeRatePercent: number;
  platformFeeUsd: number;
  netProviderPayoutUsd: number;
  payoutRail: PayoutRailType;
  payoutAddress: string;
  payoutStatus: 'pending' | 'escrowed' | 'settled' | 'failed';
  reconciledAt: string;
}
