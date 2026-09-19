import type { TaskOrder, OrderAccountingLedger } from './types';

/**
 * 全球多渠道出金财务对账单导出契约 (PRD 3.3 规范)
 */
export function generateOrderAccountingLedger(order: TaskOrder): OrderAccountingLedger {
  const budget = Number(order.budgetUsd || 0);
  const ceiling = Number(order.priceCeilingUsd || budget);
  const actual = Number(order.actualCostUsd || budget);
  const refunded = Number(order.costBreakdown?.refundedRemainder ?? Math.max(0, ceiling - actual));
  
  // 平台按实际结算金额收取 10% 服务费，90% 净额出金
  const takeRate = 0.10;
  const platformFee = parseFloat((actual * takeRate).toFixed(4));
  const netPayout = parseFloat((actual - platformFee).toFixed(4));

  return {
    orderId: order.id,
    currency: 'USD',
    budgetUsd: budget,
    priceCeilingUsd: ceiling,
    actualCostUsd: actual,
    refundedToClientUsd: refunded,
    platformTakeRatePercent: 10,
    platformFeeUsd: platformFee,
    netProviderPayoutUsd: netPayout,
    payoutRail: order.payoutRail || 'crypto_usdc',
    payoutAddress: order.payoutAddress || (order.parameters?.walletAddress || '0xAU_Default_DID_Wallet'),
    payoutStatus: order.payoutStatus || (order.status === 'verified' ? 'settled' : 'escrowed'),
    reconciledAt: new Date().toISOString()
  };
}
