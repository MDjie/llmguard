'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { csrfHeaders } from '@/lib/auth/csrf-client';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmation) {
      toast.error('两次输入的新密码不一致');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success('密码已更新');
        router.replace('/');
        return;
      }
      if (response.status === 401) {
        router.replace('/login');
        return;
      }
      toast.error(data.detail || '密码更新失败');
    } catch {
      toast.error('网络错误，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: csrfHeaders() }).catch(() => undefined);
    router.replace('/login');
  };

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-12 text-gray-900">
      <section className="mx-auto w-full max-w-md rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            <ShieldCheck aria-hidden="true" className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">更新登录密码</h1>
            <p className="mt-1 text-sm text-gray-500">大模型安全护栏检测平台</p>
          </div>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <label className="block space-y-2">
            <span className="text-sm font-medium">当前密码</span>
            <Input
              autoComplete="current-password"
              type={showPasswords ? 'text' : 'password'}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">新密码</span>
            <div className="relative">
              <Input
                autoComplete="new-password"
                className="pr-11"
                type={showPasswords ? 'text' : 'password'}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
              <button
                type="button"
                title={showPasswords ? '隐藏密码' : '显示密码'}
                className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center text-gray-500 hover:text-gray-800"
                onClick={() => setShowPasswords((visible) => !visible)}
              >
                {showPasswords ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">确认新密码</span>
            <Input
              autoComplete="new-password"
              type={showPasswords ? 'text' : 'password'}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
            />
          </label>

          <Button className="w-full" disabled={submitting} type="submit">
            <KeyRound className="mr-2 h-4 w-4" />
            {submitting ? '正在更新' : '更新密码'}
          </Button>
          <Button className="w-full" type="button" variant="outline" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            退出登录
          </Button>
        </form>
      </section>
    </main>
  );
}
