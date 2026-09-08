'use client';

import {MediaInspectionWorkbench} from '@/components/media/media-inspection-workbench';
import {extensionsFor} from '@/lib/media/formats/registry';
import {useState,useEffect,useRef} from 'react';
import {useRouter} from 'next/navigation';
import {FileText,Clock,CheckCircle,XCircle,Shield,ArrowRight,Loader2,Trash2,RefreshCw,Image as ImageIcon,FileWarning} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card,CardContent} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {AlertDialog,AlertDialogAction,AlertDialogCancel,AlertDialogContent,AlertDialogDescription,AlertDialogFooter,AlertDialogHeader,AlertDialogTitle} from '@/components/ui/alert-dialog';
import {toast} from 'sonner';
import {cn} from '@/lib/utils';
import {csrfHeaders} from '@/lib/auth/csrf-client';

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
const IMAGE_EXTENSIONS = extensionsFor('image');
export default function DocumentScanPage() {
  const router = useRouter();
  const [tasks,setTasks]=useState<DocumentTask[]>([]);
  const [loading,setLoading]=useState(true);
  const [deleteDialogOpen,setDeleteDialogOpen]=useState(false);
  const [taskToDelete,setTaskToDelete]=useState<string|null>(null);
  const tasksRef=useRef<DocumentTask[]>([]);

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

  // 初始化加载
  useEffect(() => {
    loadTasks();
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
        toast.error('重新检测失败', { description: data.detail ?? data.error ?? data.code });
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
        toast.error('删除失败', { description: data.detail ?? data.error ?? data.code });
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

  return (
    <div className="container mx-auto py-6 px-4 max-w-6xl">
      <div className="mb-6"><MediaInspectionWorkbench title="文档、文本与音视频联合检测"/></div>
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">文档检测</h1>
          <p className="text-muted-foreground mt-1">
            查看历史文档任务；新任务请使用上方统一上传入口
          </p>
        </div>


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
              请使用上方统一上传入口创建检测任务
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => {
            const statusInfo = statusConfig[task.status] || statusConfig.pending;
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
