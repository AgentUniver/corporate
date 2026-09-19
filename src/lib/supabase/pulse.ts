import { supabase, isSupabaseConfigured } from './client';
import type { DripPulseResult, PulseStatus } from './types';

const STORAGE_KEY_LAST_PULSE = 'agentuniver_supabase_last_pulse';
const DEFAULT_COOLDOWN_MINUTES = 30;

/**
 * 触发 Supabase 滴漏保活轻量 Pulse
 * @param options.force 是否强制发送保活请求，忽略本地冷却周期
 * @param options.cooldownMinutes 本地冷却周期（分钟），默认 30 分钟
 */
export async function triggerSupabaseDripPulse(options?: {
  force?: boolean;
  cooldownMinutes?: number;
}): Promise<DripPulseResult> {
  const cooldownMinutes = options?.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const now = Date.now();

  if (typeof window === 'undefined') {
    return {
      success: true,
      source: 'cooldown_skip',
      timestamp: now,
      nextEligibleTime: now,
      message: 'SSR environment, client pulse skipped'
    };
  }

  // 检查本地冷却周期
  const rawLastPulse = localStorage.getItem(STORAGE_KEY_LAST_PULSE);
  const lastPulseTime = rawLastPulse ? parseInt(rawLastPulse, 10) : 0;
  const isCooldownActive = !options?.force && lastPulseTime > 0 && (now - lastPulseTime < cooldownMs);

  if (isCooldownActive) {
    return {
      success: true,
      source: 'cooldown_skip',
      timestamp: lastPulseTime,
      nextEligibleTime: lastPulseTime + cooldownMs,
      message: `Pulse in cooldown period. Next pulse eligible in ${Math.ceil((lastPulseTime + cooldownMs - now) / 60000)} minutes.`
    };
  }

  // 真实 Supabase 客户端保活探测
  if (supabase && isSupabaseConfigured) {
    try {
      const { error } = await supabase
        .from('agent_tasks')
        .select('id', { count: 'exact', head: true })
        .limit(1);

      if (error) {
        const supabaseUrl = (import.meta.env.PUBLIC_SUPABASE_URL as string) || '';
        const supabaseAnonKey = (import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string) || '';
        if (supabaseUrl && supabaseAnonKey) {
          await fetch(`${supabaseUrl}/rest/v1/agent_tasks?select=id&limit=1`, {
            method: 'HEAD',
            headers: {
              apikey: supabaseAnonKey,
              Authorization: `Bearer ${supabaseAnonKey}`
            }
          });
        }
      }

      localStorage.setItem(STORAGE_KEY_LAST_PULSE, String(now));
      return {
        success: true,
        source: 'pulse',
        timestamp: now,
        nextEligibleTime: now + cooldownMs,
        message: 'Supabase drip pulse ping executed successfully.'
      };
    } catch (err: any) {
      console.warn('[Supabase Keepalive] Pulse request failed gracefully:', err?.message || err);
      localStorage.setItem(STORAGE_KEY_LAST_PULSE, String(now));
      return {
        success: false,
        source: 'error',
        timestamp: now,
        nextEligibleTime: now + 60000,
        message: `Supabase ping failed gracefully: ${err?.message || err}`
      };
    }
  }

  // 本地 Mock 兼容降级
  localStorage.setItem(STORAGE_KEY_LAST_PULSE, String(now));
  return {
    success: true,
    source: 'mock_fallback',
    timestamp: now,
    nextEligibleTime: now + cooldownMs,
    message: 'Supabase mock pulse executed successfully (mock mode).'
  };
}

/**
 * 获取当前 Supabase 滴漏保活状态
 */
export function getSupabasePulseStatus(cooldownMinutes: number = DEFAULT_COOLDOWN_MINUTES): PulseStatus {
  if (typeof window === 'undefined') {
    return {
      isConfigured: isSupabaseConfigured,
      lastPulseTimestamp: null,
      nextEligibleTimestamp: null,
      isEligible: false,
      cooldownMinutes
    };
  }

  const rawLastPulse = localStorage.getItem(STORAGE_KEY_LAST_PULSE);
  const lastPulseTimestamp = rawLastPulse ? parseInt(rawLastPulse, 10) : null;
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const now = Date.now();

  if (!lastPulseTimestamp) {
    return {
      isConfigured: isSupabaseConfigured,
      lastPulseTimestamp: null,
      nextEligibleTimestamp: now,
      isEligible: true,
      cooldownMinutes
    };
  }

  const nextEligibleTimestamp = lastPulseTimestamp + cooldownMs;
  const isEligible = now >= nextEligibleTimestamp;

  return {
    isConfigured: isSupabaseConfigured,
    lastPulseTimestamp,
    nextEligibleTimestamp,
    isEligible,
    cooldownMinutes
  };
}

/**
 * 客户端空闲期非阻塞自动初始化滴漏保活
 * @param options.cooldownMinutes 冷却周期（分钟）
 * @param options.delayMs 延迟执行毫秒数，默认 1500ms
 */
export function initSupabaseDripPulse(options?: {
  cooldownMinutes?: number;
  delayMs?: number;
}): void {
  if (typeof window === 'undefined') return;

  const delayMs = options?.delayMs ?? 1500;
  const execute = () => {
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(
        () => {
          triggerSupabaseDripPulse({ cooldownMinutes: options?.cooldownMinutes }).catch(() => {});
        },
        { timeout: 5000 }
      );
    } else {
      setTimeout(() => {
        triggerSupabaseDripPulse({ cooldownMinutes: options?.cooldownMinutes }).catch(() => {});
      }, 500);
    }
  };

  if (document.readyState === 'complete') {
    setTimeout(execute, delayMs);
  } else {
    window.addEventListener('load', () => {
      setTimeout(execute, delayMs);
    }, { once: true });
  }
}
