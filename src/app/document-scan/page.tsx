'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Upload,
  FileText,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Shield,
  ArrowRight,
  Loader2,
  Trash2,
  Info,
  Eye,
  RefreshCw,
  Image as ImageIcon,
  FileWarning,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { csrfHeaders } from '@/lib/auth/csrf-client';

// ============================================
// 类型定义
// ============================================

interface Policy {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
}

interface OcrModel {
  id: string;
  name: string;
  description: string;
  supportedInputs: string[];
  recommended: boolean;
}

interface DocumentTask {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  policyId: string;
  status: 'pending' | 'parsing' | 'detecting' | 'completed' | 'failed';
  statusMessage: string | null;
  errorMessage: string | null;
  overallScore: number | null;
  finalAction: string | null;
  findingsCount: number;
  createdAt: string;
  completedAt: string | null;
}

// ============================================
// 配置常量
// ============================================

const statusConfig = {
  pending: { label: '等待处理', color: 'bg-gray-100 text-gray-600', icon: Clock },
  parsing: { label: '解析中', color: 'bg-blue-100 text-blue-600', icon: Loader2 },
  detecting: { label: '检测中', color: 'bg-purple-100 text-purple-600', icon: Shield },
  completed: { label: '已完成', color: 'bg-green-100 text-green-600', icon: CheckCircle },
  failed: { label: '失败', color: 'bg-red-100 text-red-600', icon: XCircle },
};

const actionConfig = {
  allow: { label: '通过', color: 'bg-green-500' },
  warn: { label: '警告', color: 'bg-yellow-500' },
  mask: { label: '脱敏', color: 'bg-purple-500' },
  rewrite: { label: '改写', color: 'bg-blue-500' },
  block: { label: '拦截', color: 'bg-red-500' },
};

// 图片文件类型
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
// 文本文件类型（不需要 OCR）
const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'csv', 'xml'];
// 文档类型（可选 OCR）
const DOCUMENT_EXTENSIONS = ['pdf', 'docx'];

// 支持的所有文件类型
const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS];

// ============================================
// 主组件
// ============================================

export default function DocumentScanPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tasks, setTasks] = useState<DocumentTask[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [ocrModels, setOcrModels] = useState<OcrModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);
  const [selectedPolicyId, setSelectedPolicyId] = useState<string>('');
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [selectedOcrModel, setSelectedOcrModel] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const tasksRef = useRef<DocumentTask[]>([]);

  // ============================================
  // 计算属性
  // ============================================

  // 当前选择文件的类型
  const fileCategory = useMemo(() => {
    if (!selectedFile) return null;
    const ext = selectedFile.name.split('.').pop()?.toLowerCase() || '';
    if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
    if (TEXT_EXTENSIONS.includes(ext)) return 'text';
    if (DOCUMENT_EXTENSIONS.includes(ext)) return 'document';
    return 'unknown';
  }, [selectedFile]);

  // 图片文件必须使用 OCR
  const isImageFile = fileCategory === 'image';
  
  // 文本文件不需要 OCR
  const isTextFile = fileCategory === 'text';

  // 是否有可用的 OCR 模型
  const hasOcrModels = ocrModels.length > 0;

  // 开始检测按钮是否可用
  const canStartDetection = useMemo(() => {
    if (!selectedFile) return { enabled: false, reason: '请先选择文件' };
    if (!selectedPolicyId) return { enabled: false, reason: '请先选择检测策略' };
    if (uploading) return { enabled: false, reason: '正在处理中' };
    
    // 图片文件必须选择 OCR 模型
    if (isImageFile) {
      if (!hasOcrModels) {
        return { enabled: false, reason: '图片文件需要 OCR 模型，请先配置模型供应商' };
      }
      if (!selectedOcrModel) {
        return { enabled: false, reason: '图片文件必须选择 OCR 模型' };
      }
    }
    
    // 手动启用 OCR 时必须选择模型
    if (ocrEnabled && !selectedOcrModel) {
      return { enabled: false, reason: '启用 OCR 后必须选择模型' };
    }
    
    return { enabled: true, reason: '' };
  }, [selectedFile, selectedPolicyId, uploading, isImageFile, hasOcrModels, selectedOcrModel, ocrEnabled]);

  // ============================================
  // 数据加载
  // ============================================

  const loadTasks = async () => {
    try {
      const response = await fetch('/api/document-scan');
      const data = await response.json();
      if (data.success) {
        setTasks(data.data);
        tasksRef.current = data.data;
      }
    } catch (error) {
      console.error('加载任务失败:', error);
      toast.error('加载任务列表失败');
    } finally {
      setLoading(false);
    }
  };

  const loadPolicies = async () => {
    try {
      const response = await fetch('/api/policies');
      const data = await response.json();
      if (data.success) {
        // 只显示启用的策略
        const activePolicies = (data.data as Policy[] || []).filter((policy) => policy.isActive);
        setPolicies(activePolicies);
        if (activePolicies.length > 0) {
          const defaultPolicy = activePolicies.find((policy) => policy.isDefault) || activePolicies[0];
          setSelectedPolicyId(defaultPolicy.id);
        }
      }
    } catch (error) {
      console.error('加载策略失败:', error);
      toast.error('加载策略列表失败');
    }
  };

  const loadOcrModels = async () => {
    try {
      const response = await fetch('/api/ocr-models');
      const data = await response.json();
      if (data.success) {
        setOcrModels(data.data.models || []);
        // 自动选择推荐模型
        const recommended = data.data.models?.find((m: OcrModel) => m.recommended);
        if (recommended) {
          setSelectedOcrModel(recommended.id);
        } else if (data.data.models?.length > 0) {
          setSelectedOcrModel(data.data.models[0].id);
        }
      }
    } catch (error) {
      console.error('加载 OCR 模型失败:', error);
    }
  };

  // 初始化加载
  useEffect(() => {
    loadTasks();
    loadPolicies();
    loadOcrModels();
  }, []);

  // 轮询更新进行中的任务
  useEffect(() => {
    const interval = setInterval(() => {
      const currentTasks = tasksRef.current;
      const hasRunningTasks = currentTasks.some(t => 
        ['pending', 'parsing', 'detecting'].includes(t.status)
      );
      if (hasRunningTasks) {
        loadTasks();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // ============================================
  // 文件选择处理
  // ============================================

  const handleSelectFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    
    // 检查文件类型是否支持
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      toast.error(`不支持的文件类型: ${ext}`, {
        description: `支持的格式: ${SUPPORTED_EXTENSIONS.join(', ').toUpperCase()}`,
      });
      return;
    }

    // 检查文件大小（最大 20MB）
    if (file.size > 20 * 1024 * 1024) {
      toast.error('文件过大', {
        description: '文件大小不能超过 20MB',
      });
      return;
    }

    setSelectedFile(file);

    // 图片文件自动开启 OCR
    if (IMAGE_EXTENSIONS.includes(ext)) {
      setOcrEnabled(true);
      if (!hasOcrModels) {
        toast.warning('当前文件为图片，必须启用 OCR 才能识别文字内容', {
          description: '当前未配置可用 OCR 模型，请前往"模型供应商管理"配置支持图片识别的多模态模型',
          action: {
            label: '前往配置',
            onClick: () => router.push('/providers'),
          },
        });
      }
    } else {
      // 非图片文件，重置 OCR 开关
      setOcrEnabled(false);
    }
  }, [hasOcrModels, router]);

  // 拖拽事件处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleSelectFile(files[0]);
    }
  }, [handleSelectFile]);

  // ============================================
  // 上传处理
  // ============================================

  const handleUpload = async () => {
    if (!canStartDetection.enabled) {
      toast.error(canStartDetection.reason);
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile!);
      formData.append('policyId', selectedPolicyId);
      formData.append('ocrEnabled', (isImageFile || ocrEnabled).toString());
      if ((isImageFile || ocrEnabled) && selectedOcrModel) {
        formData.append('ocrModel', selectedOcrModel);
      }

      const response = await fetch('/api/document-scan', {
        method: 'POST',
        headers: { ...csrfHeaders() },
        body: formData,
      });

      const data = await response.json();
      if (data.success) {
        toast.success('文档上传成功，正在检测中...');
        setDialogOpen(false);
        setSelectedFile(null);
        setOcrEnabled(false);
        loadTasks();
      } else {
        toast.error('上传失败', { description: data.error });
      }
    } catch (error) {
      console.error('上传失败:', error);
      toast.error('上传失败', { description: '网络错误，请重试' });
    } finally {
      setUploading(false);
    }
  };

  // ============================================
  // 任务操作
  // ============================================

  const handleRetry = async (taskId: string) => {
    try {
      toast.info('正在重新检测...');
      const response = await fetch(`/api/document-scan/${taskId}/rescan`, {
        method: 'POST',
        headers: { ...csrfHeaders() },
      });
      const data = await response.json();
      if (data.success) {
        toast.success('重新检测完成');
        loadTasks();
      } else {
        toast.error('重新检测失败', { description: data.error });
      }
    } catch (error) {
      console.error('重新检测失败:', error);
      toast.error('重新检测失败');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!taskToDelete) return;
    
    try {
      const response = await fetch(`/api/document-scan/${taskToDelete}`, {
        method: 'DELETE',
        headers: { ...csrfHeaders() },
      });
      const data = await response.json();
      if (data.success) {
        toast.success('任务已删除');
        loadTasks();
      } else {
        toast.error('删除失败', { description: data.error });
      }
    } catch (error) {
      console.error('删除失败:', error);
      toast.error('删除失败');
    } finally {
      setDeleteDialogOpen(false);
      setTaskToDelete(null);
    }
  };

  // ============================================
  // 工具函数
  // ============================================

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // 关闭弹窗时重置状态
  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setSelectedFile(null);
      setOcrEnabled(false);
    }
  };

  // ============================================
  // 渲染
  // ============================================

  return (
    <div className="container mx-auto py-6 px-4 max-w-6xl">
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">文档检测</h1>
          <p className="text-muted-foreground mt-1">
            上传文档进行安全风险检测，支持 TXT、MD、PDF、DOCX、PNG、JPG 等格式
          </p>
        </div>

        <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
          <DialogTrigger asChild>
            <Button>
              <Upload className="w-4 h-4 mr-2" />
              上传文档
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>上传文档</DialogTitle>
              <DialogDescription>
                选择要检测的文档文件和检测策略
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* 文件选择 */}
              <div className="space-y-2">
                <Label>选择文件</Label>
                <div
                  className={cn(
                    'border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-muted/50 transition',
                    isDragging && 'border-primary bg-primary/5',
                    selectedFile && isImageFile && 'border-green-300 bg-green-50/50'
                  )}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={SUPPORTED_EXTENSIONS.map(e => `.${e}`).join(',')}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleSelectFile(file);
                    }}
                  />
                  {selectedFile ? (
                    <div className="flex items-center justify-center gap-3">
                      {isImageFile ? (
                        <ImageIcon className="w-5 h-5 text-green-600" />
                      ) : (
                        <FileText className="w-5 h-5 text-primary" />
                      )}
                      <span className="font-medium">{selectedFile.name}</span>
                      <span className="text-muted-foreground">
                        ({formatFileSize(selectedFile.size)})
                      </span>
                      {isImageFile && (
                        <Badge variant="secondary" className="ml-2">
                          <Eye className="w-3 h-3 mr-1" />
                          OCR
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <>
                      <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">
                        点击选择文件或拖拽到此处
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        支持 TXT、MD、PDF、DOCX、PNG、JPG（最大 20MB）
                      </p>
                    </>
                  )}
                </div>

                {/* 图片文件 OCR 提示 */}
                {selectedFile && isImageFile && (
                  <div className={cn(
                    'flex items-center gap-2 text-sm p-2 rounded',
                    hasOcrModels ? 'text-green-600 bg-green-50' : 'text-amber-600 bg-amber-50'
                  )}>
                    {hasOcrModels ? (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        <span>图片文件将自动启用 OCR 识别文字内容</span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4" />
                        <span>图片文件需要 OCR 模型才能识别文字</span>
                        <Link href="/providers" className="underline font-medium hover:text-amber-700">
                          去配置
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* 策略选择 */}
              <div className="space-y-2">
                <Label>检测策略</Label>
                <Select value={selectedPolicyId} onValueChange={setSelectedPolicyId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择检测策略" />
                  </SelectTrigger>
                  <SelectContent>
                    {policies.map((policy) => (
                      <SelectItem key={policy.id} value={policy.id}>
                        {policy.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* OCR 模型选择（非文本文件时显示） */}
              {!isTextFile && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label>OCR 模型</Label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="w-4 h-4 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>OCR 用于识别图片中的文字。图片文件必须选择 OCR 模型；PDF/DOCX 如为扫描件可启用 OCR。</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  
                  <Select 
                    value={selectedOcrModel} 
                    onValueChange={setSelectedOcrModel}
                    disabled={!hasOcrModels}
                  >
                    <SelectTrigger className={cn(!hasOcrModels && 'opacity-60')}>
                      <SelectValue placeholder={hasOcrModels ? "选择 OCR 模型" : "暂无可用 OCR 模型"} />
                    </SelectTrigger>
                    <SelectContent>
                      {ocrModels.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          <div className="flex items-center gap-2">
                            <span>{model.name}</span>
                            {model.recommended && (
                              <Badge variant="secondary" className="text-xs">推荐</Badge>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {!hasOcrModels && (
                    <div className="text-xs text-amber-600 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      <span>暂无可用 OCR 模型，请前往</span>
                      <Link href="/providers" className="underline hover:text-amber-700 font-medium">
                        模型供应商管理
                      </Link>
                      <span>配置</span>
                    </div>
                  )}
                </div>
              )}

              {/* OCR 开关（仅文档类型显示，图片强制开启） */}
              {selectedFile && fileCategory === 'document' && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2">
                    <Eye className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <Label className="cursor-pointer">启用 OCR</Label>
                      <p className="text-xs text-muted-foreground">
                        如果是扫描件 PDF，可启用 OCR 识别文字
                      </p>
                    </div>
                  </div>
                  <Switch 
                    checked={ocrEnabled} 
                    onCheckedChange={setOcrEnabled}
                    disabled={!hasOcrModels || !selectedOcrModel}
                  />
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleDialogOpenChange(false)}>
                取消
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button 
                        onClick={handleUpload} 
                        disabled={!canStartDetection.enabled || uploading}
                      >
                        {uploading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        开始检测
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!canStartDetection.enabled && (
                    <TooltipContent>
                      <p>{canStartDetection.reason}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* 任务列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : tasks.length === 0 ? (
        <Card className="py-12">
          <CardContent className="text-center">
            <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">暂无检测任务</h3>
            <p className="text-muted-foreground mb-4">
              点击右上角&quot;上传文档&quot;按钮开始检测
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => {
            const statusInfo = statusConfig[task.status] || statusConfig.pending;
            const StatusIcon = statusInfo.icon;
            const isRunning = ['pending', 'parsing', 'detecting'].includes(task.status);

            return (
              <Card key={task.id} className="hover:shadow-md transition">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {/* 文件图标 */}
                    <div className={cn(
                      'w-12 h-12 rounded-lg flex items-center justify-center',
                      IMAGE_EXTENSIONS.includes(task.fileType.toLowerCase()) 
                        ? 'bg-green-100' 
                        : 'bg-primary/10'
                    )}>
                      {IMAGE_EXTENSIONS.includes(task.fileType.toLowerCase()) ? (
                        <ImageIcon className="w-6 h-6 text-green-600" />
                      ) : (
                        <FileText className="w-6 h-6 text-primary" />
                      )}
                    </div>

                    {/* 文件信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium truncate">{task.fileName}</h3>
                        <Badge variant="outline" className="shrink-0">
                          {task.fileType.toUpperCase()}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
                        <span>{formatFileSize(task.fileSize)}</span>
                        <span>•</span>
                        <span>{formatTime(task.createdAt)}</span>
                      </div>
                    </div>

                    {/* 状态 */}
                    <div className="flex items-center gap-3">
                      <Badge className={cn('gap-1', statusInfo.color)}>
                        {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
                        {statusInfo.label}
                      </Badge>

                      {task.status === 'completed' && task.finalAction && (
                        <Badge
                          className={cn(
                            'text-white',
                            actionConfig[task.finalAction as keyof typeof actionConfig]?.color || 'bg-gray-500'
                          )}
                        >
                          {task.findingsCount > 0 ? `${task.findingsCount} 个风险` : '无风险'}
                        </Badge>
                      )}
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-2">
                      {task.status === 'completed' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => router.push(`/document-scan/${task.id}`)}
                        >
                          查看详情
                          <ArrowRight className="w-4 h-4 ml-1" />
                        </Button>
                      )}
                      {task.status === 'failed' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRetry(task.id)}
                        >
                          <RefreshCw className="w-4 h-4 mr-1" />
                          重新检测
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          setTaskToDelete(task.id);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {/* 状态/错误消息 */}
                  {(task.statusMessage || task.errorMessage) && (
                    <div className={cn(
                      'text-sm mt-2 pl-16',
                      task.status === 'failed' ? 'text-red-600' : 'text-muted-foreground'
                    )}>
                      {task.status === 'failed' && <FileWarning className="w-4 h-4 inline mr-1" />}
                      {task.errorMessage || task.statusMessage}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 删除确认对话框 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除这个检测任务吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
