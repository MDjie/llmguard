'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  Shield,
  Settings,
  History,
  BarChart3,
  TestTube,
  Cloud,
  GitCompare,
  Cpu,
  FileText,
  Download,
  Zap,
  Layers,
  CheckCircle,
  Sparkles,
  Database,
  Loader2,
  User,
  ChevronDown,
  LogOut,
  UserCog,
  MessageCircle
} from 'lucide-react';
import { UserProfileModal } from '@/components/login/user-profile-modal';

// 导航分组结构
const navigationGroups = [
  {
    title: '核心功能',
    items: [
      { name: '安全对话', href: '/', icon: MessageCircle, desc: '双引擎安全对话' },
      { name: '链路演示', href: '/simulate', icon: Zap, desc: '完整检测流程' },
      { name: '文档检测', href: '/document-scan', icon: FileText, desc: '文档安全扫描' },
    ]
  },
  {
    title: '配置管理',
    items: [
      { name: '检测维度', href: '/dimensions', icon: Layers, desc: '维度与规则配置' },
      { name: '白名单规则', href: '/whitelist', icon: CheckCircle, desc: '安全内容放行' },
      { name: '策略配置', href: '/policies', icon: Settings, desc: '检测策略管理' },
      { name: '模型管理', href: '/providers', icon: Cloud, desc: '模型供应商配置' },
    ]
  },
  {
    title: '测试评估',
    items: [
      { name: '测试用例', href: '/test-cases', icon: TestTube, desc: '用例管理与执行' },
      { name: '多模型评测', href: '/model-eval', icon: Cpu, desc: '模型安全评估' },
    ]
  },
  {
    title: '数据统计',
    items: [
      { name: '检测看板', href: '/dashboard', icon: BarChart3, desc: '数据可视化' },
      { name: '历史记录', href: '/history', icon: History, desc: '检测历史查询' },
      { name: 'Agent日志', href: '/agent-logs', icon: FileText, desc: '调用日志追踪' },
      { name: '导出报告', href: '/export', icon: Download, desc: '数据导出报告' },
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
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [dbStatus, setDbStatus] = useState<DbStatus>('checking');
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const hasCheckedRef = useRef(false);

  // 登录页面不显示布局
  const isLoginPage = pathname === '/login';

  // 检查登录状态
  useEffect(() => {
    if (isLoginPage) {
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
            setUser(data.user);
            setAuthStatus('authenticated');
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
  }, [pathname, isLoginPage, router]);

  // 只在首次访问时检查数据库状态
  useEffect(() => {
    if (hasCheckedRef.current || isLoginPage || authStatus !== 'authenticated') return;
    hasCheckedRef.current = true;

    const checkDbStatus = async () => {
      try {
        const res = await fetch('/api/health/db', {
          method: 'GET',
          cache: 'no-store'
        });

        if (res.ok) {
          const data = await res.json();
          setDbStatus(data.connected ? 'connected' : 'disconnected');
        } else {
          setDbStatus('disconnected');
        }
      } catch {
        setDbStatus('disconnected');
      }
    };

    checkDbStatus();
  }, [isLoginPage, authStatus]);

  // 点击外部关闭用户菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 退出登录
  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
    } catch {
      router.push('/login');
    }
  };

  // 登录页面直接返回children
  if (isLoginPage) {
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航栏 */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="flex items-center justify-between h-16 px-6">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="国舜" className="h-10 w-auto" />
            <div>
              <h1 className="text-lg font-bold text-gray-900">
                大模型安全护栏检测平台
              </h1>
              <p className="text-xs text-gray-500">
                多模型接入 · 全链路检测 · 智能防护
              </p>
            </div>
          </div>
          
          {/* 用户信息 */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center justify-center w-8 h-8 bg-blue-100 rounded-full">
                <User className="h-4 w-4 text-blue-600" />
              </div>
              <span className="text-sm font-medium text-gray-700">
                {user?.nickname || user?.username || '用户'}
              </span>
              <ChevronDown className="h-4 w-4 text-gray-400" />
            </button>

            {/* 下拉菜单 */}
            {showUserMenu && (
              <div className="absolute right-0 top-full mt-2 w-48bg-white rounded-lg shadow-lg border border-gray-100 py-1 z-50">
                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    setShowProfileModal(true);
                  }}
                  className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <UserCog className="h-4 w-4" />
                  信息修改
                </button>
                <div className="border-t border-gray-100 my-1"></div>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 用户信息修改弹窗 */}
      <UserProfileModal
        open={showProfileModal}
        onOpenChange={setShowProfileModal}
        user={user}
        onUserUpdate={(updatedUser) => setUser(updatedUser)}
      />

      <div className="flex">
        {/* 侧边栏 */}
        <aside className="w-60 bg-white border-r border-gray-200 min-h-[calc(100vh-64px)] sticky top-16 overflow-y-auto">
          <nav className="p-3 space-y-4">
            {navigationGroups.map((group) => (
              <div key={group.title}>
                {/* 分组标题 */}
                <div className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
                  <div className="h-px flex-1 bg-gray-100"></div>
                  <span>{group.title}</span>
                  <div className="h-px flex-1 bg-gray-100"></div>
                </div>
                
                {/* 分组菜单项 */}
                <div className="space-y-0.5 mt-1">
                  {group.items.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                      <Link
                        key={item.name}
                        href={item.href}
                        className={cn(
                          'group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                          isActive
                            ? 'bg-gradient-to-r from-blue-50 to-blue-100/50 text-blue-700 shadow-sm'
                            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                        )}
                      >
                        <div className={cn(
                          'flex items-center justify-center w-8 h-8 rounded-lg transition-colors',
                          isActive 
                            ? 'bg-blue-100 text-blue-600' 
                            : 'bg-gray-50 text-gray-400 group-hover:bg-gray-100 group-hover:text-gray-500'
                        )}>
                          <item.icon className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="truncate">{item.name}</div>
                          <div className={cn(
                            'text-xs truncate',
                            isActive ? 'text-blue-500' : 'text-gray-400'
                          )}>
                            {item.desc}
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          
          {/* 底部信息 */}
          <div className="p-4 border-t border-gray-100 mt-4">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Database className="h-3 w-3" />
              <span>数据库状态</span>
              <span className="ml-auto flex items-center gap-1">
                {dbStatus === 'checking' && (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>检查中</span>
                  </>
                )}
                {dbStatus === 'connected' && (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500"></span>
                    <span className="text-green-600">已连接</span>
                  </>
                )}
                {dbStatus === 'disconnected' && (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                    <span className="text-amber-600">待连接</span>
                  </>
                )}
              </span>
            </div>
          </div>
        </aside>

        {/* 主内容区 */}
        <main className="flex-1 p-6 min-h-[calc(100vh-64px)]">
          {children}
        </main>
      </div>
    </div>
  );
}
