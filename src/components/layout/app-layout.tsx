'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  Shield,
  Settings,
  History,
  BarChart3,
  Cloud,
  Cpu,
  GitCompare,
  FileText,
  Download,
  Zap,
  Layers,
  CheckCircle,
  Database,
  Loader2,
  User,
  ChevronDown,
  Menu,
  LogOut,
  UserCog,
  MessageCircle,
  Building2,
  BookOpenCheck,
  MessagesSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from '@/components/ui/sheet';
import { UserProfileModal } from '@/components/login/user-profile-modal';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import type { Permission } from '@/lib/api-security';

// 导航分组结构
interface NavigationItem {
  readonly name: string;
  readonly href: string;
  readonly icon: typeof Shield;
  readonly desc: string;
  readonly permission: Permission;
  readonly experimental?: boolean;
}

const navigationGroups: readonly {
  readonly title: string;
  readonly items: readonly NavigationItem[];
}[] = [
  {
    title: '安全运营',
    items: [
      { name: '总览大屏', href: '/dashboard', icon: BarChart3, desc: '运行态势与风险总览', permission: 'history:read' },
      { name: '安全对话', href: '/', icon: MessageCircle, desc: '双引擎安全对话', permission: 'guard:use' },
      { name: '链路实验', href: '/simulate', icon: Zap, desc: '非生产检测流程', permission: 'guard:use', experimental: true },
      { name: '告警明细', href: '/security-alerts', icon: Shield, desc: '统一风险告警与命中证据', permission: 'security:operate' },
      { name: '文档检测', href: '/document-scan', icon: FileText, desc: '文档安全扫描', permission: 'security:operate' },
    ]
  },
  {
    title: '配置管理',
    items: [
      { name: '应用接入', href: '/applications', icon: Building2, desc: '应用、凭据与运行版本', permission: 'application:read' },
      { name: '检测维度', href: '/dimensions', icon: Layers, desc: '维度与规则配置', permission: 'policy:read' },
      { name: '白名单规则', href: '/whitelist', icon: CheckCircle, desc: '安全内容放行', permission: 'policy:manage' },
      { name: '安全策略', href: '/policies', icon: Settings, desc: '检测策略管理', permission: 'policy:manage' },
      { name: '敏感词典', href: '/dictionaries', icon: BookOpenCheck, desc: '分层词典与版本治理', permission: 'policy:read' },
      { name: '响应模板', href: '/response-templates', icon: MessagesSquare, desc: '代答模板与复检治理', permission: 'policy:read' },
      { name: '策略发布', href: '/policy-releases', icon: GitCompare, desc: '审批、灰度与回滚', permission: 'policy:read' },
      { name: '模型管理', href: '/providers', icon: Cloud, desc: '模型供应商配置', permission: 'provider:manage' },
    ]
  },
  {
    title: '策略验证',
    items: [
      { name: '策略验证集', href: '/test-cases', icon: CheckCircle, desc: '验证样本管理', permission: 'policy:read' },
      { name: '评测原型', href: '/model-eval', icon: Cpu, desc: '非生产策略评测原型', permission: 'policy:read', experimental: true },
      { name: '评测门禁', href: '/evaluation-runs', icon: GitCompare, desc: '异步回归与发布证据', permission: 'policy:read' },
    ]
  },
  {
    title: '事件与审计',
    items: [

      { name: '风险事件', href: '/incidents', icon: Shield, desc: '研判与处置闭环', permission: 'security:operate' },
      { name: '请求执行', href: '/gateway-requests', icon: GitCompare, desc: '检测与实际执行链路', permission: 'history:read' },
      { name: '内容审计', href: '/history', icon: History, desc: '检测记录与对话归档', permission: 'history:read' },
      { name: 'Agent日志', href: '/agent-logs', icon: FileText, desc: '调用日志追踪', permission: 'audit:read' },
      { name: '运维巡检', href: '/operations', icon: Cpu, desc: '服务器资源与后台服务', permission: 'observability:metrics:read' },
      { name: '导出报告', href: '/export', icon: Download, desc: '数据导出报告', permission: 'audit:export' },
    ]
  },
];

// 数据库状态类型
type DbStatus = 'checking' | 'connected' | 'disconnected';
// 认证状态类型
type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

// 用户信息类型
interface UserInfo {
  id: string;
  username: string;
  nickname?: string;
  role: string;
  permissions: Permission[];
  mustChangePassword?: boolean;
  tenantId: string;
  applicationId: string;
}

interface ApplicationInfo {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  status: 'active' | 'disabled';
}

export function AppLayout({
  children,
  legacyDemosEnabled,
}: {
  children: React.ReactNode;
  legacyDemosEnabled: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [dbStatus, setDbStatus] = useState<DbStatus>('checking');
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [applications, setApplications] = useState<ApplicationInfo[]>([]);
  const [switchingApplication, setSwitchingApplication] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  const visibleNavigationGroups = navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (
        user?.permissions.includes(item.permission)
        && (!item.experimental || legacyDemosEnabled)
      )),
    }))
    .filter((group) => group.items.length > 0);

  // 认证页面不显示主应用布局
  const isAuthPage = pathname === '/login' || pathname === '/change-password';

  // 检查登录状态
  useEffect(() => {
    if (isAuthPage) {
      setAuthStatus('unauthenticated');
      return;
    }

    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth/me', {
          method: 'GET',
          cache: 'no-store'
        });

        if (res.ok) {
          const data = await res.json();
          if (data.success && data.user) {
            if (data.user.mustChangePassword) {
              router.replace('/change-password');
              return;
            }
            setUser(data.user);
            setAuthStatus('authenticated');
            const applicationsResponse = await fetch('/api/applications', {
              method: 'GET',
              cache: 'no-store',
            });
            if (applicationsResponse.ok) {
              const applicationsPayload = await applicationsResponse.json();
              setApplications(
                (applicationsPayload.items ?? []).filter(
                  (item: ApplicationInfo) => item.status === 'active',
                ),
              );
            }
          } else {
            setAuthStatus('unauthenticated');
            router.push('/login');
          }
        } else {
          setAuthStatus('unauthenticated');
          router.push('/login');
        }
      } catch {
        setAuthStatus('unauthenticated');
        router.push('/login');
      }
    };

    checkAuth();
  }, [pathname, isAuthPage, router]);

  // 数据库状态检查:登录后立即探测,并按固定间隔刷新。
  // 注意:后端 /api/health/db 成功时返回 { status: 'ready' },不下发 connected 字段,
  // 因此必须按 status==='ready' 判定“已连接”,而不能读 data.connected。
  useEffect(() => {
    if (isAuthPage || authStatus !== 'authenticated') return;

    const checkDbStatus = async () => {
      try {
        const res = await fetch('/api/health/db', {
          method: 'GET',
          cache: 'no-store'
        });
        const data = await res.json();
        setDbStatus(res.ok && data.status === 'ready' ? 'connected' : 'disconnected');
      } catch {
        setDbStatus('disconnected');
      }
    };

    checkDbStatus();
    const intervalId = setInterval(checkDbStatus, 30_000);
    return () => clearInterval(intervalId);
  }, [isAuthPage, authStatus]);

  // 退出登录
  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: csrfHeaders() });
      router.push('/login');
    } catch {
      router.push('/login');
    }
  };

  const handleApplicationChange = async (applicationId: string) => {
    const application = applications.find((item) => item.id === applicationId);
    if (!application || application.id === user?.applicationId) return;
    setSwitchingApplication(true);
    try {
      const response = await fetch('/api/auth/scope', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...csrfHeaders(),
        },
        body: JSON.stringify({
          tenantId: application.tenantId,
          applicationId: application.id,
        }),
      });
      if (response.ok) {
        window.location.reload();
      }
    } finally {
      setSwitchingApplication(false);
    }
  };

  // 登录页面直接返回children
  if (isAuthPage) {
    return <>{children}</>;
  }

  // 认证检查中显示加载状态
  if (authStatus === 'checking') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          <span className="text-sm text-gray-500">正在验证登录状态...</span>
        </div>
      </div>
    );
  }

  // 未认证时不渲染内容（已跳转到登录页）
  if (authStatus === 'unauthenticated') {
    return null;
  }

  if (!legacyDemosEnabled && (pathname === '/simulate' || pathname === '/model-eval')) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border bg-white p-8 text-center shadow-sm">
          <Shield className="mx-auto mb-4 h-10 w-10 text-amber-500" />
          <h1 className="text-xl font-semibold">实验功能未启用</h1>
          <p className="mt-2 text-sm text-gray-600">该旧版演示界面默认不进入正式产品面，仅可通过显式部署开关启用。</p>
        </div>
      </div>
    );
  }

  const navigation = (
    <nav aria-label="主导航" className="space-y-4 px-2.5 py-4">
      {visibleNavigationGroups.map((group) => (
        <div key={group.title}>
          <p className="px-3 pb-2 text-[10px] font-medium tracking-wider text-slate-400">{group.title}</p>
          <div className="space-y-1">
            {group.items.map((item) => {
              const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href + '/'));
              return (
                <Link key={item.href} href={item.href} title={item.desc}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => setMobileNavOpen(false)}
                  className={cn('flex min-h-10 items-center gap-3 rounded-[5px] px-3 py-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                    isActive ? 'bg-primary font-medium text-white shadow-[0_2px_6px_#0057ff20]' : 'text-slate-600 hover:bg-blue-50 hover:text-primary')}>
                  <item.icon className={cn('size-[17px] shrink-0', !isActive && 'text-slate-400')} strokeWidth={1.7} aria-hidden="true" />
                  <span className="truncate">{item.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="console-shell min-h-screen bg-background">
      <a href="#main-content" className="sr-only z-[100] rounded bg-white p-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-2">跳转到主内容</a>
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center border-b border-border bg-white">
        <Link href={user?.permissions.includes('history:read') ? '/dashboard' : '/'} aria-label="国舜控制台"
          className="hidden h-full w-[188px] shrink-0 items-center justify-center border-r border-border md:flex">
          <Image src="/logo.png" alt="国舜" width={144} height={36} unoptimized className="h-9 w-auto max-w-[144px] object-contain" />
        </Link>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger asChild><Button variant="ghost" size="icon" className="md:hidden" aria-label="打开导航"><Menu /></Button></SheetTrigger>
              <SheetContent side="left" className="w-60 gap-0 overflow-y-auto p-0">
                <SheetHeader className="border-b border-border px-5 py-4">
                  <SheetTitle>国舜安全网关</SheetTitle><SheetDescription className="sr-only">选择功能页面</SheetDescription>
                </SheetHeader>
                {navigation}
              </SheetContent>
            </Sheet>
            <span className="truncate text-sm font-semibold tracking-wide sm:text-[15px]">国舜大模型安全网关平台</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            {applications.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Building2 className="hidden size-4 sm:block" aria-hidden="true" /><span className="sr-only">当前应用</span>
                <select aria-label="当前应用" value={user?.applicationId ?? ''} disabled={switchingApplication}
                  onChange={(event) => void handleApplicationChange(event.target.value)}
                  className="h-8 max-w-24 rounded border border-border bg-white px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary/30 sm:max-w-44">
                  {applications.map((application) => <option key={application.id} value={application.id}>{application.name}</option>)}
                </select>
              </label>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-1.5" aria-label="用户菜单">
                  <span className="flex size-7 items-center justify-center rounded-full bg-primary text-white"><User className="size-4" /></span>
                  <span className="hidden max-w-28 truncate text-xs sm:inline">{user?.nickname || user?.username || '用户'}</span>
                  <ChevronDown className="size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => setShowProfileModal(true)}><UserCog className="size-4" />信息修改</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void handleLogout()} className="text-red-600"><LogOut className="size-4" />退出登录</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <aside className="fixed bottom-0 left-0 top-14 z-30 hidden w-[188px] flex-col border-r border-border bg-white md:flex">
        <div className="min-h-0 flex-1 overflow-y-auto">{navigation}</div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-4 text-[11px] text-muted-foreground" aria-live="polite">
          <Database className="size-3.5" aria-hidden="true" /><span>数据服务</span>
          <span className="ml-auto flex items-center gap-1.5">
            {dbStatus === 'checking' ? <><Loader2 className="size-3 animate-spin" />检查中</> : <><span className={cn('size-1.5 rounded-full', dbStatus === 'connected' ? 'bg-emerald-500' : 'bg-amber-500')} />{dbStatus === 'connected' ? '已连接' : '待连接'}</>}
          </span>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1} className="console-content min-h-screen min-w-0 px-3 pb-6 pt-[76px] outline-none sm:px-5 md:ml-[188px]">
        {children}
      </main>
      <UserProfileModal open={showProfileModal} onOpenChange={setShowProfileModal} user={user}
        onUserUpdate={(updatedUser) => setUser((current) => (current ? { ...current, ...updatedUser } : current))} />
    </div>
  );
}
