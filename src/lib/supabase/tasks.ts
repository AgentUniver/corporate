import { supabase } from './client';
import type { TaskOrder } from './types';

/**
 * 下发雇佣任务工单
 */
export async function hireAgentTask(taskData: Omit<TaskOrder, 'id' | 'createdAt' | 'status' | 'platformFeeUsd'>): Promise<TaskOrder> {
  const isResultBased = taskData.orderType === 'result_based' || taskData.parameters?.orderType === 'result_based';
  const platformFee = Number((taskData.budgetUsd * 0.1).toFixed(2));
  const newOrder: TaskOrder = {
    ...taskData,
    id: 'ord-' + Math.random().toString(36).substring(2, 10),
    platformFeeUsd: platformFee,
    status: isResultBased ? 'escrowed' : 'processing',
    orderType: isResultBased ? 'result_based' : 'task_based',
    quantity: taskData.quantity || taskData.parameters?.quantity,
    unitPriceUsd: taskData.unitPriceUsd || taskData.parameters?.unitPriceUsd,
    resultMetric: taskData.resultMetric || taskData.parameters?.resultMetric,
    slaThreshold: taskData.slaThreshold || taskData.parameters?.slaThreshold,
    createdAt: new Date().toISOString()
  };

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('agent_tasks')
        .insert([newOrder])
        .select()
        .single();
      if (!error && data) {
        window.dispatchEvent(new Event('agentuniver_tasks_updated'));
        return data as TaskOrder;
      }
    } catch (err) {
      console.warn('Supabase insert failed, fallback to local storage:', err);
    }
  }

  // Local fallback
  if (typeof window !== 'undefined') {
    const orders: TaskOrder[] = JSON.parse(localStorage.getItem('agentuniver_hired_tasks') || '[]');
    orders.unshift(newOrder);
    localStorage.setItem('agentuniver_hired_tasks', JSON.stringify(orders));
    window.dispatchEvent(new Event('agentuniver_tasks_updated'));
  }

  return newOrder;
}

/**
 * 获取当前用户所有工单
 */
export async function getHiredTaskOrders(): Promise<TaskOrder[]> {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('agent_tasks')
        .select('*')
        .order('createdAt', { ascending: false });
      if (!error && data && data.length > 0) {
        return data as TaskOrder[];
      }
    } catch (err) {
      console.warn('Supabase fetch tasks failed, fallback to local storage:', err);
    }
  }

  if (typeof window !== 'undefined') {
    return JSON.parse(localStorage.getItem('agentuniver_hired_tasks') || '[]');
  }
  return [];
}

import { validateDeliverableSchema, evaluateDisputeArbitration } from '../arbitration/validator';

/**
 * 交付结果（Worker 或模拟系统交付），同时执行数据包 Schema 校验并生成 SHA-256 存证指纹 (TASK-503)
 */
export async function deliverTaskResult(orderId: string, resultPayload: any): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  if (typeof window !== 'undefined') {
    const orders: TaskOrder[] = JSON.parse(localStorage.getItem('agentuniver_hired_tasks') || '[]');
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx !== -1) {
      const order = orders[idx];
      const validation = await validateDeliverableSchema(
        resultPayload,
        order.quantity,
        order.slaThreshold
      );

      orders[idx].status = 'delivered';
      orders[idx].resultPayload = resultPayload;
      orders[idx].deliverableFingerprint = {
        sha256Checksum: validation.sha256Checksum,
        verifiedCount: validation.verifiedCount,
        integrityScore: validation.integrityScore,
        verifiedAt: now
      };
      orders[idx].updatedAt = now;
      localStorage.setItem('agentuniver_hired_tasks', JSON.stringify(orders));
      window.dispatchEvent(new Event('agentuniver_tasks_updated'));
      return orders[idx];
    }
  }
  return null;
}

/**
 * 买家质检验收并通过，释放托管款项
 */
export async function verifyAndAcceptOrder(orderId: string): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  if (typeof window !== 'undefined') {
    const orders: TaskOrder[] = JSON.parse(localStorage.getItem('agentuniver_hired_tasks') || '[]');
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx !== -1) {
      orders[idx].status = 'verified';
      orders[idx].updatedAt = now;
      localStorage.setItem('agentuniver_hired_tasks', JSON.stringify(orders));
      window.dispatchEvent(new Event('agentuniver_tasks_updated'));
      return orders[idx];
    }
  }
  return null;
}

/**
 * 买家发起 SLA 质检争议，触发零人工介入自动化仲裁定谳 (TASK-504)
 */
export async function disputeOrder(orderId: string, disputeReason: string): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  if (typeof window !== 'undefined') {
    const orders: TaskOrder[] = JSON.parse(localStorage.getItem('agentuniver_hired_tasks') || '[]');
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx !== -1) {
      const verdict = await evaluateDisputeArbitration(orders[idx], disputeReason);
      
      orders[idx].disputeReason = disputeReason;
      orders[idx].arbitrationVerdict = verdict;
      orders[idx].updatedAt = now;

      // 依据裁决直接秒级定谳
      if (verdict.ruling === 'refund_client') {
        orders[idx].status = 'refunded';
      } else if (verdict.ruling === 'settle_developer') {
        orders[idx].status = 'verified';
      } else {
        orders[idx].status = 'disputed';
      }

      localStorage.setItem('agentuniver_hired_tasks', JSON.stringify(orders));
      window.dispatchEvent(new Event('agentuniver_tasks_updated'));
      return orders[idx];
    }
  }
  return null;
}

/**
 * 争议裁决退款释放
 */
export async function refundDisputedOrder(orderId: string): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  if (typeof window !== 'undefined') {
    const orders: TaskOrder[] = JSON.parse(localStorage.getItem('agentuniver_hired_tasks') || '[]');
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx !== -1) {
      orders[idx].status = 'refunded';
      orders[idx].updatedAt = now;
      localStorage.setItem('agentuniver_hired_tasks', JSON.stringify(orders));
      window.dispatchEvent(new Event('agentuniver_tasks_updated'));
      return orders[idx];
    }
  }
  return null;
}
