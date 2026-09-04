'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Eye, FileText, Loader2, Plus, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { csrfHeaders } from '@/lib/auth/csrf-client';

type TemplateAction = 'WARN' | 'MASK' | 'REWRITE' | 'REQUIRE_REVIEW' | 'SAFE_RESPONSE' | 'BLOCK';
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'retired';

interface ResponseTemplate {
  id: string;
  templateKey: string;
  riskCategory: string;
  action: TemplateAction;
  locale: string;
  industry: string;
  jurisdiction: string;
  businessLine: string;
  legalDisclaimerVersion: string;
  templateScope: 'PLATFORM' | 'TENANT';
  allowedVariables: string[];
  version: number;
  contentHash: string;
  signatureDigest: string;
  approvalStatus: ApprovalStatus;
  createdBy: string;
  approvedBy: string | null;
  enabled: boolean;
  rollbackAvailable: boolean;
  recheckStatus: string;
  createdAt: string;
}

interface PreviewResult {
  passed: boolean;
  renderStatus: 'completed' | 'failed';
  preview?: string;
  reasonCode?: string;
  recheck: { passed: boolean; action: string; riskCategories: string[]; decisionId?: string };
}

const actionLabels: Record<TemplateAction, string> = {
  WARN: '警告', MASK: '脱敏', REWRITE: '改写', REQUIRE_REVIEW: '人工复核', SAFE_RESPONSE: '安全代答', BLOCK: '拒答',
};
const statusLabels: Record<ApprovalStatus, string> = { pending: '待审批', approved: '已审批', rejected: '已拒绝', retired: '已退役' };

async function readJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(String(payload.detail ?? payload.title ?? 'HTTP ' + response.status));
  return payload as T;
}

export default function ResponseTemplatesPage() {
  const [templates, setTemplates] = useState<ResponseTemplate[]>([]);
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [templateKey, setTemplateKey] = useState('tenant.safe-response.custom');
  const [riskCategory, setRiskCategory] = useState('*');
  const [templateAction, setTemplateAction] = useState<TemplateAction>('SAFE_RESPONSE');
  const [locale, setLocale] = useState('zh-CN');
  const [industry, setIndustry] = useState('general');
  const [jurisdiction, setJurisdiction] = useState('global');
  const [businessLine, setBusinessLine] = useState('general');
  const [legalDisclaimerVersion, setLegalDisclaimerVersion] = useState('none');
  const [templateScope, setTemplateScope] = useState<'PLATFORM' | 'TENANT'>('TENANT');
  const [allowedVariables, setAllowedVariables] = useState('requestId,riskType');
  const [templateText, setTemplateText] = useState('抱歉，请求 {{requestId}} 涉及 {{riskType}} 风险，暂时无法继续。');
  const [previewTarget, setPreviewTarget] = useState<ResponseTemplate | null>(null);
  const [previewVariables, setPreviewVariables] = useState('{\n  "requestId": "preview-request",\n  "riskType": "example-risk"\n}');
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ResponseTemplate | null>(null);
  const [reviewAction, setReviewAction] = useState<'approve' | 'rollback' | null>(null);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = status === 'ALL' ? '' : `?approvalStatus=${encodeURIComponent(status)}`;
      const payload = await readJson<{ data: ResponseTemplate[] }>(await fetch('/api/policy-governance/templates' + query, { cache: 'no-store' }));
      setTemplates(payload.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '响应模板加载失败');
    } finally {
      setLoading(false);
    }
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const createDraft = async () => {
    setCreating(true);
    try {
      const variables = allowedVariables.split(',').map((value) => value.trim()).filter(Boolean);
      await readJson(await fetch('/api/policy-governance/templates', {
        method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ templateKey: templateKey.trim(), riskCategory: riskCategory.trim(), action: templateAction, locale: locale.trim(), industry: industry.trim(), jurisdiction: jurisdiction.trim(), businessLine: businessLine.trim(), legalDisclaimerVersion: legalDisclaimerVersion.trim(), templateScope, templateText, allowedVariables: variables }),
      }));
      toast.success('响应模板新版本已创建');
      setCreateOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '响应模板创建失败');
    } finally {
      setCreating(false);
    }
  };

  const runPreview = async () => {
    if (!previewTarget) return;
    setPreviewing(true); setPreview(null);
    try {
      const variables: unknown = JSON.parse(previewVariables);
      const payload = await readJson<{ data: PreviewResult }>(await fetch(`/api/policy-governance/templates/${previewTarget.id}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ variables }),
      }));
      setPreview(payload.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '模板预览失败');
    } finally {
      setPreviewing(false);
    }
  };

  const openReview = (template: ResponseTemplate, next: 'approve' | 'rollback') => {
    setReviewTarget(template); setReviewAction(next); setReason('');
  };
  const submitReview = async () => {
    if (!reviewTarget || !reviewAction || reason.trim().length < 1) return;
    setWorking(true);
    try {
      await readJson(await fetch(`/api/policy-governance/templates/${reviewTarget.id}/${reviewAction}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ reason: reason.trim() }),
      }));
      toast.success(reviewAction === 'approve' ? '模板复检通过，已进入下一次策略包编译候选' : '模板已回滚至上一审批版本，等待下一次策略包编译');
      setReviewTarget(null); setReviewAction(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '模板操作失败');
    } finally {
      setWorking(false);
    }
  };

  const buttons = (template: ResponseTemplate) => <div className="flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => { setPreviewTarget(template); setPreview(null); }}><Eye className="h-3.5 w-3.5" />预览复检</Button>{template.approvalStatus === 'pending' && <Button size="sm" onClick={() => openReview(template, 'approve')}><CheckCircle2 className="h-3.5 w-3.5" />审批</Button>}{template.enabled && template.rollbackAvailable && <Button size="sm" variant="destructive" onClick={() => openReview(template, 'rollback')}><RotateCcw className="h-3.5 w-3.5" />回滚</Button>}</div>;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><FileText className="h-6 w-6 text-blue-600" /><h2 className="text-2xl font-semibold text-gray-900">响应模板治理</h2></div><p className="mt-1 text-sm text-gray-500">按风险、动作、语言和行业管理代答模板；审批前执行真实输出安全复检</p></div><div className="flex gap-2"><Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></Button><Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建版本</Button></div></div>
      <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-5 w-5 text-emerald-600" />模板安全门禁</CardTitle><CardDescription>变量采用显式白名单，禁止原文、凭据、身份和证据变量；创建人与审批人必须不同。</CardDescription></CardHeader><CardContent><Select value={status} onValueChange={setStatus}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部状态</SelectItem>{Object.entries(statusLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></CardContent></Card>

      <div className="grid gap-3 md:hidden">{templates.map((template) => <Card key={template.id}><CardHeader className="pb-2"><div className="flex items-start justify-between gap-2"><div><CardTitle className="text-base">{template.templateKey} · v{template.version}</CardTitle><CardDescription>{template.riskCategory} · {actionLabels[template.action]}</CardDescription></div><Badge variant="outline">{statusLabels[template.approvalStatus]}</Badge></div></CardHeader><CardContent className="space-y-3 text-xs"><p>{template.locale} · {template.industry} · {template.businessLine}</p><div className="flex flex-wrap gap-1">{template.allowedVariables.map((variable) => <Badge key={variable} variant="secondary">{variable}</Badge>)}</div><p className={template.recheckStatus === 'passed_at_approval' ? 'text-emerald-700' : 'text-amber-700'}>{template.recheckStatus}</p>{buttons(template)}</CardContent></Card>)}</div>
      <div className="hidden overflow-x-auto rounded-md border bg-white md:block"><Table><TableHeader><TableRow><TableHead>模板 / 版本</TableHead><TableHead>风险与动作</TableHead><TableHead>语言 / 行业 / 业务</TableHead><TableHead>变量白名单</TableHead><TableHead>审批与复检</TableHead><TableHead>摘要</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{loading ? <TableRow><TableCell colSpan={7} className="h-40 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></TableCell></TableRow> : templates.length === 0 ? <TableRow><TableCell colSpan={7} className="h-40 text-center text-gray-500">暂无响应模板</TableCell></TableRow> : templates.map((template) => <TableRow key={template.id}><TableCell><p className="font-medium">{template.templateKey} · v{template.version}</p><p className="mt-1 text-xs text-gray-500">{template.templateScope} · {template.createdBy}</p></TableCell><TableCell><p>{template.riskCategory}</p><Badge variant="outline" className="mt-1">{actionLabels[template.action]}</Badge></TableCell><TableCell className="text-xs"><p>{template.locale} · {template.industry}</p><p className="mt-1 text-gray-500">{template.jurisdiction} · {template.businessLine}</p></TableCell><TableCell><div className="flex max-w-56 flex-wrap gap-1">{template.allowedVariables.length ? template.allowedVariables.map((variable) => <Badge key={variable} variant="secondary">{variable}</Badge>) : <span className="text-xs text-gray-400">无变量</span>}</div></TableCell><TableCell><Badge variant="outline">{statusLabels[template.approvalStatus]}</Badge><p className={template.recheckStatus === 'passed_at_approval' ? 'mt-1 text-xs text-emerald-700' : 'mt-1 text-xs text-amber-700'}>{template.recheckStatus}</p></TableCell><TableCell><p className="max-w-36 truncate font-mono text-xs" title={template.contentHash}>{template.contentHash}</p><p className="mt-1 max-w-36 truncate font-mono text-[10px] text-gray-400" title={template.signatureDigest}>{template.signatureDigest}</p></TableCell><TableCell>{buttons(template)}</TableCell></TableRow>)}</TableBody></Table></div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>新建响应模板版本</DialogTitle><DialogDescription>模板保存为不可变版本；只有独立审批且输出复检通过后才会进入下一次策略包编译。</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="template-key">模板键</Label><Input id="template-key" value={templateKey} maxLength={128} onChange={(event) => setTemplateKey(event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="risk-category">风险类别</Label><Input id="risk-category" value={riskCategory} maxLength={128} onChange={(event) => setRiskCategory(event.target.value)} /></div><div className="space-y-1.5"><Label>动作</Label><Select value={templateAction} onValueChange={(value) => setTemplateAction(value as TemplateAction)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(actionLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label>作用域</Label><Select value={templateScope} onValueChange={(value) => setTemplateScope(value as 'PLATFORM' | 'TENANT')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="TENANT">租户</SelectItem><SelectItem value="PLATFORM">平台</SelectItem></SelectContent></Select></div>{[['locale','语言',locale,setLocale],['industry','行业',industry,setIndustry],['jurisdiction','司法辖区',jurisdiction,setJurisdiction],['business-line','业务线',businessLine,setBusinessLine],['disclaimer','免责声明版本',legalDisclaimerVersion,setLegalDisclaimerVersion],['allowed-variables','变量白名单（逗号分隔）',allowedVariables,setAllowedVariables]].map(([id,label,value,setter]) => <div key={String(id)} className="space-y-1.5"><Label htmlFor={String(id)}>{String(label)}</Label><Input id={String(id)} value={String(value)} onChange={(event) => (setter as (next: string) => void)(event.target.value)} /></div>)}<div className="space-y-1.5 sm:col-span-2"><Label htmlFor="template-text">模板正文</Label><Textarea id="template-text" rows={7} maxLength={4096} value={templateText} onChange={(event) => setTemplateText(event.target.value)} /></div></div><DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={creating || !templateKey.trim() || !riskCategory.trim() || !templateText.trim()} onClick={() => void createDraft()}>{creating && <Loader2 className="h-4 w-4 animate-spin" />}创建版本</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={Boolean(previewTarget)} onOpenChange={(open) => { if (!open) setPreviewTarget(null); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>模板预览与安全复检</DialogTitle><DialogDescription>{previewTarget ? `${previewTarget.templateKey} · v${previewTarget.version}` : ''}</DialogDescription></DialogHeader><div className="space-y-3"><div className="space-y-1.5"><Label htmlFor="preview-variables">预览变量 JSON</Label><Textarea id="preview-variables" value={previewVariables} rows={6} className="font-mono text-xs" onChange={(event) => setPreviewVariables(event.target.value)} /></div>{preview && <Card className={preview.passed ? 'border-emerald-200' : 'border-red-200'}><CardHeader className="pb-2"><CardTitle className="text-sm">{preview.passed ? '复检通过' : '复检未通过'} · {preview.recheck.action}</CardTitle><CardDescription>{preview.reasonCode ?? (preview.recheck.riskCategories.join('、') || '未命中风险')}</CardDescription></CardHeader>{preview.preview && <CardContent><p className="whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">{preview.preview}</p></CardContent>}</Card>}</div><DialogFooter><Button variant="outline" onClick={() => setPreviewTarget(null)}>关闭</Button><Button disabled={previewing} onClick={() => void runPreview()}>{previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}渲染并复检</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={Boolean(reviewTarget && reviewAction)} onOpenChange={(open) => { if (!open) { setReviewTarget(null); setReviewAction(null); } }}><DialogContent><DialogHeader><DialogTitle>{reviewAction === 'approve' ? '审批模板' : '回滚模板'}</DialogTitle><DialogDescription>{reviewTarget ? `${reviewTarget.templateKey} · v${reviewTarget.version}` : ''}</DialogDescription></DialogHeader><div className="space-y-1.5"><Label htmlFor="template-review-reason">操作理由</Label><Textarea id="template-review-reason" rows={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => { setReviewTarget(null); setReviewAction(null); }}>取消</Button><Button variant={reviewAction === 'rollback' ? 'destructive' : 'default'} disabled={working || !reason.trim()} onClick={() => void submitReview()}>{working && <Loader2 className="h-4 w-4 animate-spin" />}{reviewAction === 'approve' ? '复检并批准' : '确认回滚'}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
