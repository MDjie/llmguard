'use client';

import { useCallback, useEffect, useState, useRef, useId } from 'react';
import { Check, Eye, KeyRound, Loader2, ShieldCheck, ShieldX, TimerReset, X } from 'lucide-react';
import { AuthorizedMediaPreview,type AuthorizedMedia } from './authorized-media';
import {ReviewEvidenceHighlights} from './review-evidence-highlights';
import {z} from 'zod';
import {reviewHighlightSchema} from '@/contracts/http/media-evidence';
import {OriginalPreviewDisplay} from './original-preview-display';
import type {OriginalPreview} from '@/contracts/http/original-preview';
import {contentAccessConsumeResponseSchema} from '@/contracts/http/content-access';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import type { Permission } from '@/lib/api-security';

interface AccessRequest {
  id: string;
  resourceId: string;
  resourceType: string;
  sourceDigest: string;
  requesterId: string;
  purpose: 'INCIDENT_INVESTIGATION' | 'REGULATORY_REVIEW' | 'FALSE_POSITIVE_APPEAL';
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewedBy: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  createdAt: string;
}

interface HighlightView { label: string; parts: { start: number; end: number; text: string; evidenceIds: string[] }[] }

interface CurrentUser {
  id: string;
  permissions: Permission[];
}

const purposeLabels: Record<AccessRequest['purpose'], string> = {
  INCIDENT_INVESTIGATION: '事件调查',
  REGULATORY_REVIEW: '监管审查',
  FALSE_POSITIVE_APPEAL: '误报申诉',
};

async function readJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(String(payload.detail ?? payload.title ?? 'HTTP ' + response.status));
  return payload as T;
}

export function EvidenceAccessPanel({
  incidentId,
  sourceDigest,
  resourceType = 'INCIDENT_EVIDENCE',
  candidate,
}: {
  readonly candidate?: { alertId: string; feedbackId: string };
  readonly incidentId: string;
  readonly sourceDigest?: string;
  readonly resourceType?: 'INCIDENT_EVIDENCE' | 'ARCHIVED_CONTENT' | 'MEDIA_EVIDENCE' | 'MEDIA_ORIGINAL';
}) {
  const accessBase = `${resourceType === 'MEDIA_ORIGINAL' ? '/api/media-originals' : resourceType === 'MEDIA_EVIDENCE' ? '/api/media-evidence' : resourceType === 'ARCHIVED_CONTENT' ? '/api/archived-content' : '/api/incidents'}/${encodeURIComponent(incidentId)}/raw-access`;
  const headingId=useId();
  const activeAccess = useRef(accessBase);
  const consumeController=useRef<AbortController|null>(null);
  const [originalPreview,setOriginalPreview]=useState<OriginalPreview|null>(null);
  const [reviewHighlights,setReviewHighlights]=useState<z.infer<typeof reviewHighlightSchema>[]>([]);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [ownRequests, setOwnRequests] = useState<AccessRequest[]>([]);
  const [pendingRequests, setPendingRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestOpen, setRequestOpen] = useState(false);
  const [purpose, setPurpose] = useState<AccessRequest['purpose']>(candidate ? 'FALSE_POSITIVE_APPEAL' : 'INCIDENT_INVESTIGATION');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<AccessRequest | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [media, setMedia] = useState<AuthorizedMedia | null>(null);
  const [highlightViews, setHighlightViews] = useState<HighlightView[]>([]);
  const [rawEvidence, setRawEvidence] = useState<string | null>(null);
  const [candidateGrant,setCandidateGrant]=useState<AccessRequest|null>(null),[licenseRef,setLicenseRef]=useState(''),[selector,setSelector]=useState('MATCHED_EVIDENCE'),[origin,setOrigin]=useState<'customer'|'synthetic'>('customer');
  const [consumingId, setConsumingId] = useState<string | null>(null);
  const clearEvidence=useCallback(()=>{consumeController.current?.abort();consumeController.current=null;setRawEvidence(null);setHighlightViews([]);setMedia(null);setOriginalPreview(null);setReviewHighlights([]);setConsumingId(null);},[]);
  useEffect(() => { activeAccess.current=accessBase;clearEvidence();return()=>{activeAccess.current='';consumeController.current?.abort();}; }, [accessBase,clearEvidence]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await readJson<{ user: CurrentUser }>(await fetch('/api/auth/me', { cache: 'no-store' }));
      setUser(me.user);
      const tasks: Promise<void>[] = [];
      if (me.user.permissions.includes('content:raw:read')) {
        tasks.push(readJson<{ data: AccessRequest[] }>(
          await fetch(`${accessBase}/requests`, { cache: 'no-store' }),
        ).then((payload) => setOwnRequests(payload.data)));
      }
      if (me.user.permissions.includes('audit:approve')) {
        tasks.push(readJson<{ data: { items: AccessRequest[] } }>(
          await fetch('/api/content-access-requests?status=pending&page=1&pageSize=100', { cache: 'no-store' }),
        ).then((payload) => setPendingRequests(payload.data.items.filter((item) => item.resourceId === incidentId && item.resourceType === resourceType))));
      }
      await Promise.all(tasks);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '原文访问状态加载失败');
    } finally {
      setLoading(false);
    }
  }, [incidentId, accessBase, resourceType]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (rawEvidence === null) return;
    const timer = window.setTimeout(clearEvidence, 60_000);
    return () => window.clearTimeout(timer);
  }, [rawEvidence,clearEvidence]);

  const requestAccess = async () => {
    if (reason.trim().length < 10) return;
    setSubmitting(true);
    try {
      await readJson(await fetch(accessBase, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ purpose, reason: reason.trim() }),
      }));
      setRequestOpen(false);
      setReason('');
      toast.success('原文访问申请已提交，需由另一名授权人员审批');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '原文访问申请失败');
    } finally {
      setSubmitting(false);
    }
  };

  const review = async (action: 'approve' | 'reject') => {
    if (!reviewTarget || reviewReason.trim().length < 5) return;
    setReviewing(true);
    try {
      await readJson(await fetch(`/api/content-access-requests/${reviewTarget.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ action, reason: reviewReason.trim() }),
      }));
      toast.success(action === 'approve' ? '已批准 15 分钟内一次性查看' : '已拒绝访问申请');
      setReviewTarget(null);
      setReviewReason('');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '访问审批失败');
    } finally {
      setReviewing(false);
    }
  };

  const consume = async (request: AccessRequest) => {
    clearEvidence();const controller=new AbortController();consumeController.current=controller;
    setConsumingId(request.id);
    try {
      const payload = contentAccessConsumeResponseSchema.parse(await readJson<unknown>(
        await fetch(`${accessBase}/consume`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...csrfHeaders() },
          body: JSON.stringify({ requestId: request.id }),
          signal:controller.signal,
          cache: 'no-store',
        }),
      ));
      if (activeAccess.current !== accessBase || controller.signal.aborted) return;
      setOriginalPreview(payload.data.originalPreview??null);
      setReviewHighlights(payload.data.reviewHighlights??[]);
      setMedia(payload.data.media ?? null);
      setHighlightViews(payload.data.highlightViews ?? []);
      setRawEvidence(payload.data.answerEvidence);
      await load();
    } catch (error) {
      if(!controller.signal.aborted)toast.error(error instanceof Error ? error.message : '原文查看失败');
    } finally {
      if(consumeController.current===controller){consumeController.current=null;setConsumingId(null);}
    }
  };

  const exportCandidate=async()=>{
    if(!candidate||!candidateGrant||!licenseRef.trim()||resourceType==='INCIDENT_EVIDENCE')return;
    setSubmitting(true);
    try{
      const payload=await readJson<{candidateId:string;workbench:unknown}>(await fetch('/api/security-alerts/'+encodeURIComponent(candidate.alertId)+'/feedback/candidate',{method:'POST',headers:{'content-type':'application/json',...csrfHeaders()},cache:'no-store',body:JSON.stringify({feedbackId:candidate.feedbackId,resourceType,resourceId:incidentId,accessRequestId:candidateGrant.id,selector,licenseRef:licenseRef.trim(),origin})}));
      if(activeAccess.current!==accessBase)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(payload.workbench,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='feedback-candidate-'+payload.candidateId.slice(0,12)+'.json';link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      setCandidateGrant(null);toast.success('已导出脱敏候选包，需独立标注审核后才能用于质量验收');await load();
    }catch(error:unknown){toast.error(error instanceof Error?error.message:'候选导出失败；授权未消费时可修正后重试');}finally{setSubmitting(false);}
  };

  if (loading) {
    return <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />正在加载原文访问控制…</div>;
  }
  const canRequest = user?.permissions.includes('content:raw:read') ?? false;
  const canApprove = user?.permissions.includes('audit:approve') ?? false;
  if (!canRequest && !canApprove) return null;

  return (
    <section className="space-y-3" aria-labelledby={headingId} data-testid={'evidence-access-'+resourceType+'-'+incidentId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={headingId} className="text-sm font-semibold text-gray-900">{resourceType==='MEDIA_ORIGINAL'?'原件独立访问控制':'原文访问控制'}</h3>
          <p className="mt-1 text-xs text-gray-500">双人审批、摘要绑定、15 分钟有效、仅可查看一次</p>
        </div>
        {canRequest && <Button size="sm" variant="outline" onClick={() => setRequestOpen(true)}><KeyRound className="h-4 w-4" />申请查看</Button>}
      </div>
      {sourceDigest && <p className="break-all rounded bg-gray-50 px-3 py-2 font-mono text-[11px] text-gray-500">证据指纹 {resourceType === 'INCIDENT_EVIDENCE' ? 'sha256' : 'HMAC'}:{sourceDigest}</p>}

      {canRequest && ownRequests.length > 0 && (
        <div className="grid gap-2">
          {ownRequests.map((request) => (
            <Card key={request.id} className="shadow-none">
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                <Badge variant="outline">{request.status}</Badge>
                <div className="min-w-0 flex-1 text-xs text-gray-600">
                  <p>{purposeLabels[request.purpose]} · 申请 {new Date(request.createdAt).toLocaleString('zh-CN')}</p>
                  <p className="mt-1 truncate">{request.reason}</p>
                </div>
                {candidate && request.purpose==='FALSE_POSITIVE_APPEAL' && request.status==='approved' && !request.usedAt && <Button size="sm" variant="outline" onClick={()=>setCandidateGrant(request)}>生成评测候选包</Button>}
                {request.status === 'approved' && !request.usedAt && (
                  <Button size="sm" onClick={() => void consume(request)} disabled={consumingId === request.id}>
                    {consumingId === request.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}一次性查看
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {canApprove && pendingRequests.length > 0 && (
        <Alert>
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>待审批访问申请</AlertTitle>
          <AlertDescription className="mt-2 space-y-2">
            {pendingRequests.map((request) => (
              <div key={request.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-white p-2 text-xs">
                <span className="font-medium">{request.requesterId}</span>
                <span>{purposeLabels[request.purpose]}</span>
                <span className="min-w-0 flex-1 truncate text-gray-500">{request.reason}</span>
                <Button size="sm" variant="outline" disabled={request.requesterId === user?.id} onClick={() => setReviewTarget(request)}>审核</Button>
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <Dialog open={candidateGrant!==null} onOpenChange={open=>{if(!open)setCandidateGrant(null);}}>
        <DialogContent><DialogHeader><DialogTitle>生成待审核评测候选</DialogTitle><DialogDescription>此操作消费一次原文授权，下载脱敏文本候选包。请保存到受控的内部评测目录；不自动成为金标或修改线上策略。</DialogDescription></DialogHeader>
          <div className="space-y-3"><Label htmlFor="candidate-license">内部使用授权依据</Label><Input id="candidate-license" maxLength={128} value={licenseRef} onChange={event=>setLicenseRef(event.target.value)} placeholder="填写工单或授权记录编号"/>
          <Label>文本来源</Label><Select value={selector} onValueChange={setSelector}><SelectTrigger aria-label="候选文本来源"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="MATCHED_EVIDENCE">唯一命中片段</SelectItem>{Array.from({length:8},(_,index)=><SelectItem key={index} value={'MATCHED_EVIDENCE/'+index}>第 {index+1} 个命中片段</SelectItem>)}</SelectContent></Select>
          <Label>样本性质</Label><Select value={origin} onValueChange={value=>setOrigin(value==='synthetic'?'synthetic':'customer')}><SelectTrigger aria-label="样本性质"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="customer">客户真实反馈</SelectItem><SelectItem value="synthetic">工程或合成样本</SelectItem></SelectContent></Select>
          <p className="text-xs text-muted-foreground">多片段请按授权回放顺序明确选择。没有已验证的命中片段时，需要通过受控评测接口指定来源；导出失败不消耗授权。</p></div>
          <DialogFooter><Button variant="outline" onClick={()=>setCandidateGrant(null)}>取消</Button><Button disabled={submitting||!licenseRef.trim()} onClick={()=>void exportCandidate()}>消费授权并下载候选</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{resourceType==='MEDIA_ORIGINAL'?'申请查看所选原件或 PDF 页':'申请查看原文证据'}</DialogTitle>
            <DialogDescription>申请人与审批人必须不同。批准后仅在 15 分钟内允许一次查看；必要性说明不得粘贴事件原文或客户隐私。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>用途</Label>
              <Select value={purpose} onValueChange={(value) => setPurpose(value as AccessRequest['purpose'])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(purposeLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="evidence-request-reason">必要性说明（不得粘贴原文）</Label><Textarea id="evidence-request-reason" value={reason} maxLength={500} rows={4} onChange={(event) => setReason(event.target.value)} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setRequestOpen(false)}>取消</Button><Button disabled={submitting || reason.trim().length < 10} onClick={() => void requestAccess()}>{submitting && <Loader2 className="h-4 w-4 animate-spin" />}提交申请</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(reviewTarget)} onOpenChange={(open) => { if (!open) setReviewTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>审核原文访问</DialogTitle><DialogDescription>只确认摘要绑定的当前证据，不会在审批界面展示原文。</DialogDescription></DialogHeader>
          {reviewTarget && <div className="space-y-3 text-sm"><p><span className="text-gray-500">申请人：</span>{reviewTarget.requesterId}</p><p><span className="text-gray-500">用途：</span>{purposeLabels[reviewTarget.purpose]}</p><p className="break-all font-mono text-xs">{resourceType === 'INCIDENT_EVIDENCE' ? 'sha256' : 'HMAC'}:{reviewTarget.sourceDigest}</p><div className="space-y-1.5"><Label htmlFor="evidence-review-reason">审批意见（不得粘贴原文）</Label><Textarea id="evidence-review-reason" rows={3} maxLength={500} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /></div></div>}
          <DialogFooter><Button variant="destructive" disabled={reviewing || reviewReason.trim().length < 5} onClick={() => void review('reject')}><ShieldX className="h-4 w-4" />拒绝</Button><Button disabled={reviewing || reviewReason.trim().length < 5} onClick={() => void review('approve')}>{reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}批准一次查看</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rawEvidence !== null} onOpenChange={(open) => { if (!open) clearEvidence(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><TimerReset className="h-5 w-5 text-amber-600" />临时原文证据</DialogTitle><DialogDescription>该授权已消费；内容将在 60 秒后从当前界面自动清除。请勿复制到日志、工单或非受控系统。</DialogDescription></DialogHeader>
          <ReviewEvidenceHighlights items={reviewHighlights}/>
          {originalPreview && <OriginalPreviewDisplay preview={originalPreview}/>}
          {media && <AuthorizedMediaPreview key={accessBase} media={media}/>}
          {highlightViews.map(view => <section key={view.label} className="max-h-64 overflow-auto rounded border p-3"><p className="mb-2 text-xs text-muted-foreground">命中位置 · {view.label}</p><div className="whitespace-pre-wrap break-words font-mono text-sm">{view.parts.map(part => part.evidenceIds.length ? <mark key={part.start} className="bg-amber-200 text-black" title={'证据 ' + part.evidenceIds.join('、')}>{part.text}</mark> : <span key={part.start}>{part.text}</span>)}</div></section>)}
          <details open={!media && !originalPreview && !highlightViews.length}><summary className="cursor-pointer text-sm text-muted-foreground">查看完整归档内容</summary><Textarea readOnly aria-label="完整归档内容" value={rawEvidence ?? ''} rows={10} className="mt-2 max-h-80 resize-none font-mono text-sm [field-sizing:fixed]" /></details>
          <DialogFooter><Button onClick={clearEvidence}><X className="h-4 w-4" />关闭并清除</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
