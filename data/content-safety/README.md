# 内容安全词库工作区

本目录是独立于平台业务代码的内容安全数据控制面。平台检测引擎只消费经过校验、评测、审批和签名发布的不可变策略包，不直接读取 `raw/`、`staged/` 或人工编辑中的 JSONL。

## 目录边界

- `lexicon/content-safety-lexicon.v1.jsonl`：权威工作词库；当前为候选版本，条目未启用硬拦截。
- `lexicon/content-safety-lexicon.schema.json`：词库交换格式约束。
- `lexicon/releases/*.shadow.json`：离线回放和影子评测产物；未签名，禁止生产加载。
- `sources/raw/`：只读外部原始资料，内容由 `sources.lock.json` 的字节数和 SHA-256 固定。
- `sources/staged/`：自动导入的待审核候选词，不能直接编译进生产规则。
- `reports/`：完整性、覆盖度、导入和评测报告。

## 本地流水线

```bash
pnpm lexicon:verify-sources
pnpm lexicon:validate
pnpm lexicon:import-candidates
pnpm lexicon:compile-shadow
pnpm lexicon:generate-hard-negatives
pnpm lexicon:evaluate-shadow
```

`pnpm lexicon:validate-production` 是发布门禁；在 10,000 条有效关键词、A1/A2 分类最低覆盖、误杀/漏检评测和签名发布条件未满足时，应当失败。

## 白名单安全原则

白名单只能抑制指定词条产生的局部词法命中，不能关闭语义模型、强制规则、隐私检测或其他风险维度。平台 `RuleExceptionSpec` 已增加目标规则 ID、输入/输出方向和有效期；引擎只移除位于白名单完整短语范围内的目标规则命中，同一文本中的其他命中继续保留。影子编译器还会排除 `forbidden_risk_ids`，支持性路由规则不会被误编译成豁免。

## 晋级原则

整组 release-set 的事务导入、独立审批、编译源选择和精确回滚已实现，入口为 /dictionaries；需先部署数据库迁移 0042 / 0043。集合状态变化不直接切换实时策略。实际运行条件与未完成验收见项目输出目录的 23 号续做记录。原始 master / staged 文件仍不能绕过转换及审核直接发布。

外部词先进入 `needs_review`；完成来源许可、分类、歧义、反例、对抗变体、输入/输出双向和回归评测后，才能合并到主词库并改为 `active`。生产环境只加载签名策略包，并保留版本回滚能力。
