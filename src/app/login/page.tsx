'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Eye, EyeOff, User, Lock, Shield, RefreshCw, Headphones, HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ContactModal } from '@/components/login/contact-modal';
import { HelpModal } from '@/components/login/help-modal';
import { landingForRole } from '@/lib/iam/oidc-config';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [enterpriseEnabled,setEnterpriseEnabled] = useState(false);
  useEffect(()=>{void fetch('/api/auth/oidc/config').then(async response=>{
    if(response.ok){const data:unknown=await response.json();setEnterpriseEnabled(typeof data==='object'&&data!==null&&'enabled' in data&&data.enabled===true);}
  }).catch(()=>undefined);},[]);
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [captchaCode, setCaptchaCode] = useState('');
  const [showContactModal, setShowContactModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  // 生成随机验证码
  const generateCaptcha = useCallback(() => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setCaptchaCode(code);
    setCaptcha('');
  }, []);

  // 页面加载时生成验证码
  useEffect(() => {
    generateCaptcha();
  }, [generateCaptcha]);

  // 处理登录
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!username.trim()) {
      toast.error('请输入用户名');
      return;
    }
    if (!password.trim()) {
      toast.error('请输入密码');
      return;
    }
    if (!captcha.trim()) {
      toast.error('请输入验证码');
      return;
    }
    if (captcha.toUpperCase() !== captchaCode) {
      toast.error('验证码错误');
      generateCaptcha();
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, rememberMe }),
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.success) {
        toast.success('登录成功');
        // 保存用户信息
        if (rememberMe) {
          localStorage.setItem('rememberedUsername', username);
        }
        router.push(data.user?.mustChangePassword ? '/change-password' : landingForRole(String(data.user?.role)));
      } else {
        const message = response.status >= 500
          ? '认证服务暂不可用，请稍后重试'
          : data.detail || data.error || `登录失败 (${response.status})`;
        toast.error(message);

        // Only consume the client-side challenge when credentials were evaluated.
        // Infrastructure and rate-limit failures should not force another captcha.
        if (response.status === 401 || response.status === 403) {
          generateCaptcha();
        }
      }
    } catch {
      toast.error('网络错误，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* 背景装饰 */}
      <div className="bg-arc" />

      {/* 主布局 */}
      <section className="layout">
        {/* 左侧品牌区域 */}
        <div className="left-section">
          <h1 className="hero-title">国舜大模型安全护栏检测平台</h1>
          <p className="hero-subtitle">
            智能守护大模型安全 · 全面检测风险隐患 · 构建可信 <span>AI</span> 生态
          </p>

          <div className="feature-pills">
            <span className="feature-pill">输入输出双向检测</span>
            <span className="feature-pill">提示词注入识别</span>
            <span className="feature-pill">敏感信息防泄露</span>
            <span className="feature-pill">策略化风险拦截</span>
          </div>

          <div className="hero-visual-wrap">
            <img
              src="/hero-illustration.png"
              alt="AI安全护栏检测平台"
              className="hero-visual"
            />
          </div>
        </div>

        {/* 右侧登录区域 */}
        <div className="right-section">
          <div className="login-card">
            <div className="login-inner">
              <Image
                src="/logo.png"
                alt="国舜"
                width={234}
                height={80}
                className="card-logo"
              />
              <h2 className="welcome">欢迎登录国舜大模型安全护栏检测平台</h2>
              <div className="blue-line" />

              <form onSubmit={handleLogin} className="form">
                {enterpriseEnabled && <Button type="button" variant="outline" onClick={()=>{window.location.assign('/api/auth/oidc/start');}}>企业登录（多因素认证）</Button>}
                {/* 用户名 */}
                <div className="field">
                  <User className="field-icon" />
                  <Input
                    type="text"
                    placeholder="请输入用户名"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="field-input"
                  />
                </div>

                {/* 密码 */}
                <div className="field">
                  <Lock className="field-icon" />
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="field-input"
                  />
                  <button
                    type="button"
                    className="eye-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>

                {/* 验证码 */}
                <div className="captcha-row">
                  <div className="field">
                    <Shield className="field-icon" />
                    <Input
                      type="text"
                      placeholder="请输入验证码"
                      value={captcha}
                      onChange={(e) => setCaptcha(e.target.value)}
                      className="field-input"
                      maxLength={4}
                    />
                  </div>
                  <div className="captcha" onClick={generateCaptcha}>
                    {captchaCode}
                  </div>
                  <button
                    type="button"
                    className="refresh-btn"
                    onClick={generateCaptcha}
                    title="刷新验证码"
                  >
                    <RefreshCw className="w-5 h-5" />
                  </button>
                </div>

                {/* 选项 */}
                <div className="options">
                  <label className="checkbox-label">
                    <Checkbox
                      checked={rememberMe}
                      onCheckedChange={(checked) => setRememberMe(checked as boolean)}
                    />
                    <span>记住用户名</span>
                  </label>
                </div>

                {/* 登录按钮 */}
                <Button
                  type="submit"
                  className="login-btn"
                  disabled={isLoading}
                >
                  {isLoading ? '登录中...' : '登 录'}
                </Button>
              </form>

              {/* 底部链接 */}
              <div className="card-bottom">
                <button
                  type="button"
                  onClick={() => setShowContactModal(true)}
                  className="bottom-link"
                >
                  <Headphones className="w-5 h-5" />
                  联系客服
                </button>
                <span className="vline" />
                <button
                  type="button"
                  onClick={() => setShowHelpModal(true)}
                  className="bottom-link"
                >
                  <HelpCircle className="w-5 h-5" />
                  帮助中心
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 弹窗 */}
      <ContactModal open={showContactModal} onOpenChange={setShowContactModal} />
      <HelpModal open={showHelpModal} onOpenChange={setShowHelpModal} />

      <style jsx>{`
        :global(html, body) {
          height: 100%;
          margin: 0;
          padding: 0;
          overflow: hidden;
        }

        :global(body) {
          background: linear-gradient(116deg, #f9fcff 0%, #eef6ff 46%, #eaf3ff 100%);
        }

        .login-page {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          background:
            radial-gradient(circle at 7% 5%, rgba(255, 255, 255, 0.9) 0 10%, transparent 28%),
            radial-gradient(circle at 28% 10%, rgba(255, 255, 255, 0.85) 0 9%, transparent 27%),
            linear-gradient(116deg, #f9fcff 0%, #eef6ff 46%, #eaf3ff 100%);
        }

        .login-page::before {
          content: "";
          position: absolute;
          inset: 0;
          background:
            linear-gradient(120deg, transparent 0 46%, rgba(255,255,255,0.46) 46.1% 47.3%, transparent 47.4%),
            radial-gradient(circle at 84% 10%, rgba(56, 139, 255, 0.16), transparent 28%),
            radial-gradient(circle at 42% 82%, rgba(0, 113, 232, 0.12), transparent 27%);
          pointer-events: none;
        }

        .login-page::after {
          content: "";
          position: absolute;
          right: 12px;
          top: 18px;
          width: 255px;
          height: 190px;
          opacity: 0.45;
          background-image: radial-gradient(rgba(76, 146, 233, 0.45) 1.4px, transparent 1.4px);
          background-size: 16px 16px;
          pointer-events: none;
        }

        .bg-arc {
          position: absolute;
          left: 49.2%;
          top: -17%;
          width: 520px;
          height: 128%;
          border-left: 20px solid rgba(32, 119, 232, 0.08);
          border-radius: 100% 0 0 100%;
          transform: rotate(3deg);
          pointer-events: none;
        }

        .layout {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: minmax(700px, 1fr) 650px;
          gap: 18px;
          width: 100%;
          height: 100%;
          padding: 64px 88px 48px 64px;
        }

        .left-section {
          position: relative;
          min-width: 0;
          height: 100%;
        }

        .brand-logo {
          filter: drop-shadow(0 8px 16px rgba(0, 84, 192, 0.08));
        }

        .hero-title {
          margin: 0;
          font-size: clamp(42px, 3.35vw, 62px);
          line-height: 1.14;
          letter-spacing: 1px;
          font-weight: 800;
          color: #102b55;
          text-shadow: 0 1px 0 rgba(255,255,255,0.8);
          white-space: nowrap;
        }

        .hero-subtitle {
          margin: 22px 0 0;
          font-size: clamp(18px, 1.25vw, 24px);
          line-height: 1.7;
          letter-spacing: 1px;
          color: #60728f;
          font-weight: 500;
          white-space: nowrap;
        }

        .hero-subtitle span {
          color: #0a64d6;
          font-weight: 600;
        }

        .hero-visual-wrap {
          position: absolute;
          left: -36px;
          bottom: 100px;
          width: min(760px, 92%);
          pointer-events: none;
        }

        .hero-visual-wrap::before {
          content: "";
          position: absolute;
          left: 52px;
          right: 40px;
          bottom: 30px;
          height: 95px;
          background: radial-gradient(ellipse at center, rgba(0, 98, 224, 0.18), transparent 68%);
          filter: blur(8px);
          z-index: 0;
        }

        .hero-visual {
          position: relative;
          z-index: 1;
          width: 100%;
          height: auto;
          margin-top: 46px;
          transform: translateX(-10px);
          filter: drop-shadow(0 28px 60px rgba(0, 91, 200, 0.18));
        }

        .feature-pills {
          display: flex;
          gap: 12px;
          margin-top: 22px;
        }

        .feature-pill {
          padding: 8px 14px;
          border-radius: 999px;
          background: rgba(255,255,255,0.68);
          border: 1px solid rgba(45, 126, 255, 0.18);
          color: #31527c;
          font-size: 14px;
        }

        .footer {
          position: absolute;
          left: 0;
          bottom: 12px;
          display: flex;
          align-items: center;
          gap: 20px;
          color: #74849a;
          font-size: 14px;
          white-space: nowrap;
        }

        .sep {
          width: 1px;
          height: 16px;
          background: #b8c6d8;
        }

        .police-badge {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        :global(.police-dot) {
          display: inline-block;
          width: 15px;
          height: 15px;
          border-radius: 50%;
          background: radial-gradient(circle at 55% 42%, #f8d24b 0 28%, #db1f24 31% 55%, #0e66c8 58% 100%);
          box-shadow: 0 1px 2px rgba(0,0,0,0.12);
        }

        .right-section {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          height: 100%;
        }

        .login-card {
          position: relative;
          width: 620px;
          max-width: 100%;
          min-height: 620px;
          padding: 54px 64px 42px;
          border: 1px solid rgba(255, 255, 255, 0.85);
          border-radius: 28px;
          background: rgba(255,255,255,0.92);
          box-shadow: 0 28px 70px rgba(25, 76, 143, 0.15);
          backdrop-filter: blur(16px);
        }

        .login-card::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background:
            radial-gradient(circle at 50% 0%, rgba(26, 113, 255, 0.08), transparent 32%),
            linear-gradient(180deg, rgba(255,255,255,0.66), transparent 42%);
          pointer-events: none;
        }

        .login-inner {
          position: relative;
          z-index: 1;
        }

        :global(.card-logo) {
          display: block;
          margin: 0 auto 18px;
          width: 200px;
          height: auto;
          filter: drop-shadow(0 8px 16px rgba(7, 95, 213, 0.08));
        }

        .welcome {
          margin: 0;
          text-align: center;
          font-size: 22px;
          font-weight: 600;
          line-height: 1.4;
          letter-spacing: 0.2px;
          color: #1b3359;
        }

        .blue-line {
          width: 47px;
          height: 4px;
          margin: 16px auto 28px;
          border-radius: 999px;
          background: linear-gradient(90deg, #0a5fda, #0888ff);
        }

        .form {
          width: 100%;
        }

        .field {
          position: relative;
          display: flex;
          align-items: center;
          height: 56px;
          margin-bottom: 16px;
          border: 1px solid #d5dfec;
          border-radius: 10px;
          background: rgba(255,255,255,0.82);
          transition: 0.2s ease;
        }

        .field:hover {
          border-color: #b7cbeb;
          box-shadow: 0 8px 22px rgba(15, 96, 210, 0.06);
        }

        .field:focus-within {
          border-color: #0b72e9;
          box-shadow: 0 0 0 3px rgba(11, 114, 233, 0.1);
        }

        :global(.field-icon) {
          flex: 0 0 auto;
          width: 22px;
          height: 22px;
          margin-left: 20px;
          color: #9aa9bd;
        }

        :global(.field-input) {
          width: 100%;
          height: 100%;
          padding: 0 16px;
          border: none !important;
          background: transparent !important;
          font-size: 16px;
          color: #243a5c;
          outline: none !important;
          box-shadow: none !important;
        }

        :global(.field-input::placeholder) {
          color: #aab5c5;
        }

        .eye-toggle {
          margin-right: 18px;
          color: #9aa9bd;
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px;
        }

        .eye-toggle:hover {
          color: #0b72e9;
        }

        .captcha-row {
          display: grid;
          grid-template-columns: 1fr 142px 34px;
          gap: 14px;
          align-items: center;
          margin-bottom: 16px;
        }

        .captcha-row .field {
          margin-bottom: 0;
        }

        .captcha {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 56px;
          border: 1px solid #d4e3fa;
          border-radius: 10px;
          overflow: hidden;
          color: #0c63d8;
          font-family: "Courier New", monospace;
          font-size: 32px;
          font-weight: 700;
          letter-spacing: 10px;
          cursor: pointer;
          background:
            linear-gradient(135deg, rgba(242,247,255,0.85), rgba(255,255,255,0.9)),
            repeating-linear-gradient(22deg, transparent 0 8px, rgba(0,92,204,0.11) 9px 10px);
        }

        .captcha::before,
        .captcha::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
        }

        .captcha::before {
          background-image: radial-gradient(rgba(20, 100, 220, 0.22) 1px, transparent 1px);
          background-size: 9px 9px;
          opacity: 0.75;
        }

        .captcha::after {
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(0, 90, 220, 0.32), transparent);
          top: 31px;
          transform: rotate(-6deg);
        }

        .refresh-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 56px;
          color: #72839c;
          background: none;
          border: none;
          cursor: pointer;
        }

        .refresh-btn:hover {
          color: #0b72e9;
        }

        .options {
          display: flex;
          align-items: center;
          margin: 2px 0 20px;
          font-size: 15px;
          color: #3d5271;
        }

        .checkbox-label {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          cursor: pointer;
        }

        :global(.login-btn) {
          width: 100%;
          height: 60px;
          border: none;
          border-radius: 12px;
          color: #fff;
          font-size: 20px;
          letter-spacing: 10px;
          font-weight: 700;
          background: linear-gradient(90deg, #0068e8 0%, #0b7cff 100%);
          box-shadow: 0 16px 32px rgba(0, 102, 230, 0.24);
          cursor: pointer;
          transition: all 0.2s;
        }

        :global(.login-btn:hover) {
          transform: translateY(-1px);
          box-shadow: 0 20px 38px rgba(0, 102, 230, 0.28);
        }

        :global(.login-btn:disabled) {
          opacity: 0.7;
          cursor: not-allowed;
          transform: none;
        }

        .card-bottom {
          display: grid;
          grid-template-columns: 1fr 1px 1fr;
          align-items: center;
          gap: 22px;
          margin-top: 24px;
          padding-top: 22px;
          border-top: 1px solid #e7edf5;
          color: #0b72e9;
          font-size: 15px;
          font-weight: 600;
        }

        .vline {
          width: 1px;
          height: 24px;
          background: #dbe4ef;
        }

        .bottom-link {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 8px;
          text-decoration: none;
          color: #0b72e9;
          transition: opacity 0.2s;
          cursor: pointer;
          background: none;
          border: none;
          font-size: inherit;
          font-weight: inherit;
        }

        .bottom-link:hover {
          opacity: 0.8;
        }

        @media (max-width: 1400px) {
          .layout {
            padding-left: 52px;
            padding-right: 52px;
            grid-template-columns: minmax(640px, 1fr) 560px;
          }
          .login-card {
            width: 560px;
            min-height: 580px;
            padding: 48px 56px 38px;
          }
          .hero-title { font-size: 46px; }
          .hero-visual-wrap { width: 680px; bottom: 70px; }
          :global(.brand-logo) { width: 210px; }
          :global(.card-logo) { width: 180px; }
          .welcome { font-size: 20px; }
        }

        @media (max-height: 820px) {
          .layout { padding-top: 38px; padding-bottom: 32px; }
          .hero-title { margin-top: 0; }
          .hero-visual-wrap { bottom: 40px; width: 620px; }
          .login-card { min-height: auto; padding-top: 38px; padding-bottom: 32px; }
          .field { height: 52px; }
          .captcha, .refresh-btn { height: 52px; }
          :global(.login-btn) { height: 56px; }
          .card-bottom { margin-top: 18px; padding-top: 18px; }
        }
      `}</style>
    </div>
  );
}
