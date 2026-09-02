# 🛡️ GuardLLM - 大模型安全护栏检测平台

**企业级大模型安全护栏检测与评估系统**

支持输入/输出双向检测、16维度风险识别、灵活策略配置、A/B对比评估，提供完整的检测记录和统计分析能力。

---

## 目录

- [项目架构](#项目架构)
- [核心功能](#核心功能)
- [快速开始](#快速开始)
- [部署指南](#部署指南)
- [数据库配置](#数据库配置)
- [环境变量](#环境变量)
- [API文档](#api文档)
- [代码迁移](#代码迁移)

---

## 项目架构

### 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         前端层 (Next.js 16)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ 检测工作台 │ │ 策略配置  │ │ 检测看板  │ │ 历史记录  │ │ 文档检测  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ 模型管理  │ │ A/B对比  │ │ 白名单   │ │ 维度配置  │ │ 规则库   │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API 路由层                                  │
│  /api/detect │ /api/policies │ /api/stats │ /api/document-scan     │
│  /api/providers │ /api/whitelist-rules │ /api/history │ /api/export│
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       核心业务层                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Guardrail Orchestrator                    │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │   │
│  │  │ Rule Engine │  │ PII Masker  │  │ Rewrite Eng │         │   │
│  │  │  (规则引擎)  │  │  (脱敏引擎)  │  │  (改写引擎)  │         │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘         │   │
│  │                                                              │   │
│  │  ┌─────────────┐  ┌───────────────────────────────────────┐│   │
│  │  │ Doc Parser  │  │        16维度检测器 (Detectors)        ││   │
│  │  │  (文档解析)  │  │ Prompt Injection │ PII Leak │ Code...││   │
│  │  └─────────────┘  └───────────────────────────────────────┘│   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        外部服务层                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      LLM Gateway                             │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐    │   │
│  │  │DeepSeek│ │  Kimi  │ │  豆包  │ │ OpenAI │ │ 通义   │    │   │
│  │  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              数据库 (PostgreSQL / Supabase)                  │   │
│  │  policies │ rules │ sessions │ findings │ providers │ ...  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 目录结构

```
GuardLLM/
├── src/
│   ├── app/                          # Next.js App Router 页面
│   │   ├── api/                      # API 路由
│   │   │   ├── detect/               # 文本检测接口
│   │   │   ├── policies/             # 策略管理接口
│   │   │   ├── document-scan/        # 文档检测接口
│   │   │   ├── whitelist-rules/      # 白名单接口
│   │   │   ├── providers/            # LLM供应商接口
│   │   │   ├── stats/                # 统计数据接口
│   │   │   └── history/              # 历史记录接口
│   │   ├── page.tsx                  # 首页 - 检测工作台
│   │   ├── dashboard/                # 检测看板
│   │   ├── history/                  # 历史记录
│   │   ├── policies/                 # 策略配置
│   │   ├── document-scan/            # 文档检测
│   │   ├── whitelist/                # 白名单管理
│   │   └── providers/                # 模型管理
│   │
│   ├── components/                   # React 组件
│   │   ├── ui/                       # shadcn/ui 基础组件
│   │   └── layout/                   # 布局组件
│   │
│   ├── lib/                          # 核心业务库
│   │   ├── detection/                # 检测引擎
│   │   │   ├── dynamic-engine.ts     # 动态检测引擎主逻辑
│   │   │   ├── types.ts              # 类型定义
│   │   │   └── recorder.ts           # 检测记录器
│   │   ├── llm/                      # LLM 网关
│   │   │   ├── gateway.ts            # 统一网关入口
│   │   │   └── providers/            # 各模型适配器
│   │   ├── document-parser/          # 文档解析器
│   │   │   ├── pdf-parser.ts         # PDF解析
│   │   │   └── docx-parser.ts        # DOCX解析
│   │   └── utils.ts                  # 工具函数
│   │
│   └── storage/                      # 数据存储层
│       └── database/                 # 数据库配置
│           ├── index.ts              # 数据库连接
│           └── shared/
│               └── schema.ts         # 数据库表结构定义
│
├── scripts/                          # 脚本目录
│   ├── build.sh                      # 构建脚本
│   ├── start.sh                      # 启动脚本
│   └── init-database.sql             # 数据库初始化SQL
│
├── public/                           # 静态资源
├── .env.example                      # 环境变量示例
├── docker-compose.yml                # Docker Compose 配置
├── Dockerfile                        # Docker 构建文件
├── .coze                             # Coze 平台配置
├── package.json                      # 项目依赖
└── tsconfig.json                     # TypeScript 配置
```

### 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| **框架** | Next.js (App Router) | 16.x |
| **语言** | TypeScript | 5.x |
| **UI组件** | shadcn/ui (Radix UI) | 最新 |
| **样式** | Tailwind CSS | 4.x |
| **数据库** | PostgreSQL / Supabase | 12+ |
| **ORM** | Drizzle ORM | 最新 |
| **图表** | Recharts | 2.x |
| **图标** | Lucide React | 最新 |
| **包管理** | pnpm | 9+ |

---

## 核心功能

### 检测能力

| 功能 | 描述 |
|------|------|
| **双向检测** | 支持用户输入检测和模型输出检测 |
| **16维度风险识别** | 提示词注入、PII泄露、恶意代码、暴力仇恨、非法内容等 |
| **置信度评分** | 每个维度输出风险分数(0-100)和置信度 |
| **文档检测** | 上传 TXT/MD/PDF/DOCX，自动解析检测，生成风险报告 |
| **PII自动脱敏** | 手机号、身份证、银行卡、邮箱等自动脱敏 |
| **安全改写** | 危险内容自动改写为安全表达 |

### 管理功能

| 功能 | 描述 |
|------|------|
| **灵活策略配置** | 自定义警告/阻断阈值、处理动作、开关控制 |
| **A/B策略对比** | 选择两个策略对比测试，展示差异分析 |
| **白名单管理** | 策略范围+维度范围双重配置，优先级控制 |
| **多模型接入** | 支持 DeepSeek、Kimi、豆包、OpenAI 等 |
| **实时统计看板** | 总请求数、拦截率、风险分布、趋势图 |
| **完整历史记录** | 检测记录查询、多条件筛选、详情查看 |
| **多格式导出** | JSON/CSV/Markdown 报告导出 |

### 处理动作

| 动作 | 说明 |
|------|------|
| `allow` | 放行，内容安全 |
| `warn` | 警告，存在风险但允许通过 |
| `mask` | 脱敏，敏感信息已替换 |
| `rewrite` | 改写，内容已安全化处理 |
| `block` | 拦截，拒绝处理 |

### 16风险维度

| 维度代码 | 维度名称 | 说明 |
|----------|----------|------|
| `prompt_injection` | 提示词注入 | 尝试绕过系统限制 |
| `pii_leak` | 信息泄露 | 个人隐私信息泄露 |
| `malicious_code` | 恶意代码 | 生成恶意代码风险 |
| `violence_hate` | 暴力仇恨 | 涉及暴力或仇恨言论 |
| `illegal_content` | 非法内容 | 涉及违法犯罪内容 |
| `spam_detection` | 垃圾信息 | 营销推广等垃圾内容 |
| `ad_detection` | 广告检测 | 商业广告内容 |
| `sensitive_compliance` | 敏感合规 | 涉及敏感话题或合规风险 |
| `adult_content` | 成人内容 | 涉及成人或色情内容 |
| `self_harm` | 自残倾向 | 涉及自残或自杀内容 |
| `credential_secret_leak` | 凭证泄露 | API密钥、密码等泄露 |
| `fraud_scam` | 欺诈诈骗 | 涉及欺诈或诈骗行为 |
| `misinformation` | 虚假信息 | 可能传播虚假信息 |
| `copyright_risk` | 版权风险 | 可能侵犯版权的内容 |
| `business_sensitive` | 商业敏感 | 涉及商业机密信息 |
| `output_leak` | 输出泄露 | 模型输出中的敏感信息 |

---

## 快速开始

### 环境要求

- Node.js 18+ (推荐 20+)
- pnpm 9+
- PostgreSQL 12+ 或 Supabase

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/your-org/GuardLLM.git
cd GuardLLM

# 2. 安装依赖
pnpm install

# 3. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 填入配置

# 4. 初始化数据库
psql -U username -d guardllm -f scripts/init-database.sql

# 5. 启动开发服务器
pnpm dev
```

访问 http://localhost:5000

---

## 部署指南

### 方式一：Docker Compose 部署（推荐）

最简单的部署方式，包含数据库和应用。

#### 1. 准备配置

```bash
# 创建环境变量文件
cat > .env << 'EOF'
# 数据库配置
DB_USER=guardllm
DB_PASSWORD=your_secure_password
DB_NAME=guardllm
DB_PORT=5432
DATABASE_URL=postgres://guardllm:your_secure_password@postgres:5432/guardllm

# 应用配置
APP_PORT=5000

# LLM配置（至少配置一个）
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL_NAME=deepseek-chat

# 安全配置
ENCRYPTION_KEY=your-random-encryption-key
EOF
```

#### 2. 一键启动

```bash
# 构建并启动
docker compose up -d

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f app
```

#### 3. 验证部署

```bash
# 健康检查
curl http://localhost:5000/api/health

# 检查数据库
docker exec guardllm-db pg_isready -U guardllm
```

#### 常用命令

```bash
# 停止服务
docker compose down

# 重启服务
docker compose restart

# 重新构建
docker compose build --no-cache

# 查看日志
docker compose logs -f --tail=100 app

# 备份数据库
docker exec guardllm-db pg_dump -U guardllm guardllm > backup.sql
```

---

### 方式二：Docker 单独部署

适用于已有 PostgreSQL 数据库的场景。

#### 1. 构建镜像

```bash
docker build -t guardllm:latest .
```

#### 2. 运行容器

```bash
docker run -d \
  --name guardllm-app \
  -p 5000:5000 \
  -e DATABASE_URL="postgres://user:password@host:5432/guardllm" \
  -e LLM_API_KEY="your-api-key" \
  -e LLM_BASE_URL="https://api.deepseek.com/v1" \
  -e LLM_MODEL_NAME="deepseek-chat" \
  -e ENCRYPTION_KEY="your-random-key" \
  guardllm:latest
```

---

### 方式三：传统服务器部署

#### 1. 构建生产版本

```bash
pnpm build
```

#### 2. 使用 PM2 管理

```bash
# 安装 PM2
pnpm add --global pm2

# 启动服务
pm2 start pnpm --name "guardllm" -- start

# 设置开机自启
pm2 startup
pm2 save
```

#### 3. Nginx 反向代理

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

### 方式四：Vercel 部署

```bash
# 安装 Vercel CLI
pnpm add --global vercel

# 部署
vercel --prod
```

在 Vercel 项目设置中配置环境变量。

---

## 数据库配置

### 表结构（22张表）

| 表名 | 说明 |
|------|------|
| `detection_dimensions` | 检测维度定义 |
| `detection_rules` | 检测规则库 |
| `policy_profiles` | 策略配置 |
| `policy_versions` | 策略版本历史 |
| `policy_rules` | 策略-规则关联 |
| `policy_dimension_config` | 策略维度配置 |
| `whitelist_rules` | 白名单规则 |
| `whitelist_rule_policies` | 白名单-策略关联 |
| `llm_providers` | LLM供应商配置 |
| `detection_sessions` | 检测会话记录 |
| `detection_records` | 检测详细记录 |
| `risk_findings` | 风险发现记录 |
| `document_scan_tasks` | 文档扫描任务 |
| `document_scan_findings` | 文档扫描发现 |
| `test_cases` | 测试用例 |
| `evaluation_runs` | 评估运行记录 |
| `keyword_categories` | 关键词分类 |
| `keyword_rules` | 关键词规则 |
| `rule_groups` | 规则组 |
| `agent_logs` | Agent日志 |
| `agent_traces` | Agent追踪 |
| `health_check` | 健康检查 |

### 初始化数据库

```bash
# 方式一：使用 SQL 脚本（推荐）
psql -U username -d guardllm -f scripts/init-database-new.sql
psql -U username -d guardllm -f scripts/init-database-supplement.sql

# 方式二：Docker 环境中执行
docker exec -i guardllm-db psql -U guardllm -d guardllm < scripts/init-database-new.sql
docker exec -i guardllm-db psql -U guardllm -d guardllm < scripts/init-database-supplement.sql
```

### 初始数据说明

SQL 脚本已包含以下初始数据：

| 数据 | 数量 | 说明 |
|------|------|------|
| 检测维度 | 16 | 16个风险检测维度 |
| 检测规则 | 86 | 关键词/正则规则 |
| 策略配置 | 3 | 宽松/默认/严格策略 |
| LLM供应商 | 1 | 默认配置模板 |
| 白名单规则 | 1 | 示例规则 |
| 用户账户 | 3 | admin/user1/user2 |

### 默认账户

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 管理员 |
| user1 | user123 | 普通用户 |
| user2 | user123 | 普通用户 |

> ⚠️ **安全提示**：生产环境请务必修改默认密码！

---

## 数据库移植脚本

项目提供多个 SQL 脚本用于数据库初始化和迁移，位于 `scripts/` 目录：

### 脚本文件说明

| 脚本文件 | 用途 | 使用场景 |
|----------|------|----------|
| `init-database-new.sql` | **完整初始化脚本** | 新项目首次部署，创建所有表并导入初始数据 |
| `init-database-supplement.sql` | **补充初始化脚本** | 创建用户表、策略升级表、裁判模型表，必须在主脚本后执行 |
| `init-db.sql` | 基础表结构 | 仅创建核心表，不含初始数据 |
| `migrate-document-scan.sql` | 文档扫描迁移 | 添加文档扫描相关表结构 |
| `migrate-whitelist.sql` | 白名单迁移 | 添加白名单相关表结构和数据 |

### 使用指南

#### 场景一：全新部署（推荐）

```bash
# 1. 创建数据库
psql -U postgres -c "CREATE DATABASE guardllm;"

# 2. 执行完整初始化脚本
psql -U postgres -d guardllm -f scripts/init-database-new.sql

# 3. 执行补充脚本（创建用户表、策略升级表等）
psql -U postgres -d guardllm -f scripts/init-database-supplement.sql

# 完成！数据库已包含所有表结构和初始数据
```

#### 场景二：Docker 环境初始化

```bash
# 启动数据库容器后执行
docker exec -i guardllm-db psql -U guardllm -d guardllm < scripts/init-database-new.sql
docker exec -i guardllm-db psql -U guardllm -d guardllm < scripts/init-database-supplement.sql
```

#### 场景三：从旧版本迁移

如果已运行旧版本，需要增量迁移：

```bash
# 1. 备份现有数据
pg_dump -U postgres guardllm > backup_$(date +%Y%m%d).sql

# 2. 执行迁移脚本
psql -U postgres -d guardllm -f scripts/migrate-document-scan.sql
psql -U postgres -d guardllm -f scripts/migrate-whitelist.sql
```

### 脚本执行顺序

```
init-database.sql          # 完整初始化（包含以下所有内容）
├── 创建 uuid-ossp 扩展
├── 创建 22 张数据表
├── 插入 detection_dimensions（16条）
├── 插入 detection_rules（86条）
├── 插入 policy_profiles（3条）
├── 插入 policy_dimension_config
├── 插入 whitelist_rules
└── 插入 llm_providers

# 如果使用增量迁移，按以下顺序执行：
init-db.sql                        # 基础表结构
migrate-document-scan.sql          # 文档扫描功能
migrate-whitelist.sql              # 白名单功能
```

### 注意事项

1. **幂等性**：`init-database.sql` 使用 `DROP TABLE IF EXISTS`，重复执行会清空数据
2. **UUID 扩展**：需要先确保 PostgreSQL 安装了 `uuid-ossp` 扩展
3. **数据备份**：迁移前务必备份现有数据
4. **版本兼容**：迁移脚本基于特定版本编写，跨版本迁移需检查字段差异

### 验证初始化

```bash
# 检查表是否创建成功
psql -U postgres -d guardllm -c "\dt"

# 检查初始数据
psql -U postgres -d guardllm -c "SELECT COUNT(*) FROM detection_dimensions;"
psql -U postgres -d guardllm -c "SELECT COUNT(*) FROM detection_rules;"
```

---

## 环境变量

### 必填变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `DATABASE_URL` | PostgreSQL 连接URL | `postgres://user:pass@host:5432/db` |

### LLM 配置（至少配置一个）

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `LLM_API_KEY` | API密钥 | `sk-xxx` |
| `LLM_BASE_URL` | API地址 | `https://api.deepseek.com/v1` |
| `LLM_MODEL_NAME` | 模型名称 | `deepseek-chat` |

### 可选变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key | - |
| `KIMI_API_KEY` | Kimi API Key | - |
| `OPENAI_API_KEY` | OpenAI API Key | - |
| `ENCRYPTION_KEY` | 加密密钥 | - |
| `NEXT_PUBLIC_APP_URL` | 应用URL | `http://localhost:5000` |

### Supabase 配置（如使用 Supabase）

| 变量名 | 说明 |
|--------|------|
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_ANON_KEY` | Supabase 匿名密钥 |

---

## API文档

### 核心接口

#### 文本检测

```http
POST /api/detect
Content-Type: application/json

{
  "text": "待检测文本",
  "direction": "input",
  "policyId": "default-policy"
}
```

**响应：**

```json
{
  "success": true,
  "data": {
    "overallScore": 85,
    "confidence": 0.88,
    "action": "block",
    "findings": [
      {
        "dimension": "prompt_injection",
        "score": 85,
        "evidence": ["忽略之前"],
        "reason": "检测到提示词注入风险"
      }
    ]
  }
}
```

#### 文档检测

```http
POST /api/document-scan
Content-Type: multipart/form-data

file: <文件>
policyId: default-policy
```

#### 策略管理

```http
GET    /api/policies           # 获取策略列表
GET    /api/policies/:id       # 获取策略详情
POST   /api/policies           # 创建策略
PUT    /api/policies/:id       # 更新策略
DELETE /api/policies/:id       # 删除策略
```

#### A/B 对比

```http
POST /api/policies/compare
Content-Type: application/json

{
  "policyAId": "lenient-policy",
  "policyBId": "strict-policy",
  "text": "测试文本"
}
```

#### 白名单管理

```http
GET    /api/whitelist-rules           # 获取列表
POST   /api/whitelist-rules           # 创建规则
PUT    /api/whitelist-rules/:id       # 更新规则
DELETE /api/whitelist-rules/:id       # 删除规则
POST   /api/whitelist-rules/test      # 测试匹配
```

#### 统计与历史

```http
GET /api/stats                        # 获取统计数据
GET /api/history?page=1&limit=20      # 获取历史记录
```

---

## 代码迁移

### 迁移步骤

1. **克隆代码**

```bash
git clone https://github.com/your-org/GuardLLM.git
cd GuardLLM
```

2. **安装依赖**

```bash
pnpm install
```

3. **配置环境**

```bash
cp .env.example .env.local
# 编辑 .env.local
```

4. **初始化数据库**

```bash
psql -U username -d your_database -f scripts/init-database.sql
```

5. **启动服务**

```bash
pnpm dev
```

### 注意事项

1. **数据库版本**：需要 PostgreSQL 12+，并启用 `uuid-ossp` 和 `pgcrypto` 扩展

2. **Node.js版本**：推荐使用 Node.js 20+

3. **包管理器**：必须使用 pnpm，不支持 npm/yarn

4. **端口配置**：默认端口 5000，通过 `DEPLOY_RUN_PORT` 环境变量修改

### 自定义配置

#### 修改端口

```bash
# .env.local
DEPLOY_RUN_PORT=3000
```

#### 添加新的检测维度

1. 在 `detection_dimensions` 表添加维度记录
2. 在 `detection_rules` 表添加对应规则
3. 更新策略配置 `policy_dimension_config`

#### 添加新的 LLM 供应商

1. 在 `src/lib/llm/providers/` 创建适配器
2. 实现 `LLMProvider` 接口
3. 在 `gateway.ts` 注册

---

## License

MIT License

---

## 致谢

- [Next.js](https://nextjs.org/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Supabase](https://supabase.com/)
- [Recharts](https://recharts.org/)
- [Lucide Icons](https://lucide.dev/)
