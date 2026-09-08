# 多格式工程测试运行器

这些测试使用合成内容，验证解码、上传、权限和前后端联通。它们不生成独立安全验收资格，不替代 ASR/VLM/裁判质量测试。

## 隔离条件

应用、数据库、对象存储及后台 Worker 均须使用独立测试实例。先迁移测试数据库并发布测试策略，设置实际对象存储地址及服务密钥；检查 DATABASE_URL、PGDATABASE_URL、COZE_SUPABASE_DB_URL 都指向隔离实例。不要复用生产密钥、使用生产库或将配置占位符当作有效值。

本轮通过的实例是本机 58089 应用、5438 数据库及 59000 对象存储；对应凭据只保存在被忽略的 `.artifact-build`，未提交。本轮测试策略仅为开发环境自签资格。

在 `<run-dir>/fixture.private.json` 中放置下列字段，文件不得提交：

```json
{
  "scope": "ISOLATED_CLONE_ENGINEERING_ONLY",
  "baseURL": "http://127.0.0.1:58089",
  "username": "test-owner",
  "password": "FROM_TEST_SECRET_STORE",
  "other": { "username": "same-tenant-other-owner", "password": "FROM_TEST_SECRET_STORE" },
  "foreign": { "username": "other-tenant-owner", "password": "FROM_TEST_SECRET_STORE" }
}
```

三个账号需有测试应用的 `guard:use` 权限。other 必须属于同一应用的另一主体，foreign 必须属于另一租户。密码可含任意合法字符，脚本读取 JSON，不拼接成 shell 命令。

## 生成与验证解码资产

本次实测的 45 个有效合成文件已保存于 `tests/fixtures/multiformat`，可按 manifest 校验后复制到 `<run-dir>/format-fixtures`；无需复用任何业务附件。

1. 使用已安装 Pillow、python-docx、openpyxl、python-pptx 的 Python 运行 `generate-fixtures.py <run-dir>/format-fixtures`，生成普通文件、两页 PDF/TIFF、两帧 GIF、隐藏工作表及 PPTX 备注。
2. 构建 `services/media-analyzer/Dockerfile` 镜像。所有解码测试使用 `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`，为 `/tmp` 配置受限 tmpfs，并设置内存/CPU/PID 限制。
3. 在容器内挂载合成文件到 `/fixtures`、结果目录到 `/results`，运行 `audio-video-codec-smoke.mjs` 和 `generate-extra-formats.mjs`。前者生成/解码 19 个音视频容器，后者生成 6 个旧 Office/ODF 文件及 PCM。
4. HEIC/AVIF 使用有明确来源的实际编码样本；本轮使用合成图像转换出的样本，不能简单改扩展名。上述生成器不会假装生成这两个格式。
5. `pnpm exec esbuild scripts/integration/multiformat/codec-smoke.ts --bundle --platform=node --format=esm --outfile=<run-dir>/codec-smoke.mjs`。容器内 `/fixtures` 只读、`/results` 可写，运行打包脚本。它检查实际页数，隐藏工作表/PPTX 备注缺失会失败。每个扩展格式仍需更广泛的 profile 鉴定。

原始 PCM 样本为 16kHz、双声道、s16le；上传脚本显式携带参数。GB18030 样本文件名以 `legacy-` 开头，其余文本默认 UTF-8/BOM。

## 真实上传与浏览器

依次运行，以免互相干扰应用限流：

```powershell
node scripts/integration/multiformat/browser-smoke.mjs <run-dir>
pnpm exec tsx scripts/integration/multiformat/security-smoke.ts <run-dir>
pnpm exec tsx scripts/integration/multiformat/upload-matrix.ts <run-dir>
```

浏览器脚本验证登录、聊天和文档入口、普通文本与 SRT 双附件上传接受及真实 Worker 完成；后端仅返回任务 ID 而未执行完成时测试失败。security-smoke 验证两个作用域的拒绝、不可覆盖写入和 17MiB 文件的分片一致性。upload-matrix 遍历格式样本并增加伪装图片、末尾坏编码和全文件哈希错误三项拒绝用例。

脚本会产生测试数据，仅在隔离实例执行。保留脱敏的结果及源码/镜像摘要；结束后停止自己的隔离进程，按测试环境生命周期清理临时实例。不得批量停止生产容器。

## 语义质量

`pnpm detection:multiformat-quality` 的输入是实际运行结果及审定标签。缺少独立集、双人复核、来源隔离或运行身份时返回 BLOCKED/退出码 2。示例、单元测试中的合成全对数据和本目录生成的格式文件都不能用来宣称产品 FPR/FDR 达标。
