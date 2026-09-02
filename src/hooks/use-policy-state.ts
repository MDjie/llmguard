'use client';

/**
 * 策略状态管理Hook
 * 用于在客户端管理策略升级状态和会话ID
 */

import { useEffect, useState, useCallback } from 'react';
import { csrfHeaders } from '@/lib/auth/csrf-client';

/**
 * 生成 UUID（兼容所有环境）
 */
function generateUUID(): string {
  // 优先使用 crypto.randomUUID
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // 使用 crypto.getRandomValues 作为备选
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // 设置版本位（UUID v4）
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // 最后备选：使用 Math.random（不太安全但可用）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

interface EscalationInfo {
  message: string | null;
  isEscalated: boolean;
  isDeescalated: boolean;
}

/**
 * 策略状态管理Hook
 */
export function usePolicyState(defaultUserId: string = 'anonymous') {
  const [sessionId, setSessionId] = useState<string>('');
  const [userId] = useState<string>(defaultUserId);
  const [isInitialized, setIsInitialized] = useState(false);

  // 初始化会话ID
  useEffect(() => {
    // 从 sessionStorage 获取或创建会话ID
    let storedSessionId = sessionStorage.getItem('guard_session_id');

    if (!storedSessionId) {
      storedSessionId = generateUUID();
      sessionStorage.setItem('guard_session_id', storedSessionId);
      console.log('[策略状态] 创建新会话:', storedSessionId);
    } else {
      console.log('[策略状态] 使用已有会话:', storedSessionId);
    }

    setSessionId(storedSessionId);
    setIsInitialized(true);
  }, []);

  // 重置会话状态（用于页面刷新前）
  const resetSession = useCallback(async () => {
    if (!sessionId) return;

    try {
      await fetch('/api/policy-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          sessionId,
          action: 'reset',
        }),
        keepalive: true,
      });
      console.log('[策略状态] 会话已重置');
    } catch (error) {
      console.error('[策略状态] 重置失败:', error);
    }
  }, [sessionId]);

  // 强制重置会话（清除 sessionStorage 并创建新会话）
  const forceNewSession = useCallback(async () => {
    const newSessionId = generateUUID();
    sessionStorage.setItem('guard_session_id', newSessionId);
    setSessionId(newSessionId);

    // 同时通知后端重置旧会话
    await resetSession();

    console.log('[策略状态] 强制创建新会话:', newSessionId);
  }, [resetSession]);

  // 页面刷新/关闭时重置会话状态
  useEffect(() => {
    const handleBeforeUnload = () => {
      resetSession();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [resetSession]);

  return {
    sessionId,
    userId,
    isInitialized,
    resetSession,
    forceNewSession,
  };
}

/**
 * 处理检测结果中的策略升级信息
 */
export function processEscalationInfo(detectionResult: unknown): EscalationInfo {
  const result =
    typeof detectionResult === 'object' && detectionResult !== null
      ? (detectionResult as Record<string, unknown>)
      : {};
  const message =
    typeof result.escalationMessage === 'string' ? result.escalationMessage : null;
  const isEscalated = result.policyEscalated === true;
  const isDeescalated = result.policyDeescalated === true;

  return {
    message,
    isEscalated,
    isDeescalated,
  };
}
