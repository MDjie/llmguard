#!/usr/bin/env python3
"""
生成 GuardLLM 平台架构图并输出到 Word 文档
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np
from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_ORIENT
import os

# ============================================================
# 第一部分：生成架构图 (matplotlib)
# ============================================================

plt.rcParams['font.family'] = ['Noto Sans CJK SC', 'Noto Serif CJK SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# 颜色定义
COLORS = {
    'user': '#E3F2FD',          # 浅蓝 - 用户层
    'gateway': '#BBDEFB',       # 蓝 - 网关层
    'frontend': '#C8E6C9',      # 浅绿 - 前端层
    'backend': '#FFF9C4',       # 浅黄 - 后端层
    'engine': '#FFE0B2',        # 浅橙 - 引擎层
    'model': '#F8BBD0',         # 浅粉 - 模型层
    'data': '#D1C4E9',          # 浅紫 - 数据层
    'external': '#B2DFDB',      # 浅青 - 外部集成
    'border_user': '#1565C0',
    'border_gateway': '#1976D2',
    'border_frontend': '#2E7D32',
    'border_backend': '#F9A825',
    'border_engine': '#E65100',
    'border_model': '#C2185B',
    'border_data': '#512DA8',
    'border_external': '#00695C',
}

def draw_rounded_box(ax, x, y, w, h, text, color, border_color, fontsize=9, fontweight='normal', alpha=0.9):
    box = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02", 
                          facecolor=color, edgecolor=border_color, linewidth=1.5, alpha=alpha)
    ax.add_patch(box)
    ax.text(x + w/2, y + h/2, text, ha='center', va='center', fontsize=fontsize, 
            fontweight=fontweight, color='#212121', wrap=True)

def draw_layer_bg(ax, x, y, w, h, label, color, border_color, alpha=0.15):
    box = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.03",
                          facecolor=color, edgecolor=border_color, linewidth=2, alpha=alpha, linestyle='--')
    ax.add_patch(box)
    ax.text(x + 0.02, y + h - 0.08, label, ha='left', va='top', fontsize=10, 
            fontweight='bold', color=border_color, alpha=0.8)

def draw_arrow(ax, x1, y1, x2, y2, color='#616161', style='->', lw=1.5):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw))

# 创建架构图
fig, ax = plt.subplots(1, 1, figsize=(20, 14))
ax.set_xlim(0, 20)
ax.set_ylim(0, 14)
ax.axis('off')
fig.patch.set_facecolor('white')

# === Layer 1: 用户接入层 ===
draw_layer_bg(ax, 0.3, 12.2, 19.4, 1.5, '用户接入层', COLORS['user'], COLORS['border_user'])
draw_rounded_box(ax, 1, 12.5, 3, 0.9, 'Web浏览器', COLORS['user'], COLORS['border_user'], fontsize=10)
draw_rounded_box(ax, 5, 12.5, 3, 0.9, 'API客户端', COLORS['user'], COLORS['border_user'], fontsize=10)
draw_rounded_box(ax, 9, 12.5, 3.5, 0.9, '第三方系统集成', COLORS['user'], COLORS['border_user'], fontsize=10)
draw_rounded_box(ax, 14, 12.5, 3, 0.9, '管理控制台', COLORS['user'], COLORS['border_user'], fontsize=10)

# === Layer 2: 反向代理/网关层 ===
draw_layer_bg(ax, 0.3, 10.5, 19.4, 1.4, '反向代理层', COLORS['gateway'], COLORS['border_gateway'])
draw_rounded_box(ax, 3, 10.7, 5, 0.9, 'Nginx (8080→58082)\n负载均衡 / SSL卸载', COLORS['gateway'], COLORS['border_gateway'], fontsize=10)
draw_rounded_box(ax, 10, 10.7, 5, 0.9, '认证鉴权\nCookie Session', COLORS['gateway'], COLORS['border_gateway'], fontsize=10)

# === Layer 3: 前端展示层 ===
draw_layer_bg(ax, 0.3, 8.3, 19.4, 1.9, '前端展示层 (Next.js 16 SSR)', COLORS['frontend'], COLORS['border_frontend'])
draw_rounded_box(ax, 1, 8.6, 2.5, 1.3, 'Dashboard\n仪表盘', COLORS['frontend'], COLORS['border_frontend'], fontsize=9)
draw_rounded_box(ax, 3.8, 8.6, 2.5, 1.3, '维度管理\n25维度配置', COLORS['frontend'], COLORS['border_frontend'], fontsize=9)
draw_rounded_box(ax, 6.6, 8.6, 2.5, 1.3, '策略管理\n3套策略', COLORS['frontend'], COLORS['border_frontend'], fontsize=9)
draw_rounded_box(ax, 9.4, 8.6, 2.5, 1.3, '实时检测\n在线测试', COLORS['frontend'], COLORS['border_frontend'], fontsize=9)
draw_rounded_box(ax, 12.2, 8.6, 2.5, 1.3, '文档扫描\n文件审核', COLORS['frontend'], COLORS['border_frontend'], fontsize=9)
draw_rounded_box(ax, 15, 8.6, 2.2, 1.3, '历史记录\n统计报表', COLORS['frontend'], COLORS['border_frontend'], fontsize=9)
draw_rounded_box(ax, 17.5, 8.6, 2, 1.3, '模型评测\n测试用例', COLORS['frontend'], COLORS['border_frontend'], fontsize=9)

# === Layer 4: 后端API层 ===
draw_layer_bg(ax, 0.3, 5.8, 19.4, 2.2, '后端API层 (Next.js API Routes + Drizzle ORM)', COLORS['backend'], COLORS['border_backend'])
draw_rounded_box(ax, 1, 6.2, 3, 0.7, '/api/detect\n检测入口', COLORS['backend'], COLORS['border_backend'], fontsize=9, fontweight='bold')
draw_rounded_box(ax, 4.3, 6.2, 3, 0.7, '/api/dimensions\n维度管理', COLORS['backend'], COLORS['border_backend'], fontsize=9)
draw_rounded_box(ax, 7.6, 6.2, 3, 0.7, '/api/policies\n策略管理', COLORS['backend'], COLORS['border_backend'], fontsize=9)
draw_rounded_box(ax, 10.9, 6.2, 3, 0.7, '/api/stats\n统计分析', COLORS['backend'], COLORS['border_backend'], fontsize=9)
draw_rounded_box(ax, 14.2, 6.2, 3, 0.7, '/api/chat\n对话接口', COLORS['backend'], COLORS['border_backend'], fontsize=9)
draw_rounded_box(ax, 17.5, 6.2, 2, 0.7, '/api/health\n健康检查', COLORS['backend'], COLORS['border_backend'], fontsize=9)

draw_rounded_box(ax, 1, 7.1, 5.5, 0.7, '认证模块 (Cookie/Session)  |  用户管理  |  白名单管理', COLORS['backend'], COLORS['border_backend'], fontsize=8)
draw_rounded_box(ax, 7, 7.1, 5.5, 0.7, '文档扫描服务  |  模型评测服务  |  导出服务', COLORS['backend'], COLORS['border_backend'], fontsize=8)
draw_rounded_box(ax, 13, 7.1, 6.5, 0.7, '策略版本管理  |  关键词分类管理  |  升级告警配置', COLORS['backend'], COLORS['border_backend'], fontsize=8)

# === Layer 5: 检测引擎层 ===
draw_layer_bg(ax, 0.3, 3.2, 19.4, 2.3, '双引擎融合检测层', COLORS['engine'], COLORS['border_engine'])
draw_rounded_box(ax, 1, 4.2, 4.5, 1.0, '规则引擎 (权重0.3)\n关键词匹配 + 正则表达式\n25维度 × 126条规则', 
                 COLORS['engine'], COLORS['border_engine'], fontsize=9, fontweight='bold')
draw_rounded_box(ax, 6, 4.2, 4.5, 1.0, '裁判模型引擎 (权重0.7)\nunisguard-guard\n语义级安全判别', 
                 COLORS['engine'], COLORS['border_engine'], fontsize=9, fontweight='bold')
draw_rounded_box(ax, 11, 4.2, 4, 1.0, '融合决策器\n风险评分 → 动作\nallow/warn/block/mask', 
                 COLORS['engine'], COLORS['border_engine'], fontsize=9, fontweight='bold')
draw_rounded_box(ax, 15.5, 4.2, 4, 1.0, 'Sensitive-lexicon\n10,482条中文敏感词\n8大词库分类', 
                 COLORS['engine'], COLORS['border_engine'], fontsize=9)

draw_rounded_box(ax, 1, 3.4, 18.5, 0.6, 
    '检测维度: 提示词注入 | 信息泄露 | 恶意代码 | 暴力仇恨 | 非法内容 | 色情低俗 | 自伤自杀 | 诈骗欺诈 | 幻觉检测 | 话题安全 | 对话操纵 | 数据外泄 | 模型提取攻击 | 恶意网址 | 民生敏感 | ...',
    '#FFF3E0', '#E65100', fontsize=7.5)

# === Layer 6: 模型推理层 ===
draw_layer_bg(ax, 0.3, 1.5, 9.5, 1.4, '模型推理层', COLORS['model'], COLORS['border_model'])
draw_rounded_box(ax, 1, 1.7, 4, 0.9, 'Ollama (port 11434)\nunisguard-guard\nQwen2.5-1.5B', 
                 COLORS['model'], COLORS['border_model'], fontsize=9, fontweight='bold')
draw_rounded_box(ax, 5.5, 1.7, 4, 0.9, 'Ollama\nqwen2.5:7b\n通用推理模型', 
                 COLORS['model'], COLORS['border_model'], fontsize=9)

# === Layer 7: 数据存储层 ===
draw_layer_bg(ax, 10.3, 1.5, 9.4, 1.4, '数据存储层', COLORS['data'], COLORS['border_data'])
draw_rounded_box(ax, 11, 1.7, 4, 0.9, 'PostgreSQL 16\n(port 5434)\n27张数据表', 
                 COLORS['data'], COLORS['border_data'], fontsize=9, fontweight='bold')
draw_rounded_box(ax, 15.5, 1.7, 4, 0.9, 'Docker Compose\n容器化部署\n数据持久化卷', 
                 COLORS['data'], COLORS['border_data'], fontsize=9)

# === 绘制连接箭头 ===
# 用户层 → 网关层
for x in [2.5, 6.5, 10.75, 15.5]:
    draw_arrow(ax, x, 12.5, x, 11.6, '#1565C0')

# 网关层 → 前端层
draw_arrow(ax, 5.5, 10.7, 10, 9.9, '#1976D2')
draw_arrow(ax, 12.5, 10.7, 10, 9.9, '#1976D2')

# 前端层 → 后端API层
draw_arrow(ax, 5, 8.6, 5, 7.8, '#2E7D32')
draw_arrow(ax, 10, 8.6, 10, 7.8, '#2E7D32')
draw_arrow(ax, 15, 8.6, 15, 7.8, '#2E7D32')

# 后端API层 → 检测引擎层
draw_arrow(ax, 2.5, 6.2, 3.25, 5.2, '#F9A825', lw=2)
draw_arrow(ax, 10, 6.2, 8.25, 5.2, '#F9A825', lw=2)

# 检测引擎层 → 模型推理层
draw_arrow(ax, 8.25, 4.2, 5, 2.6, '#C2185B', lw=2, style='->')

# 后端API层 → 数据存储层
draw_arrow(ax, 17, 6.2, 17, 2.6, '#512DA8', lw=2)

# 检测引擎层 → 数据存储层
draw_arrow(ax, 17.5, 4.2, 17, 2.6, '#512DA8', lw=1.5)

# 标题
ax.text(10, 13.9, 'GuardLLM — LLM安全防护平台架构图', ha='center', va='center', 
        fontsize=18, fontweight='bold', color='#1A237E')

# 版本信息
ax.text(19.7, 0.1, 'v1.0 | 2026-06-13', ha='right', va='bottom', fontsize=8, color='#9E9E9E')

plt.tight_layout(pad=0.5)
arch_path = '/home/ubuntu/.openclaw/workspace/GuardLLM_Architecture.png'
plt.savefig(arch_path, dpi=200, bbox_inches='tight', facecolor='white')
plt.close()
print(f"架构图已保存: {arch_path}")

# ============================================================
# 第二部分：生成数据流图
# ============================================================

fig2, ax2 = plt.subplots(1, 1, figsize=(18, 8))
ax2.set_xlim(0, 18)
ax2.set_ylim(0, 8)
ax2.axis('off')
fig2.patch.set_facecolor('white')

# 标题
ax2.text(9, 7.7, 'GuardLLM 检测流程数据流图', ha='center', va='center', 
        fontsize=16, fontweight='bold', color='#1A237E')

# 流程节点
flow_nodes = [
    (1, 4.5, 2.5, 1.2, '用户请求\n(LLM对话输入)', '#E3F2FD', '#1565C0'),
    (4.5, 4.5, 2.5, 1.2, '预处理\n(文本清洗/分段)', '#C8E6C9', '#2E7D32'),
    (8, 4.5, 3, 1.2, '规则引擎\n关键词+正则匹配\n25维度×126规则', '#FFF9C4', '#F9A825'),
    (12, 4.5, 3, 1.2, '裁判模型\nunisguard-guard\n语义安全判别', '#FFE0B2', '#E65100'),
    (16, 4.5, 1.8, 1.2, '融合决策\n风险评分', '#F8BBD0', '#C2185B'),
]

for x, y, w, h, text, color, border in flow_nodes:
    draw_rounded_box(ax2, x, y, w, h, text, color, border, fontsize=9, fontweight='bold')

# 箭头
draw_arrow(ax2, 3.5, 5.1, 4.5, 5.1, '#37474F', lw=2)
draw_arrow(ax2, 7, 5.1, 8, 5.1, '#37474F', lw=2)
draw_arrow(ax2, 11, 5.1, 12, 5.1, '#37474F', lw=2)
draw_arrow(ax2, 15, 5.1, 16, 5.1, '#37474F', lw=2)

# 输出分支
output_nodes = [
    (14.5, 2.2, 2, 0.8, 'ALLOW\n风险分 < 阈值', '#C8E6C9', '#2E7D32'),
    (14.5, 1, 2, 0.8, 'WARN\n警告阈值 <= 风险分', '#FFF9C4', '#F9A825'),
    (16.8, 2.2, 1.5, 0.8, 'BLOCK\n风险分 >= 阻断阈值', '#FFCDD2', '#C62828'),
    (16.8, 1, 1.5, 0.8, 'MASK\n敏感信息脱敏', '#E1BEE7', '#6A1B9A'),
]

for x, y, w, h, text, color, border in output_nodes:
    draw_rounded_box(ax2, x, y, w, h, text, color, border, fontsize=8, fontweight='bold')

# 输出箭头
draw_arrow(ax2, 16.9, 4.5, 15.5, 3.0, '#37474F', lw=1.5)
draw_arrow(ax2, 16.9, 4.5, 15.5, 1.8, '#37474F', lw=1.5)
draw_arrow(ax2, 17.8, 4.5, 17.55, 3.0, '#37474F', lw=1.5)
draw_arrow(ax2, 17.8, 4.5, 17.55, 1.8, '#37474F', lw=1.5)

# 条件触发说明
ax2.text(4.5, 3.8, '规则分≥20 或\n语义触发关键词', ha='center', va='center', 
         fontsize=7, color='#E65100', style='italic')

# 结果记录
draw_rounded_box(ax2, 1, 1.5, 5, 1.2, '检测结果存储\nPostgreSQL: detection_sessions + detection_records + risk_findings\n+ agent_traces (可观测性)', 
                 '#D1C4E9', '#512DA8', fontsize=8)

draw_arrow(ax2, 14.5, 2.6, 6, 2.1, '#512DA8', lw=1)

flow_path = '/home/ubuntu/.openclaw/workspace/GuardLLM_DataFlow.png'
plt.savefig(flow_path, dpi=200, bbox_inches='tight', facecolor='white')
plt.close()
print(f"数据流图已保存: {flow_path}")

# ============================================================
# 第三部分：生成 Word 文档
# ============================================================

doc = Document()

# 设置默认字体
style = doc.styles['Normal']
font = style.font
font.name = 'Noto Sans CJK SC'
font.size = Pt(11)

# 标题页
doc.add_paragraph()
doc.add_paragraph()
title = doc.add_heading('GuardLLM', level=0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
for run in title.runs:
    run.font.size = Pt(36)
    run.font.color.rgb = RGBColor(0x1A, 0x23, 0x7E)

subtitle = doc.add_heading('LLM安全防护平台', level=1)
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
for run in subtitle.runs:
    run.font.size = Pt(24)
    run.font.color.rgb = RGBColor(0x28, 0x35, 0x93)

doc.add_paragraph()
info = doc.add_paragraph()
info.alignment = WD_ALIGN_PARAGRAPH.CENTER
info.add_run('平台架构文档').font.size = Pt(16)
doc.add_paragraph()
info2 = doc.add_paragraph()
info2.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = info2.add_run('版本: v1.0\n日期: 2026年6月13日\n密级: 内部')
run.font.size = Pt(12)
run.font.color.rgb = RGBColor(0x75, 0x75, 0x75)

doc.add_page_break()

# 目录
doc.add_heading('目录', level=1)
toc_items = [
    '1. 平台概述',
    '2. 架构设计',
    '   2.1 总体架构',
    '   2.2 检测流程',
    '3. 技术栈',
    '4. 部署架构',
    '5. 检测维度',
    '6. 检测引擎',
    '   6.1 规则引擎',
    '   6.2 裁判模型引擎',
    '   6.3 融合决策',
    '7. 数据库设计',
    '8. 安全设计',
    '9. 性能指标',
]
for item in toc_items:
    p = doc.add_paragraph(item)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.line_spacing = 1.3

doc.add_page_break()

# 1. 平台概述
doc.add_heading('1. 平台概述', level=1)
doc.add_paragraph(
    'GuardLLM是一款面向大语言模型(LLM)的安全防护平台，旨在为企业级LLM应用提供全面的内容安全检测、'
    '风险识别与实时防护能力。平台采用"规则引擎 + 裁判模型"双引擎融合架构，覆盖25个安全检测维度、'
    '126条检测规则、10,482条中文敏感词库，支持从输入拦截到输出审核的全链路安全防护。'
)
doc.add_heading('1.1 核心能力', level=2)
capabilities = [
    ('双引擎融合检测', '规则引擎(关键词+正则)与裁判模型(语义判别)协同工作，规则权重0.3+裁判权重0.7，兼顾效率与精度'),
    ('25维全场景覆盖', '覆盖安全、隐私、合规、内容、质量5大类，包括提示词注入、信息泄露、恶意代码、幻觉检测等25个维度'),
    ('灵活策略管理', '内置严格/均衡/宽松3套策略，支持自定义阈值与动作配置，可按业务场景灵活调整'),
    ('实时在线检测', 'API接口支持毫秒级响应，适合集成到对话系统、内容审核等实时场景'),
    ('可观测性', '检测会话、风险发现、代理追踪全链路记录，支持统计分析与审计回溯'),
    ('容器化部署', 'Docker Compose一键部署，PostgreSQL数据持久化，Nginx反向代理'),
]
for title, desc in capabilities:
    p = doc.add_paragraph()
    run = p.add_run(f'▸ {title}：')
    run.bold = True
    p.add_run(desc)

# 2. 架构设计
doc.add_heading('2. 架构设计', level=1)
doc.add_heading('2.1 总体架构', level=2)
doc.add_paragraph('GuardLLM采用分层架构设计，自上而下分为7层：')
layers = [
    ('用户接入层', 'Web浏览器、API客户端、第三方系统集成、管理控制台'),
    ('反向代理层', 'Nginx反向代理(8080→58082)，负载均衡，SSL卸载，认证鉴权'),
    ('前端展示层', 'Next.js 16 SSR渲染，shadcn/ui组件库，Tailwind CSS 4样式，Dashboard/维度管理/策略管理/实时检测/文档扫描等7大模块'),
    ('后端API层', 'Next.js API Routes，Drizzle ORM数据库访问，认证/维度/策略/检测/统计/扫描等完整RESTful接口'),
    ('双引擎检测层', '规则引擎(关键词+正则，25维度×126规则) + 裁判模型引擎(unisguard-guard语义判别) + 融合决策器 + Sensitive-lexicon词库'),
    ('模型推理层', 'Ollama本地部署，unisguard-guard(Qwen2.5-1.5B)安全判别模型，qwen2.5:7b通用推理模型'),
    ('数据存储层', 'PostgreSQL 16，27张数据表，Docker Compose容器化，数据持久化卷'),
]
for i, (name, desc) in enumerate(layers, 1):
    p = doc.add_paragraph()
    run = p.add_run(f'第{i}层 {name}：')
    run.bold = True
    p.add_run(desc)

# 插入架构图
doc.add_paragraph()
doc.add_paragraph('平台总体架构图如下：')
doc.add_picture(arch_path, width=Inches(6.5))
last_paragraph = doc.paragraphs[-1]
last_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER

doc.add_page_break()

# 2.2 检测流程
doc.add_heading('2.2 检测流程', level=2)
doc.add_paragraph(
    'GuardLLM的检测流程采用"先规则后语义"的瀑布式架构，用户请求依次经过预处理、规则引擎、'
    '裁判模型、融合决策四个阶段，最终输出allow/warn/block/mask四种动作。'
)
steps = [
    '用户请求：LLM对话输入通过API接口进入检测流程',
    '预处理：文本清洗、分段，提取待检测内容',
    '规则引擎匹配：遍历25个维度的126条规则，进行关键词包含匹配和正则表达式匹配，计算规则风险分',
    '裁判模型判别：当规则分≥20或命中语义触发关键词时，调用unisguard-guard模型进行语义级安全判别',
    '融合决策：规则分×0.3 + 裁判分×0.7 = 综合风险分，与策略阈值比较决定动作',
    '输出结果：allow(放行)、warn(警告)、block(阻断)、mask(脱敏)，同时记录检测会话和风险发现',
]
for i, step in enumerate(steps, 1):
    doc.add_paragraph(f'{i}. {step}')

doc.add_paragraph('检测流程数据流图如下：')
doc.add_picture(flow_path, width=Inches(6.5))
last_paragraph = doc.paragraphs[-1]
last_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER

# 3. 技术栈
doc.add_heading('3. 技术栈', level=1)
tech_table = doc.add_table(rows=10, cols=3, style='Table Grid')
tech_table.alignment = WD_TABLE_ALIGNMENT.CENTER
headers = ['类别', '技术', '版本/说明']
for i, h in enumerate(headers):
    tech_table.rows[0].cells[i].text = h
    for p in tech_table.rows[0].cells[i].paragraphs:
        for r in p.runs:
            r.bold = True

tech_data = [
    ('前端框架', 'Next.js + React', 'v16.1.1, SSR/SSG'),
    ('UI组件库', 'shadcn/ui + Radix UI', 'Tailwind CSS 4'),
    ('后端运行时', 'Next.js API Routes', 'Node.js 20, TypeScript'),
    ('ORM', 'Drizzle ORM', 'v0.45.1'),
    ('数据库', 'PostgreSQL', 'v16, 27张表'),
    ('模型推理', 'Ollama', 'unisguard-guard / qwen2.5:7b'),
    ('反向代理', 'Nginx', '8080→58082'),
    ('容器化', 'Docker Compose', 'app + postgres 双容器'),
    ('图表', 'Recharts', 'v2.15.4'),
]
for i, (cat, tech, ver) in enumerate(tech_data, 1):
    tech_table.rows[i].cells[0].text = cat
    tech_table.rows[i].cells[1].text = tech
    tech_table.rows[i].cells[2].text = ver

# 4. 部署架构
doc.add_heading('4. 部署架构', level=1)
doc.add_paragraph(
    'GuardLLM采用Docker Compose容器化部署，应用和数据库分别运行在独立容器中，'
    '通过Docker网络通信。宿主机Nginx提供反向代理和SSL卸载。'
)
deploy_info = [
    ('服务器', '43.134.236.109 (腾讯云CVM)'),
    ('应用容器', 'guardllm-app: Next.js standalone, port 58082'),
    ('数据库容器', 'guardllm-db: PostgreSQL 16, port 5434'),
    ('Ollama', '宿主机原生部署, port 11434'),
    ('Nginx', '宿主机部署, port 8080→58082'),
    ('容器间通信', 'Docker bridge网络, app通过host.docker.internal访问Ollama'),
    ('数据持久化', 'Docker Volume: postgres_data'),
]
for key, val in deploy_info:
    p = doc.add_paragraph()
    run = p.add_run(f'{key}：')
    run.bold = True
    p.add_run(val)

# 5. 检测维度
doc.add_heading('5. 检测维度', level=1)
doc.add_paragraph('GuardLLM当前支持25个安全检测维度，分为5大类：')

dim_table = doc.add_table(rows=26, cols=5, style='Table Grid')
dim_table.alignment = WD_TABLE_ALIGNMENT.CENTER
dim_headers = ['维度名称', '编码', '分类', '权重', '规则数']
for i, h in enumerate(dim_headers):
    dim_table.rows[0].cells[i].text = h
    for p in dim_table.rows[0].cells[i].paragraphs:
        for r in p.runs:
            r.bold = True

dimensions = [
    ('提示词注入', 'prompt_injection', '安全', '1.00', '18'),
    ('信息泄露', 'pii_leak', '合规', '1.00', '6'),
    ('恶意代码', 'malicious_code', '安全', '1.00', '24'),
    ('暴力仇恨', 'violence_hate', '内容', '0.80', '5'),
    ('非法内容', 'illegal_content', '内容', '0.80', '10'),
    ('色情低俗', 'adult_content', '内容', '0.90', '5'),
    ('自伤自杀', 'self_harm', '人身安全', '1.00', '4'),
    ('敏感合规', 'sensitive_compliance', '合规', '0.80', '4'),
    ('密钥凭证泄露', 'credential_secret_leak', '隐私', '0.90', '4'),
    ('诈骗欺诈', 'fraud_scam', '内容', '1.00', '5'),
    ('虚假信息', 'misinformation', '内容', '0.80', '2'),
    ('版权风险', 'copyright_risk', '合规', '0.70', '2'),
    ('企业敏感信息', 'business_sensitive', '隐私', '0.90', '3'),
    ('输出泄露', 'output_leak', '安全', '0.80', '2'),
    ('垃圾信息检测', 'spam_detection', '内容', '0.70', '4'),
    ('广告检测', 'ad_detection', '内容', '0.90', '4'),
    ('政治敏感', 'politically_sensitive', '内容', '1.00', '4'),
    ('幻觉检测', 'hallucination', '质量', '0.85', '3'),
    ('话题安全', 'topic_safety', '安全', '0.80', '3'),
    ('对话操纵', 'dialog_manipulation', '安全', '0.90', '3'),
    ('数据外泄', 'data_exfiltration', '隐私', '0.95', '4'),
    ('模型提取攻击', 'model_extraction', '安全', '0.90', '4'),
    ('民生敏感', 'livelihood_sensitive', '合规', '0.75', '1'),
    ('公共卫生敏感', 'public_health_sensitive', '合规', '0.70', '1'),
    ('恶意网址', 'malicious_url', '安全', '0.90', '1'),
]
for i, (name, code, cat, weight, rules) in enumerate(dimensions, 1):
    dim_table.rows[i].cells[0].text = name
    dim_table.rows[i].cells[1].text = code
    dim_table.rows[i].cells[2].text = cat
    dim_table.rows[i].cells[3].text = weight
    dim_table.rows[i].cells[4].text = rules

doc.add_paragraph()
doc.add_paragraph('注：维度数据来源包括平台内置规则、NVIDIA NeMo Guardrails、konsheng/Sensitive-lexicon(3.7k⭐)等。')

# 6. 检测引擎
doc.add_heading('6. 检测引擎', level=1)
doc.add_heading('6.1 规则引擎', level=2)
doc.add_paragraph(
    '规则引擎基于关键词包含匹配和正则表达式匹配，遍历所有启用维度的启用规则，'
    '对输入文本进行逐条匹配。命中规则的分数按权重累加，得到规则风险分。'
    '当前共126条规则，其中关键词规则约60条，正则规则约66条。'
    '此外集成了Sensitive-lexicon中文敏感词库，覆盖色情、暴力、政治、涉枪涉爆、'
    '贪腐、广告、民生、COVID-19、非法网址等8大分类，共计10,482条敏感词。'
)
doc.add_heading('6.2 裁判模型引擎', level=2)
doc.add_paragraph(
    '裁判模型引擎基于本地部署的unisguard-guard模型（基于Qwen2.5-1.5B微调），'
    '通过Ollama提供的OpenAI兼容API进行推理。当规则风险分≥20或命中语义触发关键词时，'
    '自动调用裁判模型进行语义级安全判别，弥补规则引擎无法识别语义风险的不足。'
)
doc.add_heading('6.3 融合决策', level=2)
doc.add_paragraph(
    '融合决策器将规则风险分与裁判模型评分加权融合，计算综合风险分：'
)
p = doc.add_paragraph()
run = p.add_run('综合风险分 = 规则分 × 0.3 + 裁判分 × 0.7')
run.bold = True
run.font.size = Pt(12)
doc.add_paragraph(
    '融合后的综合风险分与当前策略的阈值比较，输出最终动作：'
    '风险分 < 警告阈值 → allow（放行）；'
    '警告阈值 ≤ 风险分 < 阻断阈值 → warn（警告）；'
    '风险分 ≥ 阻断阈值 → block（阻断）；'
    '数据外泄/模型提取等维度命中时 → mask（自动脱敏）。'
)

# 7. 数据库设计
doc.add_heading('7. 数据库设计', level=1)
doc.add_paragraph('GuardLLM使用PostgreSQL 16，共27张数据表，核心表包括：')
db_tables = [
    ('detection_dimensions', '检测维度表', '25条', '维度定义、分类、权重、优先级'),
    ('detection_rules', '检测规则表', '126条', '关键词/正则规则、匹配模式、分数'),
    ('rule_groups', '规则组表', '-', '规则分组管理'),
    ('policy_profiles', '策略配置表', '3条', '严格/均衡/宽松策略定义'),
    ('policy_dimension_config', '策略维度配置表', '75条', '每策略每维度的阈值和动作'),
    ('policy_rules', '策略规则表', '-', '策略关联的规则配置'),
    ('llm_providers', 'LLM供应商表', '-', '模型供应商配置'),
    ('policy_judge_configs', '裁判模型配置表', '-', '裁判模型参数'),
    ('detection_sessions', '检测会话表', '-', '检测请求会话记录'),
    ('detection_records', '检测记录表', '-', '逐维度检测结果'),
    ('risk_findings', '风险发现表', '-', '风险项详情'),
    ('agent_traces', '代理追踪表', '-', '可观测性链路追踪'),
    ('users', '用户表', '-', '平台用户管理'),
    ('whitelist_rules', '白名单规则表', '-', '白名单管理'),
    ('test_cases', '测试用例表', '-', '模型评测用例'),
]
db_table = doc.add_table(rows=len(db_tables)+1, cols=4, style='Table Grid')
db_table.alignment = WD_TABLE_ALIGNMENT.CENTER
for i, h in enumerate(['表名', '说明', '记录数', '主要内容']):
    db_table.rows[0].cells[i].text = h
    for p in db_table.rows[0].cells[i].paragraphs:
        for r in p.runs:
            r.bold = True
for i, (name, desc, count, content) in enumerate(db_tables, 1):
    db_table.rows[i].cells[0].text = name
    db_table.rows[i].cells[1].text = desc
    db_table.rows[i].cells[2].text = count
    db_table.rows[i].cells[3].text = content

# 8. 安全设计
doc.add_heading('8. 安全设计', level=1)
security_items = [
    ('认证鉴权', 'Cookie/Session机制，HTTP-only Cookie，登录态管理'),
    ('访问控制', '基于角色的访问控制，系统内置维度不可删除'),
    ('数据隔离', 'Docker网络隔离，数据库独立容器，Ollama仅内网可访问'),
    ('规则保护', '系统规则(is_system=true)不可删除，防止误操作破坏核心检测能力'),
    ('审计追踪', '全链路检测记录，agent_traces可观测性追踪'),
    ('数据持久化', 'Docker Volume数据持久化，支持数据库备份恢复'),
]
for title, desc in security_items:
    p = doc.add_paragraph()
    run = p.add_run(f'▸ {title}：')
    run.bold = True
    p.add_run(desc)

# 9. 性能指标
doc.add_heading('9. 性能指标', level=1)
perf_items = [
    ('越狱拦截', 'score=100 ✅'),
    ('PII泄露检测', 'score=100 ✅'),
    ('恶意代码检测', 'score=95 ✅'),
    ('暴力言论检测', 'score=95 ✅'),
    ('金融违规检测', 'score=92 ✅'),
    ('正常内容放行', 'action=allow ✅'),
    ('语义风险捕获', '裁判模型成功捕获规则漏检的语义风险 ✅'),
]
for title, desc in perf_items:
    p = doc.add_paragraph()
    run = p.add_run(f'{title}：')
    run.bold = True
    p.add_run(desc)

doc.add_paragraph()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = p.add_run('— 文档结束 —')
run.font.color.rgb = RGBColor(0x9E, 0x9E, 0x9E)

# 保存
docx_path = '/home/ubuntu/.openclaw/workspace/GuardLLM_平台架构文档.docx'
doc.save(docx_path)
print(f"Word文档已保存: {docx_path}")
