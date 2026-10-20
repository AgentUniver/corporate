import { supabase } from './client';
import type { TaskOrder } from './types';
import { validateDeliverableSchema, evaluateDisputeArbitration } from '../arbitration/validator';

function generateSecureToken(prefix = 'tok_'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return prefix + crypto.randomUUID().replace(/-/g, '');
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return prefix + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return prefix + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
}

function generateSecureOrderId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return 'ord-' + crypto.randomUUID().substring(0, 8);
  }
  return 'ord-' + Math.random().toString(36).substring(2, 10);
}

function getLocalOrders(): TaskOrder[] {
  if (typeof window !== 'undefined') {
    try {
      return JSON.parse(localStorage.getItem('agentuniver_hired_tasks') || '[]');
    } catch {
      return [];
    }
  }
  return [];
}

function saveLocalOrders(orders: TaskOrder[]): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('agentuniver_hired_tasks', JSON.stringify(orders));
      window.dispatchEvent(new Event('agentuniver_tasks_updated'));
    } catch {}
  }
}

/**
 * 下发雇佣任务工单
 */
export async function hireAgentTask(taskData: Omit<TaskOrder, 'id' | 'createdAt' | 'status' | 'platformFeeUsd'>): Promise<TaskOrder> {
  const isResultBased = taskData.orderType === 'result_based' || taskData.parameters?.orderType === 'result_based';
  const platformFee = Number((taskData.budgetUsd * 0.1).toFixed(2));
  const newOrder: TaskOrder = {
    ...taskData,
    id: generateSecureOrderId(),
    platformFeeUsd: platformFee,
    status: 'escrowed',
    orderType: isResultBased ? 'result_based' : 'task_based',
    quantity: taskData.quantity || taskData.parameters?.quantity,
    unitPriceUsd: taskData.unitPriceUsd || taskData.parameters?.unitPriceUsd,
    resultMetric: taskData.resultMetric || taskData.parameters?.resultMetric,
    slaThreshold: taskData.slaThreshold || taskData.parameters?.slaThreshold,
    taskToken: taskData.taskToken || generateSecureToken('tok_'),
    createdAt: new Date().toISOString()
  };

  if (supabase) {
    try {
      // 优先从真实 JWT 鉴权会话获取已认证真实邮箱，杜绝匿名注入伪造
      const { data: authData } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
      if (authData?.user?.email) {
        newOrder.userEmail = authData.user.email;
      }

      const { data, error } = await supabase
        .from('agent_tasks')
        .insert([newOrder])
        .select()
        .single();
      if (!error && data) {
        const orders = getLocalOrders();
        orders.unshift(data as TaskOrder);
        saveLocalOrders(orders);
        return data as TaskOrder;
      }
      if (error) {
        console.warn('Supabase insert error details:', error.message || error);
      }
    } catch (err) {
      console.warn('Supabase insert failed, fallback to local storage:', err);
    }
  }

  // Local fallback
  const orders = getLocalOrders();
  orders.unshift(newOrder);
  saveLocalOrders(orders);
  return newOrder;
}

/**
 * 获取当前用户所有工单
 */
export async function getHiredTaskOrders(): Promise<TaskOrder[]> {
  const localOrders = getLocalOrders();
  if (supabase) {
    try {
      const localIds = localOrders.map(o => o.id).filter(Boolean);
      let query = supabase
        .from('agent_tasks')
        .select('*')
        .order('createdAt', { ascending: false });

      // 未登录匿名环境基于本地存证 ID 精确路由，避免跨租户数据混淆
      const { data: authData } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
      if (!authData?.user && localIds.length > 0) {
        query = query.in('id', localIds);
      }

      const { data, error } = await query;
      if (!error && data && data.length > 0) {
        const localMap = new Map(localOrders.map(o => [o.id, o]));
        const merged: TaskOrder[] = (data as TaskOrder[]).map(remote => {
          const local = localMap.get(remote.id);
          return {
            ...remote,
            taskToken: remote.taskToken || local?.taskToken
          };
        });
        saveLocalOrders(merged);
        return merged;
      }
      if (error) {
        console.warn('Supabase fetch tasks error:', error.message || error);
      }
    } catch (err) {
      console.warn('Supabase fetch tasks failed, fallback to local storage:', err);
    }
  }

  return localOrders;
}

/**
 * 交付结果（Worker 或模拟系统交付），同时执行数据包 Schema 校验并生成 SHA-256 存证指纹 (TASK-503)
 */
export async function deliverTaskResult(orderId: string, resultPayload: any): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  const orders = getLocalOrders();
  let idx = orders.findIndex(o => o.id === orderId);
  let order: TaskOrder;

  if (idx !== -1) {
    order = orders[idx];
  } else {
    if (supabase) {
      try {
        const { data } = await supabase.from('agent_tasks').select('*').eq('id', orderId).single();
        if (data) {
          order = data as TaskOrder;
        } else {
          order = { id: orderId, status: 'escrowed', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
        }
      } catch {
        order = { id: orderId, status: 'escrowed', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
      }
    } else {
      order = { id: orderId, status: 'escrowed', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
    }
    orders.unshift(order);
    idx = 0;
  }

  const validation = await validateDeliverableSchema(
    resultPayload,
    order.quantity,
    order.slaThreshold
  );

  // Call serverless deliver endpoint with Fail-Closed semantics
  let serverRespData: any = null;
  try {
    const resp = await fetch('/api/v1/acp/deliver/' + orderId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(order.taskToken ? { 'X-Task-Token': order.taskToken } : {})
      },
      body: JSON.stringify({
        output: resultPayload,
        agent_slug: order.agent_slug || order.agentId
      })
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Delivery rejected with HTTP ${resp.status}`);
    }
    serverRespData = await resp.json().catch(() => ({}));
  } catch (e) {
    console.error('[ACP Deliver] Server delivery failed:', e);
    throw e;
  }

  const finalStatus = serverRespData?.status || 'delivered';
  const finalOutput = serverRespData?.output || resultPayload;
  const finalFingerprint = serverRespData?.deliverable_fingerprint || {
    sha256Checksum: validation.sha256Checksum,
    verifiedCount: validation.verifiedCount,
    integrityScore: validation.integrityScore,
    verifiedAt: now
  };

  orders[idx].status = finalStatus;
  orders[idx].resultPayload = finalOutput;
  orders[idx].deliverableFingerprint = finalFingerprint;
  orders[idx].updatedAt = now;
  saveLocalOrders(orders);
  return orders[idx];
}

/**
 * 买家质检验收并通过，释放托管款项
 */
export async function verifyAndAcceptOrder(orderId: string): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  const orders = getLocalOrders();
  let idx = orders.findIndex(o => o.id === orderId);
  let order: TaskOrder;

  if (idx !== -1) {
    order = orders[idx];
  } else {
    if (supabase) {
      try {
        const { data } = await supabase.from('agent_tasks').select('*').eq('id', orderId).single();
        order = (data as TaskOrder) || { id: orderId, status: 'delivered', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
      } catch {
        order = { id: orderId, status: 'delivered', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
      }
    } else {
      order = { id: orderId, status: 'delivered', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
    }
    orders.unshift(order);
    idx = 0;
  }

  try {
    const resp = await fetch('/api/v1/acp/settle/' + orderId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(order.taskToken ? { 'X-Task-Token': order.taskToken } : {})
      }
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Settlement rejected with HTTP ${resp.status}`);
    }
  } catch (e) {
    console.error('[ACP Settle] Settlement failed:', e);
    throw e;
  }

  orders[idx].status = 'verified';
  orders[idx].payoutStatus = 'settled';
  orders[idx].updatedAt = now;
  saveLocalOrders(orders);
  return orders[idx];
}

/**
 * 买家发起 SLA 质检争议，触发零人工介入自动化仲裁定谳 (TASK-504)
 */
export async function disputeOrder(orderId: string, disputeReason: string): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  const orders = getLocalOrders();
  let idx = orders.findIndex(o => o.id === orderId);
  let order: TaskOrder;

  if (idx !== -1) {
    order = orders[idx];
  } else {
    if (supabase) {
      try {
        const { data } = await supabase.from('agent_tasks').select('*').eq('id', orderId).single();
        order = (data as TaskOrder) || { id: orderId, status: 'delivered', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
      } catch {
        order = { id: orderId, status: 'delivered', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
      }
    } else {
      order = { id: orderId, status: 'delivered', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
    }
    orders.unshift(order);
    idx = 0;
  }

  let verdict: any = null;
  try {
    const resp = await fetch('/api/v1/acp/dispute/' + orderId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(order.taskToken ? { 'X-Task-Token': order.taskToken } : {})
      },
      body: JSON.stringify({ dispute_reason: disputeReason })
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Dispute rejected with HTTP ${resp.status}`);
    }
    const resJson = await resp.json().catch(() => ({}));
    verdict = resJson.verdict;
  } catch (e) {
    console.error('[ACP Dispute] Dispute evaluation failed:', e);
    throw e;
  }

  if (!verdict) {
    verdict = await evaluateDisputeArbitration(order, disputeReason);
  }

  orders[idx].disputeReason = disputeReason;
  orders[idx].arbitrationVerdict = verdict;
  orders[idx].updatedAt = now;

  if (verdict.ruling === 'refund_client') {
    orders[idx].status = 'refunded';
    orders[idx].payoutStatus = 'refunded';
  } else if (verdict.ruling === 'settle_developer') {
    orders[idx].status = 'verified';
    orders[idx].payoutStatus = 'settled';
  } else {
    orders[idx].status = 'disputed';
  }

  saveLocalOrders(orders);
  return orders[idx];
}

/**
 * 争议裁决退款释放
 */
export async function refundDisputedOrder(orderId: string): Promise<TaskOrder | null> {
  const now = new Date().toISOString();
  const orders = getLocalOrders();
  let idx = orders.findIndex(o => o.id === orderId);
  let order: TaskOrder;

  if (idx !== -1) {
    order = orders[idx];
  } else {
    if (supabase) {
      try {
        const { data } = await supabase.from('agent_tasks').select('*').eq('id', orderId).single();
        order = (data as TaskOrder) || { id: orderId, status: 'disputed', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
      } catch {
        order = { id: orderId, status: 'disputed', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
      }
    } else {
      order = { id: orderId, status: 'disputed', createdAt: now, taskTitle: 'Task ' + orderId, taskDescription: '', agentId: 'agent', agentName: 'Agent', subdomain: 'ai', budgetUsd: 0.1, platformFeeUsd: 0.01, orderType: 'task_based' };
    }
    orders.unshift(order);
    idx = 0;
  }

  try {
    const resp = await fetch('/api/v1/acp/refund/' + orderId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(order.taskToken ? { 'X-Task-Token': order.taskToken } : {})
      }
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData?.error?.message || `Refund rejected with HTTP ${resp.status}`);
    }
  } catch (e) {
    console.error('[ACP Refund] Refund release failed:', e);
    throw e;
  }

  orders[idx].status = 'refunded';
  orders[idx].payoutStatus = 'refunded';
  orders[idx].updatedAt = now;
  saveLocalOrders(orders);
  return orders[idx];
}
