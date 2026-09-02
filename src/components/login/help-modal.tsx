'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { HelpCircle, BookOpen, Download } from 'lucide-react';

interface HelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpModal({ open, onOpenChange }: HelpModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-amber-100">
              <HelpCircle className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <DialogTitle>帮助中心</DialogTitle>
              <DialogDescription>
                快速了解国舜大模型安全护栏检测平台的登录、检测、策略和报告能力。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="p-4 rounded-lg border bg-gray-50/50">
            <p className="text-xs text-gray-500 mb-2">平台能力</p>
            <ul className="text-sm text-gray-700 space-y-1">
              <li>• 输入 / 输出内容安全检测</li>
              <li>• 提示词注入、越狱、敏感信息泄露识别</li>
              <li>• 策略化拦截、告警、脱敏与报告导出</li>
            </ul>
          </div>

          <div className="p-4 rounded-lg border bg-gray-50/50">
            <p className="text-xs text-gray-500 mb-2">登录说明</p>
            <ul className="text-sm text-gray-700 space-y-1">
              <li>• 请输入已开通的账号和密码</li>
              <li>• 验证码不区分大小写</li>
              <li>• 忘记密码请联系管理员重置</li>
            </ul>
          </div>

          <div className="col-span-2 p-4 rounded-lg border bg-gray-50/50">
            <p className="text-xs text-gray-500 mb-2">常见问题</p>

            <div className="space-y-4 mt-3">
              <div>
                <p className="text-sm font-medium text-gray-900">无法登录怎么办？</p>
                <p className="text-sm text-gray-600 mt-1">
                  请先确认账号是否已开通、密码是否正确、验证码是否过期。仍无法登录时，请联系管理员检查账号状态和权限范围。
                </p>
              </div>

              <div>
                <p className="text-sm font-medium text-gray-900">检测结果为什么会被拦截？</p>
                <p className="text-sm text-gray-600 mt-1">
                  平台会根据当前策略、检测维度、规则命中情况和阈值配置综合判定。命中高危规则或超过拦截阈值时会触发拦截。
                </p>
              </div>

              <div>
                <p className="text-sm font-medium text-gray-900">如何调整检测规则？</p>
                <p className="text-sm text-gray-600 mt-1">
                  登录后进入&quot;检测维度&quot;、&quot;策略配置&quot;、&quot;白名单规则&quot;等页面，根据业务场景调整规则、阈值和处理动作。
                </p>
              </div>
            </div>

            <div className="flex gap-3 mt-4">
              <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
                <BookOpen className="h-4 w-4" />
                查看使用手册
              </button>
              <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border rounded-lg hover:bg-gray-50 transition-colors">
                <Download className="h-4 w-4" />
                下载操作指引
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
