'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Copy,
  Shield,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { csrfHeaders } from '@/lib/auth/csrf-client';

// ============================================
// 类型定义
// ============================================

interface PlainLine {
  lineNumber: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

interface Finding {
  id: string;
  taskId: string;
  chunkIndex: number;
  lineNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
  locationStatus: 'located' | 'not_found';
  dimensionCode: string;
  dimensionName: string;
  ruleName: string;
  ruleType: string;
  score: number;
  severity: string;
  action: string;
  evidence: string[];
  maskedEvidence: string[];
  reason: string;
  suggestion: string;
  status: string;
  ignoreReason: string | null;
  ignoreNote: string | null;
  whitelistMatched?: ({ name?: string } & Record<string, unknown>) | null;
}

interface Task {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  policyId: string;
  status: string;
  statusMessage: string | null;
  errorMessage: string | null;
  extractedText: string | null;
  previewHtml?: string | null;
  plainLines?: PlainLine[];
  parseMeta?: {
    hasTables?: boolean;
    hasImages?: boolean;
    totalLines?: number;
    totalChars?: number;
  };
  parsedChunks: Array<Record<string, unknown>>;
  overallScore: number | null;
  finalAction: string | null;
  findingsCount: number;
  whitelistMatched: Record<string, unknown> | null;
  skippedDimensions: Array<Record<string, unknown>>;
  createdAt: string;
  completedAt: string | null;
}

interface Stats {
  totalFindings: number;
  bySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  byStatus: {
    open: number;
    accepted: number;
    ignored: number;
  };
  byAction: {
    allow: number;
    warn: number;
    mask: number;
    rewrite: number;
    block: number;
  };
  byDimension: Record<string, { count: number; dimensionName: string; maxScore: number }>;
}

// ============================================
// 配置常量
// ============================================

const severityConfig = {
  critical: { label: '严重', color: 'bg-red-500', textColor: 'text-red-600', bgLight: 'bg-red-50' },
  high: { label: '高危', color: 'bg-orange-500', textColor: 'text-orange-600', bgLight: 'bg-orange-50' },
  medium: { label: '中危', color: 'bg-yellow-500', textColor: 'text-yellow-600', bgLight: 'bg-yellow-50' },
  low: { label: '低危', color: 'bg-blue-500', textColor: 'text-blue-600', bgLight: 'bg-blue-50' },
};

const actionConfig = {
  block: { label: '拦截', color: 'bg-red-500', textColor: 'text-red-600' },
  warn: { label: '警告', color: 'bg-yellow-500', textColor: 'text-yellow-600' },
  mask: { label: '脱敏', color: 'bg-purple-500', textColor: 'text-purple-600' },
  rewrite: { label: '改写', color: 'bg-blue-500', textColor: 'text-blue-600' },
  allow: { label: '通过', color: 'bg-green-500', textColor: 'text-green-600' },
};

const ignoreReasons = [
  { value: 'false_positive', label: '误报' },
  { value: 'test_data', label: '测试数据' },
  { value: 'security_education', label: '安全教育内容' },
  { value: 'confirmed_acceptable', label: '已确认可接受' },
  { value: 'other', label: '其他' },
];

// 图片文件类型
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// ============================================
// 高亮处理函数
// ============================================

const severityClassMap: Record<string, string> = {
  critical: 'doc-risk-critical',
  high: 'doc-risk-high',
  medium: 'doc-risk-medium',
  low: 'doc-risk-low',
};

const statusClassMap: Record<string, string> = {
  accepted: 'doc-risk-accepted',
  ignored: 'doc-risk-ignored',
};

// 生成风险提示文本
function getRiskTip(finding: Finding, displayEvidence: string): string {
  const actionLabel =
    actionConfig[finding.action as keyof typeof actionConfig]?.label ||
    finding.action;

  return [
    `问题：${finding.dimensionName}`,
    finding.ruleName ? `规则：${finding.ruleName}` : '',
    displayEvidence ? `证据：${displayEvidence}` : '',
    `风险分：${finding.score}`,
    `动作：${actionLabel}`,
  ]
    .filter(Boolean)
    .join('｜');
}

function getTextNodes(root: HTMLElement, doc: Document): Text[] {
  const nodes: Text[] = [];

  const walker = doc.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const text = node.nodeValue || '';
        const parent = node.parentElement;

        if (!text.trim()) return NodeFilter.FILTER_REJECT;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script,style,mark,.doc-risk-highlight')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }

  return nodes;
}

function insertHighlightIntoTextNode({
  doc,
  node,
  start,
  length,
  finding,
  displayText,
}: {
  doc: Document;
  node: Text;
  start: number;
  length: number;
  finding: Finding;
  displayText: string;
}) {
  const text = node.nodeValue || '';
  const parent = node.parentNode;
  if (!parent) return;

  const beforeText = text.slice(0, start);
  const afterText = text.slice(start + length);

  const before = doc.createTextNode(beforeText);
  const mark = doc.createElement('mark');
  const after = doc.createTextNode(afterText);

  const severityClass =
    severityClassMap[finding.severity] || severityClassMap.medium;
  const statusClass = statusClassMap[finding.status] || '';

  mark.className = [
    'doc-risk-highlight',
    severityClass,
    statusClass,
  ]
    .filter(Boolean)
    .join(' ');

  // 生成并设置风险提示
  const tip = getRiskTip(finding, displayText);
  mark.setAttribute('data-finding-id', finding.id);
  mark.setAttribute('data-risk-tip', tip);
  mark.setAttribute('data-dimension', finding.dimensionName || '');
  mark.setAttribute('data-rule', finding.ruleName || '');

  if (finding.lineNumber) {
    mark.setAttribute('data-line-number', String(finding.lineNumber));
  }

  mark.textContent = displayText;

  parent.insertBefore(before, node);
  parent.insertBefore(mark, node);
  parent.insertBefore(after, node);
  parent.removeChild(node);
}

function dedupeFindingsForHighlight(findings: Finding[]) {
  const map = new Map<string, Finding>();

  for (const finding of findings) {
    for (const evidence of finding.evidence || []) {
      const key = evidence.trim();
      if (!key) continue;

      const existing = map.get(key);

      if (!existing || finding.score > existing.score) {
        map.set(key, finding);
      }
    }
  }

  return Array.from(map.values());
}

function buildHighlightedPreviewHtml(
  previewHtml: string,
  findings: Finding[]
): string {
  if (!previewHtml) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div id="doc-preview-root">${previewHtml}</div>`,
    'text/html'
  );

  const root = doc.getElementById('doc-preview-root');
  if (!root) return previewHtml;

  const sortedFindings = dedupeFindingsForHighlight(findings)
    .filter((finding) => finding.status !== 'ignored')
    .sort((a, b) => {
      const aEvidence = a.evidence?.[0]?.length || 0;
      const bEvidence = b.evidence?.[0]?.length || 0;
      return bEvidence - aEvidence;
    });

  for (const finding of sortedFindings) {
    const rawEvidences = finding.evidence || [];
    const maskedEvidences = finding.maskedEvidence || [];

    for (let i = 0; i < rawEvidences.length; i++) {
      const rawEvidence = rawEvidences[i];
      const displayEvidence = maskedEvidences[i] || rawEvidence;

      if (!rawEvidence || rawEvidence.trim().length === 0) continue;

      const textNodes = getTextNodes(root, doc);
      let highlighted = false;

      for (const node of textNodes) {
        const text = node.nodeValue || '';
        const index = text
          .toLowerCase()
          .indexOf(rawEvidence.toLowerCase());

        if (index >= 0) {
          insertHighlightIntoTextNode({
            doc,
            node,
            start: index,
            length: rawEvidence.length,
            finding,
            displayText: displayEvidence,
          });

          highlighted = true;
          break;
        }
      }

      if (!highlighted) {
        // 兜底：如果原始 evidence 查不到，再尝试 maskedEvidence
        if (!displayEvidence || displayEvidence === rawEvidence) continue;

        const textNodesFallback = getTextNodes(root, doc);

        for (const node of textNodesFallback) {
          const text = node.nodeValue || '';
          const index = text
            .toLowerCase()
            .indexOf(displayEvidence.toLowerCase());

          if (index >= 0) {
            insertHighlightIntoTextNode({
              doc,
              node,
              start: index,
              length: displayEvidence.length,
              finding,
              displayText: displayEvidence,
            });

            break;
          }
        }
      }
    }
  }

  return root.innerHTML;
}

// ============================================
// 主组件
// ============================================

export default function DocumentScanDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const [task, setTask] = useState<Task | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);

  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [riskTooltip, setRiskTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    content: string;
    findingId?: string;
  }>({
    visible: false,
    x: 0,
    y: 0,
    content: '',
  });
  const [dimensionFilter, setDimensionFilter] = useState<string>('all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [ignoreDialogOpen, setIgnoreDialogOpen] = useState(false);
  const [findingToIgnore, setFindingToIgnore] = useState<Finding | null>(null);
  const [ignoreReason, setIgnoreReason] = useState<string>('');
  const [ignoreNote, setIgnoreNote] = useState<string>('');
  const [processingFindingId, setProcessingFindingId] = useState<string | null>(null);

  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [selectedFindingForDetail, setSelectedFindingForDetail] = useState<Finding | null>(null);

  const previewRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const documentContainerRef = useRef<HTMLDivElement>(null);

  // ============================================
  // 数据加载
  // ============================================

  const loadTaskDetail = async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      const response = await fetch(`/api/document-scan/${taskId}`);
      const data = await response.json();
      if (data.success) {
        setTask(data.data.task);
        setFindings(data.data.findings);
        setStats(data.data.stats);
      } else {
        toast.error('加载任务详情失败', { description: data.error });
      }
    } catch (error) {
      console.error('加载任务详情失败:', error);
      toast.error('加载任务详情失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTaskDetail();
  }, [taskId]);

  // 生成带高亮的预览 HTML
  const highlightedPreviewHtml = useMemo(() => {
    return buildHighlightedPreviewHtml(task?.previewHtml || '', findings);
  }, [task?.previewHtml, findings]);

  // findingId -> Finding 映射，用于 tooltip 内容生成
  const findingMap = useMemo(() => {
    const map = new Map<string, Finding>();
    for (const finding of findings) {
      map.set(finding.id, finding);
    }
    return map;
  }, [findings]);

  // 事件代理：监听左侧高亮 mark 的鼠标事件
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;

    const getRiskMark = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return null;
      return target.closest('.doc-risk-highlight') as HTMLElement | null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      const mark = getRiskMark(event.target);

      if (!mark) {
        setRiskTooltip((prev) =>
          prev.visible ? { ...prev, visible: false } : prev
        );
        return;
      }

      const findingId = mark.dataset.findingId;
      const finding = findingId ? findingMap.get(findingId) : undefined;

      const content =
        mark.dataset.riskTip ||
        (finding
          ? getRiskTip(finding, mark.textContent || '')
          : '当前内容命中文档安全检测规则');

      const offset = 14;
      const tooltipWidth = 320;
      const tooltipHeight = 120;

      let x = event.clientX + offset;
      let y = event.clientY + offset;

      if (x + tooltipWidth > window.innerWidth - 12) {
        x = event.clientX - tooltipWidth - offset;
      }

      if (y + tooltipHeight > window.innerHeight - 12) {
        y = event.clientY - tooltipHeight - offset;
      }

      setRiskTooltip({
        visible: true,
        x,
        y,
        content,
        findingId,
      });
    };

    const handleMouseLeave = () => {
      setRiskTooltip((prev) => ({
        ...prev,
        visible: false,
      }));
    };

    const handleClick = (event: MouseEvent) => {
      const mark = getRiskMark(event.target);
      if (!mark) return;

      const findingId = mark.dataset.findingId;
      if (!findingId) return;

      setSelectedFindingId(findingId);

      // 高亮选中的 mark
      root.querySelectorAll('.doc-risk-selected').forEach((el) => {
        el.classList.remove('doc-risk-selected');
      });
      mark.classList.add('doc-risk-selected');
      setTimeout(() => {
        mark.classList.remove('doc-risk-selected');
      }, 2000);

      // 滚动右侧卡片
      const card = document.querySelector(
        `[data-finding-card-id="${findingId}"]`
      );

      card?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    };

    root.addEventListener('mousemove', handleMouseMove);
    root.addEventListener('mouseleave', handleMouseLeave);
    root.addEventListener('click', handleClick);

    return () => {
      root.removeEventListener('mousemove', handleMouseMove);
      root.removeEventListener('mouseleave', handleMouseLeave);
      root.removeEventListener('click', handleClick);
    };
  }, [highlightedPreviewHtml, findingMap]);

  // ============================================
  // 滚动与高亮
  // ============================================

  const scrollToLine = useCallback((lineNumber: number) => {
    const el = lineRefs.current[lineNumber];
    if (el) {
      el.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2');
      setTimeout(() => {
        el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2');
      }, 2000);
    }
  }, []);

  const handleFindingClick = useCallback((finding: Finding) => {
    setSelectedFindingId(finding.id);
    
    // 在格式预览中查找高亮元素
    if (previewRef.current) {
      const highlightEl = previewRef.current.querySelector(
        `[data-finding-id="${finding.id}"]`
      );
      
      if (highlightEl) {
        // 滚动到高亮元素
        highlightEl.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
        
        // 添加选中效果
        highlightEl.classList.add('doc-risk-selected');
        setTimeout(() => {
          highlightEl.classList.remove('doc-risk-selected');
        }, 2000);
        
        return;
      }
    }
    
    // 如果找不到高亮元素
    if (finding.locationStatus === 'not_found' || !finding.lineNumber) {
      toast.warning('该风险未定位到格式预览中的具体位置');
    } else {
      toast.warning('该风险未定位到格式预览中的具体位置');
    }
  }, []);

  // ============================================
  // 风险处理
  // ============================================

  const handleIgnoreFinding = async () => {
    if (!findingToIgnore || !ignoreReason) return;

    setProcessingFindingId(findingToIgnore.id);
    try {
      const response = await fetch(
        `/api/document-scan/${taskId}/findings/${findingToIgnore.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
          body: JSON.stringify({
            status: 'ignored',
            ignoreReason,
            ignoreNote,
          }),
        }
      );

      const data = await response.json();
      if (data.success) {
        setFindings(prev => prev.map(f => 
          f.id === findingToIgnore.id 
            ? { ...f, status: 'ignored', ignoreReason, ignoreNote }
            : f
        ));
        toast.success('已忽略该风险');
        setIgnoreDialogOpen(false);
        setFindingToIgnore(null);
        setIgnoreReason('');
        setIgnoreNote('');
      } else {
        toast.error('忽略失败', { description: data.error });
      }
    } catch (error) {
      console.error('忽略风险失败:', error);
      toast.error('忽略失败');
    } finally {
      setProcessingFindingId(null);
    }
  };

  const handleAcceptFinding = async (finding: Finding) => {
    setProcessingFindingId(finding.id);
    try {
      const response = await fetch(
        `/api/document-scan/${taskId}/findings/${finding.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
          body: JSON.stringify({ status: 'accepted' }),
        }
      );

      const data = await response.json();
      if (data.success) {
        setFindings(prev => prev.map(f => 
          f.id === finding.id 
            ? { ...f, status: 'accepted' }
            : f
        ));
        toast.success('已接受该风险');
      } else {
        toast.error('接受失败', { description: data.error });
      }
    } catch (error) {
      console.error('接受风险失败:', error);
      toast.error('接受失败');
    } finally {
      setProcessingFindingId(null);
    }
  };

  // ============================================
  // 重新检测
  // ============================================

  const handleRescan = async () => {
    setRescanning(true);
    try {
      toast.info('正在重新检测...');
      const response = await fetch(`/api/document-scan/${taskId}/rescan`, {
        method: 'POST',
        headers: { ...csrfHeaders() },
      });
      const data = await response.json();
      if (data.success) {
        toast.success('重新检测完成');
        await loadTaskDetail(false);
      } else {
        toast.error('重新检测失败', { description: data.error });
      }
    } catch (error) {
      console.error('重新检测失败:', error);
      toast.error('重新检测失败');
    } finally {
      setRescanning(false);
    }
  };

  // ============================================
  // 导出与复制
  // ============================================

  const handleCopyText = () => {
    if (task?.extractedText) {
      navigator.clipboard.writeText(task.extractedText);
      toast.success('已复制到剪贴板');
    }
  };

  const handleExportReport = () => {
    if (!task || !stats) return;
    
    const report = {
      task: {
        id: task.id,
        fileName: task.fileName,
        fileType: task.fileType,
        fileSize: task.fileSize,
        overallScore: task.overallScore,
        finalAction: task.finalAction,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
      },
      stats,
      findings: findings.map(f => ({
        dimension: f.dimensionName,
        rule: f.ruleName,
        severity: f.severity,
        score: f.score,
        action: f.action,
        lineNumber: f.lineNumber,
        locationStatus: f.locationStatus,
        reason: f.reason,
        evidence: f.maskedEvidence,
        status: f.status,
      })),
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report_${task.fileName}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('报告已导出');
  };

  // ============================================
  // 筛选与计算
  // ============================================

  const filteredFindings = useMemo(() => {
    return findings.filter((finding) => {
      if (dimensionFilter !== 'all' && finding.dimensionCode !== dimensionFilter) return false;
      if (actionFilter !== 'all' && finding.action !== actionFilter) return false;
      if (statusFilter !== 'all' && finding.status !== statusFilter) return false;
      return true;
    });
  }, [findings, dimensionFilter, actionFilter, statusFilter]);

  // 文档行数据
  const documentLines = useMemo(() => {
    if (task?.plainLines && task.plainLines.length > 0) {
      return task.plainLines;
    }
    if (task?.extractedText) {
      return task.extractedText.split('\n').map((text, index) => ({
        lineNumber: index + 1,
        text,
        startOffset: 0,
        endOffset: text.length,
      }));
    }
    return [];
  }, [task]);

  // 按行号分组的风险
  const findingsByLine = useMemo(() => {
    const result: Record<number, Finding[]> = {};
    for (const finding of findings) {
      if (finding.lineNumber) {
        if (!result[finding.lineNumber]) {
          result[finding.lineNumber] = [];
        }
        result[finding.lineNumber].push(finding);
      }
    }
    return result;
  }, [findings]);

  // 高亮证据文本
  const highlightEvidence = useCallback((lineText: string, lineFindings: Finding[]): string => {
    let result = escapeHtml(lineText);
    
    // 收集所有需要高亮的证据
    const highlights: { start: number; end: number; finding: Finding }[] = [];
    
    for (const finding of lineFindings) {
      // 优先使用原始证据进行定位
      const evidences = finding.evidence?.length > 0 ? finding.evidence : finding.maskedEvidence;
      if (!evidences) continue;
      
      for (const evidence of evidences) {
        if (!evidence) continue;
        // 尝试在行中查找证据
        const index = result.toLowerCase().indexOf(evidence.toLowerCase());
        if (index >= 0) {
          highlights.push({
            start: index,
            end: index + evidence.length,
            finding,
          });
        }
      }
    }
    
    // 按位置排序
    highlights.sort((a, b) => a.start - b.start);
    
    // 从后向前替换，避免位置偏移
    for (let i = highlights.length - 1; i >= 0; i--) {
      const h = highlights[i];
      const before = result.substring(0, h.start);
      const match = result.substring(h.start, h.end);
      const after = result.substring(h.end);
      result = `${before}<mark class="bg-red-200 text-red-900 px-0.5 rounded">${match}</mark>${after}`;
    }
    
    return result;
  }, []);

  // ============================================
  // 工具函数
  // ============================================

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const isImageFile = useMemo(() => {
    if (!task) return false;
    return IMAGE_EXTENSIONS.includes(task.fileType.toLowerCase());
  }, [task]);

  const hasFormattedPreview = useMemo(() => {
    return task?.previewHtml && task.previewHtml.length > 0;
  }, [task]);

  // ============================================
  // 渲染
  // ============================================

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">加载中...</p>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <XCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
          <p className="text-lg font-medium">任务不存在</p>
          <Button variant="outline" className="mt-4" onClick={() => router.push('/document-scan')}>
            返回列表
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* 顶部操作栏 */}
      <header className="h-16 border-b bg-background px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.push('/document-scan')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回
          </Button>
          <div className="flex items-center gap-3">
            <div className={cn(
              'w-10 h-10 rounded-lg flex items-center justify-center',
              isImageFile ? 'bg-green-100' : 'bg-primary/10'
            )}>
              {isImageFile ? (
                <ImageIcon className="w-5 h-5 text-green-600" />
              ) : (
                <FileText className="w-5 h-5 text-primary" />
              )}
            </div>
            <div>
              <h1 className="text-lg font-semibold">{task.fileName}</h1>
              <p className="text-sm text-muted-foreground">
                {task.fileType.toUpperCase()} · {formatFileSize(task.fileSize)}
                {task.parseMeta?.hasTables && ' · 包含表格'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {task.status === 'completed' && (
            <>
              <Badge
                variant="outline"
                className={cn(
                  task.finalAction === 'block' && 'border-red-500 text-red-600',
                  task.finalAction === 'warn' && 'border-yellow-500 text-yellow-600',
                  task.finalAction === 'mask' && 'border-purple-500 text-purple-600',
                  task.finalAction === 'rewrite' && 'border-blue-500 text-blue-600',
                  task.finalAction === 'allow' && 'border-green-500 text-green-600'
                )}
              >
                {actionConfig[task.finalAction as keyof typeof actionConfig]?.label || task.finalAction}
              </Badge>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleRescan}
                disabled={rescanning}
              >
                {rescanning ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4 mr-2" />
                )}
                重新检测
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportReport}>
                <Download className="w-4 h-4 mr-2" />
                导出报告
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopyText}>
                <Copy className="w-4 h-4 mr-2" />
                复制文本
              </Button>
            </>
          )}
          {task.status === 'failed' && (
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleRescan}
              disabled={rescanning}
            >
              {rescanning ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              重新检测
            </Button>
          )}
        </div>
      </header>

      {/* 主体区域 */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4 p-4 overflow-hidden">
        {/* 左侧：文档原文预览区 */}
        <section className="min-h-0 overflow-hidden rounded-xl border bg-white flex flex-col">
          <div className="h-12 border-b px-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <h2 className="font-medium">文档内容</h2>
              <Badge variant="secondary" className="text-xs">
                格式化预览 · 已高亮风险证据
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              {documentLines.length} 行
              {task.extractedText && ` · ${task.extractedText.length} 字符`}
            </div>
          </div>

          <div
            ref={documentContainerRef}
            className="flex-1 overflow-y-auto"
          >
            {/* 格式预览模式 - 统一使用 */}
            <div 
              ref={previewRef}
              className="p-6 prose prose-sm max-w-none document-preview
                [&_table]:w-full [&_table]:border-collapse 
                [&_td]:border [&_td]:px-3 [&_td]:py-2 
                [&_th]:border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-muted
                [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-4
                [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mb-3
                [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mb-2
                [&_p]:mb-2 [&_p]:leading-relaxed
                [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6
                [&_strong]:font-semibold
                [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-x-auto"
              dangerouslySetInnerHTML={{
                __html: highlightedPreviewHtml || task.previewHtml || '',
              }}
            />
          </div>
        </section>

        {/* 右侧：分析结果面板 */}
        <aside className="min-h-0 overflow-hidden rounded-xl border bg-white flex flex-col">
          {/* 筛选区 */}
          <div className="p-4 border-b space-y-3 shrink-0">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">分析结果</h2>
              <span className="text-sm text-muted-foreground">
                {filteredFindings.length} / {findings.length} 条
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Select value={dimensionFilter} onValueChange={setDimensionFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="全部维度" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部维度</SelectItem>
                  {stats && Object.keys(stats.byDimension).map((code) => (
                    <SelectItem key={code} value={code}>
                      {stats.byDimension[code].dimensionName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="全部动作" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部动作</SelectItem>
                  <SelectItem value="allow">通过</SelectItem>
                  <SelectItem value="warn">警告</SelectItem>
                  <SelectItem value="mask">脱敏</SelectItem>
                  <SelectItem value="rewrite">改写</SelectItem>
                  <SelectItem value="block">拦截</SelectItem>
                </SelectContent>
              </Select>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="open">待处理</SelectItem>
                  <SelectItem value="accepted">已接受</SelectItem>
                  <SelectItem value="ignored">已忽略</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 统计摘要区 */}
          {stats && (
            <div className="grid grid-cols-2 gap-2 p-4 border-b shrink-0">
              <div className="rounded-lg bg-muted p-3">
                <div className="text-xs text-muted-foreground">总风险分</div>
                <div
                  className={cn(
                    'text-xl font-bold',
                    (task.overallScore || 0) >= 70 ? 'text-red-600' :
                    (task.overallScore || 0) >= 50 ? 'text-yellow-600' : 'text-green-600'
                  )}
                >
                  {task.overallScore || 0}
                </div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-xs text-muted-foreground">最终动作</div>
                <div
                  className={cn(
                    'text-xl font-bold',
                    task.finalAction === 'block' ? 'text-red-600' :
                    task.finalAction === 'warn' ? 'text-yellow-600' :
                    task.finalAction === 'mask' ? 'text-purple-600' :
                    task.finalAction === 'rewrite' ? 'text-blue-600' : 'text-green-600'
                  )}
                >
                  {actionConfig[task.finalAction as keyof typeof actionConfig]?.label || task.finalAction}
                </div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-xs text-muted-foreground">问题数量</div>
                <div className="text-xl font-bold">{stats.totalFindings}</div>
              </div>
              <div className="rounded-lg bg-muted p-3">
                <div className="text-xs text-muted-foreground">命中维度</div>
                <div className="text-xl font-bold">
                  {Object.keys(stats.byDimension).length}
                </div>
              </div>
            </div>
          )}

          {/* 风险卡片列表 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filteredFindings.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {findings.length === 0 ? (
                  <>
                    <CheckCircle className="w-12 h-12 mx-auto mb-2 text-green-500" />
                    <p className="font-medium">未发现明显风险</p>
                    <p className="text-sm mt-1">当前文档未命中已启用的检测维度和规则</p>
                  </>
                ) : (
                  <>
                    <EyeOff className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>没有符合筛选条件的结果</p>
                  </>
                )}
              </div>
            ) : (
              filteredFindings.map((finding) => {
                const severityInfo = severityConfig[finding.severity as keyof typeof severityConfig] || severityConfig.medium;
                const actionInfo = actionConfig[finding.action as keyof typeof actionConfig] || actionConfig.warn;
                const isProcessing = processingFindingId === finding.id;

                return (
                  <div
                    key={finding.id}
                    data-finding-card-id={finding.id}
                    className={cn(
                      'rounded-lg border bg-card shadow-sm cursor-pointer transition hover:bg-muted/30',
                      selectedFindingId === finding.id && 'border-primary/50 bg-primary/5 ring-1 ring-primary/30',
                      finding.status === 'ignored' && 'opacity-60'
                    )}
                    onClick={() => handleFindingClick(finding)}
                  >
                    <div className="flex gap-3 p-4">
                      {/* 颜色条 */}
                      <div className={cn('w-1 rounded-full shrink-0', severityInfo.color)} />

                      <div className="flex-1 space-y-2">
                        {/* 标题行 */}
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className={cn('font-semibold', severityInfo.textColor)}>
                              {finding.dimensionName}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {finding.reason}
                            </div>
                          </div>
                          <Badge 
                            variant="outline" 
                            className={cn(
                              'shrink-0',
                              finding.locationStatus === 'not_found' && 'text-muted-foreground'
                            )}
                          >
                            {finding.lineNumber ? `行 ${finding.lineNumber}` : '位置未定位'}
                          </Badge>
                        </div>

                        {/* 详情 */}
                        <div className="text-sm space-y-1">
                          {finding.ruleName && (
                            <div>
                              <span className="text-muted-foreground">规则：</span>
                              {finding.ruleName}
                            </div>
                          )}
                          <div>
                            <span className="text-muted-foreground">风险分：</span>
                            <span className={severityInfo.textColor}>{finding.score}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">动作：</span>
                            <span className={actionInfo.textColor}>{actionInfo.label}</span>
                          </div>
                        </div>

                        {/* 证据 */}
                        {finding.maskedEvidence?.length > 0 && (
                          <div className="rounded bg-muted p-2 text-sm">
                            <span className="text-muted-foreground">证据：</span>
                            {finding.maskedEvidence.join('、')}
                          </div>
                        )}

                        {/* 建议 */}
                        {finding.suggestion && (
                          <div className="text-sm text-blue-600">
                            💡 {finding.suggestion}
                          </div>
                        )}

                        {/* 操作按钮 */}
                        {finding.status === 'open' && (
                          <div className="flex gap-2 pt-2">
                            <Button
                              size="sm"
                              variant="default"
                              disabled={isProcessing}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAcceptFinding(finding);
                              }}
                            >
                              {isProcessing && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                              接受
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={isProcessing}
                              onClick={(e) => {
                                e.stopPropagation();
                                setFindingToIgnore(finding);
                                setIgnoreDialogOpen(true);
                              }}
                            >
                              忽略
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedFindingForDetail(finding);
                                setDetailDialogOpen(true);
                              }}
                            >
                              详情
                            </Button>
                          </div>
                        )}

                        {/* 已处理状态 */}
                        {finding.status !== 'open' && (
                          <div className="text-sm text-muted-foreground pt-2">
                            {finding.status === 'accepted' && '✓ 已接受'}
                            {finding.status === 'ignored' && (
                              <>✕ 已忽略 ({ignoreReasons.find(r => r.value === finding.ignoreReason)?.label})</>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </main>

      {/* 忽略弹窗 */}
      <Dialog open={ignoreDialogOpen} onOpenChange={setIgnoreDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>忽略风险</DialogTitle>
            <DialogDescription>
              请选择忽略此风险的原因
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>忽略原因</Label>
              <Select value={ignoreReason} onValueChange={setIgnoreReason}>
                <SelectTrigger>
                  <SelectValue placeholder="选择原因" />
                </SelectTrigger>
                <SelectContent>
                  {ignoreReasons.map((reason) => (
                    <SelectItem key={reason.value} value={reason.value}>
                      {reason.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>备注（可选）</Label>
              <Textarea
                value={ignoreNote}
                onChange={(e) => setIgnoreNote(e.target.value)}
                placeholder="输入备注信息..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIgnoreDialogOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleIgnoreFinding}
              disabled={!ignoreReason || processingFindingId === findingToIgnore?.id}
            >
              确认忽略
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 详情弹窗 */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>风险详情</DialogTitle>
          </DialogHeader>

          {selectedFindingForDetail && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">风险维度：</span>
                  <span className="font-medium">{selectedFindingForDetail.dimensionName}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">风险分：</span>
                  <span className="font-medium">{selectedFindingForDetail.score}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">命中规则：</span>
                  <span className="font-medium">{selectedFindingForDetail.ruleName || '-'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">规则类型：</span>
                  <span className="font-medium">{selectedFindingForDetail.ruleType || '-'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">严重程度：</span>
                  <Badge variant="outline">
                    {severityConfig[selectedFindingForDetail.severity as keyof typeof severityConfig]?.label}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">处理动作：</span>
                  <Badge variant="outline">
                    {actionConfig[selectedFindingForDetail.action as keyof typeof actionConfig]?.label}
                  </Badge>
                </div>
              </div>

              <div className="text-sm">
                <span className="text-muted-foreground">位置：</span>
                {selectedFindingForDetail.lineNumber ? (
                  <span>第 {selectedFindingForDetail.chunkIndex + 1} 段 / 第 {selectedFindingForDetail.lineNumber} 行</span>
                ) : (
                  <span className="text-muted-foreground">位置未定位</span>
                )}
              </div>

              <div className="text-sm">
                <div className="text-muted-foreground mb-1">命中证据：</div>
                <div className="bg-muted rounded p-2 font-mono text-xs">
                  {selectedFindingForDetail.maskedEvidence?.join('\n') || '-'}
                </div>
              </div>

              <div className="text-sm">
                <div className="text-muted-foreground mb-1">原因：</div>
                <div>{selectedFindingForDetail.reason}</div>
              </div>

              {selectedFindingForDetail.suggestion && (
                <div className="text-sm">
                  <div className="text-muted-foreground mb-1">建议：</div>
                  <div className="text-blue-600">{selectedFindingForDetail.suggestion}</div>
                </div>
              )}

              {selectedFindingForDetail.whitelistMatched && (
                <div className="text-sm bg-purple-50 rounded p-3">
                  <div className="font-medium text-purple-600 mb-1">命中白名单</div>
                  <div>白名单名称：{selectedFindingForDetail.whitelistMatched.name}</div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailDialogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fixed 风险提示浮层 */}
      {riskTooltip.visible && (
        <div
          className="fixed z-[9999] max-w-xs rounded-lg bg-slate-900 px-3 py-2 text-xs leading-relaxed text-white shadow-xl pointer-events-none whitespace-pre-line"
          style={{
            left: riskTooltip.x,
            top: riskTooltip.y,
          }}
        >
          {riskTooltip.content.split('｜').map((line, index) => (
            <div
              key={index}
              className={index === 0 ? 'font-semibold mb-1' : ''}
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// HTML 转义函数
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
