# 两地三中心部署与验收

配置面向三个独立 Kubernetes 集群：A、B 位于同城，C 位于异地。`topology.json` 是设计清单，**不是已完成容灾验收的证明**。A、B 网关和应用双活，数据库只允许一个写主。中心内部署三个带 `topology.kubernetes.io/zone` 标签的故障域，并按主机分散副本；中心只有一个可用区时应使用真实机架故障域标签调整模板，不得给同一故障域贴三个虚假标签。

## 部署配置

主 Chart：`deploy/helm/guardllm`。合并顺序为默认值 → 中心 overlay → 一个设备 overlay → 环境私有配置。每个中心的私有配置分别注入镜像摘要、数据库读写服务、Redis、PKI、审计、对象存储与签名验证密钥。共享身份验证/内容哈希密钥必须同版本，密钥不写入仓库。

```sh
helm template guardllm deploy/helm/guardllm -f deploy/ha/two-region-three-center/center-a.yaml -f deploy/helm/guardllm/values-nvidia-example.yaml -f /secure/center-a.yaml > /tmp/guardllm-center-a.yaml
kubectl --context guardllm-center-a apply --dry-run=server -f /tmp/guardllm-center-a.yaml
```

B 可以采用 `values-ascend-example.yaml`，C 可以采用经认证的 CPU 或 NPU 配置。设备 overlay 必须匹配模型镜像、设备插件、RuntimeClass 和模型文件；不能沿用CUDA镜像直接部署Ascend。多个设备池可配置为独立检测后端，按已有判别模型/兼容性配置接入；路由故障切换只选择通过相同质量门禁的后端。

C 默认只预热检测服务，应用、网关和会产生业务副作用的worker全部禁用。该模板不会自动提升数据库或切换生产DNS。启动时使用一份已审核的灾备激活配置显式启用各workload，并恢复到A/B相同的副本与HPA设置。

## 数据层必备条件

现有 `deploy/ha/postgresql-cnpg.yaml` 只描述中心内集群，**不包含跨中心同步或防双主配置**。部署跨集群 PostgreSQL 复制必须根据已安装 CNPG 版本配置 replica cluster、物理复制凭据、TLS、外部集群服务发现和WAL归档。同城同步策略必须等待B侧确认；当B不可达时阻止写入，不能设置自动退化异步却仍宣称RPO=0。各中心独立etcd，数据库写权限由唯一权威和fencing控制。

异地异步复制同时覆盖数据库WAL、归档对象、密钥版本和签名策略；Redis限流/会话状态切换后重建或同步，Kafka镜像偏移需要对账，搜索通过持久化数据重建。网关就绪需依赖当前签名策略及所有必需检测器，服务存活探针不等于可接生产流量。

## 巡检接入

部署 node-exporter、设备厂商exporter、PostgreSQL/Redis/Kafka/对象存储exporter，由中心内Prometheus采集。控制台 `运维巡检` 通过允许的 `OPERATIONS_PROMETHEUS_URL` 获取固定查询：CPU、内存、文件系统和 `up`。需要鉴权时将 `OPERATIONS_PROMETHEUS_TOKEN` 放入运行secret。`OPERATIONS_MONITOR_ALLOWED_HOSTS` 必须包含准确主机名。监控网络策略应允许应用访问9090并保证Prometheus入口也允许连接。

## 演练步骤与回切

1. 记录环境版本、签名包、最后成功请求、提交LSN、回放LSN、对象版本、审计链末端及正常吞吐。
2. 单Pod/主机故障：观察健康摘除、PDB、重建和任务幂等。每个生产中心剩余容量须能承载全部峰值流量。
3. 同城中心/网络分区：先冻结变更并隔离旧主写入，再核实同步确认点，授权提升和修改唯一读写入口。证明全过程只有一个可写主。
4. 异地灾备：记录实际复制滞后及可能丢失的事务，核对密钥、策略签名、对象摘要、租户隔离和审计可写。激活C服务后灰度1%→10%→50%→100%。
5. 队列恢复：按幂等键核对评测、导出、回调等任务，确认历史任务不会重复产生外部副作用。
6. 异构后端故障：模拟单池不可达，核验备用模型版本、质量门禁、超时和明确降级；必须检测器不可用时拒绝或转人工。
7. 回切：旧主以只读副本重建并追平，重新进行单写主切换，再恢复流量。禁止将旧主直接重新接流量。

目标：同城RPO=0、RTO≤300秒；异地RPO≤900秒、RTO≤1800秒。将每次演练时间线、观测数据、实际RPO/RTO和对账结果写入新的验收目录。未演练的目标保持“待验收”。
