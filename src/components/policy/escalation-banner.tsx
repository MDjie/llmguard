/**
 * 策略升级提示横幅组件
 * 用于在页面顶部显示策略升级/降级提示
 */

'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, X, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EscalationBannerProps {
  message: string;
  type: 'escalate' | 'deescalate';
  onClose?: () => void;
  autoCloseDelay?: number; // 自动关闭延迟（毫秒）
}

export function EscalationBanner({
  message,
  type,
  onClose,
  autoCloseDelay = 5000,
}: EscalationBannerProps) {
  const [visible, setVisible] = useState(true);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (autoCloseDelay > 0) {
      const timer = setTimeout(() => {
        handleClose();
      }, autoCloseDelay);
      return () => clearTimeout(timer);
    }
  }, [autoCloseDelay]);

  function handleClose() {
    setIsLeaving(true);
    setTimeout(() => {
      setVisible(false);
      onClose?.();
    }, 300); // 等待动画完成
  }

  if (!visible) return null;

  const isEscalate = type === 'escalate';

  return (
    <div
      className={cn(
        'fixed top-0 left-0 right-0 z-[100] flex items-center justify-between px-4 py-3 border-b shadow-md transition-all duration-300',
        isEscalate
          ? 'bg-orange-50 border-orange-200 text-orange-800'
          : 'bg-green-50 border-green-200 text-green-800',
        isLeaving ? 'opacity-0 -translate-y-2' : 'opacity-100 translate-y-0'
      )}
      role="alert"
    >
      <div className="flex items-center gap-3">
        <div className={cn(
          'flex items-center justify-center rounded-full p-1',
          isEscalate ? 'bg-orange-100' : 'bg-green-100'
        )}>
          {isEscalate ? (
            <AlertTriangle className="h-5 w-5 text-orange-600" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-green-600" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Shield className={cn(
            'h-4 w-4',
            isEscalate ? 'text-orange-600' : 'text-green-600'
          )} />
          <span className="font-medium text-sm">{message}</span>
        </div>
      </div>
      <button
        onClick={handleClose}
        className={cn(
          'p-1.5 rounded-full transition-colors',
          isEscalate
            ? 'hover:bg-orange-100 text-orange-600'
            : 'hover:bg-green-100 text-green-600'
        )}
        aria-label="关闭提示"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * 策略升级提示管理器
 * 用于管理提示的显示和消失
 */
interface EscalationNotification {
  id: string;
  message: string;
  type: 'escalate' | 'deescalate';
  timestamp: number;
}

export function useEscalationNotifications() {
  const [notifications, setNotifications] = useState<EscalationNotification[]>([]);

  const addNotification = (message: string, type: 'escalate' | 'deescalate') => {
    const id = crypto.randomUUID();
    setNotifications(prev => [...prev, { id, message, type, timestamp: Date.now() }]);
    return id;
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  return {
    notifications,
    addNotification,
    removeNotification,
    clearAll,
  };
}

/**
 * 策略升级提示容器组件
 * 用于渲染多个提示
 */
interface EscalationBannerContainerProps {
  notifications: EscalationNotification[];
  onRemove: (id: string) => void;
}

export function EscalationBannerContainer({
  notifications,
  onRemove,
}: EscalationBannerContainerProps) {
  // 只显示最新的一个通知
  const latestNotification = notifications[notifications.length - 1];

  if (!latestNotification) return null;

  return (
    <EscalationBanner
      message={latestNotification.message}
      type={latestNotification.type}
      onClose={() => onRemove(latestNotification.id)}
    />
  );
}
