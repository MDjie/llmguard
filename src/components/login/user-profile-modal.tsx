'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UserCog, User, Mail, Phone, Building, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { csrfHeaders } from '@/lib/auth/csrf-client';

interface UserInfo {
  id: string;
  username: string;
  nickname?: string;
  email?: string;
  phone?: string;
  department?: string;
  role: string;
}

interface UserProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserInfo | null;
  onUserUpdate?: (user: UserInfo) => void;
}

export function UserProfileModal({ open, onOpenChange, user, onUserUpdate }: UserProfileModalProps) {
  const [formData, setFormData] = useState({
    nickname: '',
    email: '',
    phone: '',
    department: '',
  });
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setFormData({
        nickname: user.nickname || '',
        email: user.email || '',
        phone: user.phone || '',
        department: user.department || '',
      });
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const changes: Record<string, string | null> = {};
    for (const key of ['nickname', 'email', 'phone', 'department'] as const) {
      const value = formData[key].trim();
      if (value !== (user[key] ?? '')) changes[key] = value || null;
    }
    if (!Object.keys(changes).length) { onOpenChange(false); return; }
    setIsLoading(true);
    try {
      const response = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(changes),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success('用户信息更新成功');
        onUserUpdate?.({ ...user, nickname: data.user.nickname ?? '', email: data.user.email ?? '', phone: data.user.phone ?? '', department: data.user.department ?? '' });
        onOpenChange(false);
      } else {
        toast.error(data.detail || data.error || '更新失败');
      }
    } catch {
      toast.error('网络错误，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-blue-100">
              <UserCog className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <DialogTitle>信息修改</DialogTitle>
              <DialogDescription>
                修改您的个人信息，保存后立即生效。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* 用户名（只读） */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">用户名</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                value={user?.username || ''}
                disabled
                className="pl-10 bg-gray-50 text-gray-500"
              />
            </div>
          </div>

          {/* 角色（只读） */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">角色</label>
            <div className="relative">
              <Building className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                value={user?.role === 'admin' ? '管理员' : user?.role === 'user' ? '普通用户' : user?.role || ''}
                disabled
                className="pl-10 bg-gray-50 text-gray-500"
              />
            </div>
          </div>

          {/* 昵称 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">昵称</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                value={formData.nickname}
                onChange={(e) => setFormData({ ...formData, nickname: e.target.value })}
                placeholder="请输入昵称"
                className="pl-10"
              />
            </div>
          </div>

          {/* 邮箱 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">邮箱</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="请输入邮箱"
                className="pl-10"
              />
            </div>
          </div>

          {/* 电话 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">联系电话</label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="请输入联系电话"
                className="pl-10"
              />
            </div>
          </div>

          {/* 部门 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">部门</label>
            <div className="relative">
              <Building className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                value={formData.department}
                onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                placeholder="请输入部门"
                className="pl-10"
              />
            </div>
          </div>

          {/* 按钮 */}
          <div className="flex gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  保存中...
                </>
              ) : (
                '保存'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
