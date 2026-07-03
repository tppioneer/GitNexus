# Telecom Ops Platform 代码规模扩展补充蓝图

## 1. 目的

本文档是 [telecom-ops-platform-blueprint.md](./telecom-ops-platform-blueprint.md) 的补充，专门解决当前实现已经具备核心结构，但 Java 代码规模仍不足 10000+ 行的问题。

目标不是机械堆行数，而是通过**有效复杂度**扩大项目规模，让 GitNexus vs grep 的 benchmark 更有区分度。

## 2. 当前基线

基于 `F:\develop\codes\Gitnexus-case-project` 当前快照统计。

> 注意：该项目正在由代码生成模型持续扩展，下面数据是阶段性基线。每次执行扩容 goal 前，应按第 10 节命令重新统计一次，不要机械沿用本节数字。

| 指标 | 当前值 | 原蓝图下限 | 状态 |
| --- | ---: | ---: | --- |
| Main Java 类 | 155 | 100 | 已达标 |
| Test Java 类 | 57 | 25 | 已达标 |
| Java 总行数 | 7156 | 10000 | 未达标 |
| Maven 测试 | `mvn test` 通过 | 通过 | 已达标 |
| Benchmark YAML | 3 case + 3 ground truth | 需要 | 已达标 |
| JSON fixture | 6+ | 6 | 已达标 |

当前缺口：

```text
10000 - 7156 = 2844 行左右
```

考虑后续生成波动，建议目标不是刚好补 2844 行，而是补到 **10500 到 11500 行**，给后续重构和删减留余量。

推荐新增有效 Java 行数：

```text
3500 到 4500 行
```

## 3. 为什么仍需要扩容

当前项目已经能证明基本结构，但对 benchmark 的说服力仍有限：

- grep 噪音还不够大，`evaluate`、`regionCode`、`publish`、`process` 等关键词结果不会特别多。
- 关键链路虽然存在，但旁路流程偏少，AI 用少量 Read 也能较快拼出答案。
- Case C 的字段传播已经设计得好，但实际 fixture、mapper、查询条件、导出逻辑仍可增加。
- 第二批 case 的支撑代码还较薄，难以扩展成 8 到 10 个稳定 benchmark case。

扩容应优先增加：

1. 与现有三大 case 相关的真实旁路复杂度。
2. 第二批可扩展 case 的支撑代码。
3. 能制造 grep 噪音但不会破坏 ground truth 的同名方法。
4. 能让 GitNexus 图谱捕获更多结构关系的接口、实现、调用链、字段访问、mapper、测试。

## 4. 扩容原则

### 4.1 必须做

- 每个新增类都要属于明确业务模块。
- 每个新增 service 至少有 2 到 4 个 public 方法。
- 每个新增 mapper / validator / policy 都要被某个 service 或 controller 调用。
- 每个新增领域分支至少配一个测试或被现有测试覆盖。
- 保持 `mvn test` 通过。
- 保持 6 个模块的 Maven 依赖矩阵不变。
- 保持 benchmark 的 ground truth 清晰，不让新增旁路污染核心链路。

### 4.2 禁止做

- 禁止新增空类。
- 禁止靠注释堆行数。
- 禁止大量只包含 getter/setter 的无业务 DTO。
- 禁止把无关算法题塞进项目。
- 禁止引入真实外部中间件。
- 禁止让 `common-domain` 依赖任一 service module。
- 禁止让新增代码改变 Case A/B/C 的目标答案，除非同步更新 ground truth。

## 5. 推荐扩容配额

| 模块 | 当前类数 | 推荐新增类 | 推荐新增行数 | 扩展重点 |
| --- | ---: | ---: | ---: | --- |
| `common-domain` | 34 | 8 到 10 | 700 到 900 | 审计、SLA、维护窗口、更多事件元数据 |
| `device-collector-service` | 34 | 10 到 12 | 900 到 1100 | 采集计划、批量导入、异常设备、厂商告警适配 |
| `alarm-engine-service` | 44 | 10 到 12 | 1000 到 1200 | 抑制规则、维护窗口、告警升级、更多 evaluate 噪音 |
| `workorder-service` | 39 | 10 到 12 | 1000 到 1200 | `WAITING_VENDOR` 状态、供应商协同、SLA breach |
| `notification-service` | 24 | 8 到 10 | 700 到 900 | 模板变量、渠道失败重试、通知规则 |
| `ops-gateway-service` | 24 | 8 到 10 | 700 到 900 | Dashboard drill-down、导出、健康评分 |
| **合计** | **199 总 Java 类** | **54 到 66** | **5000 左右** | 目标总行数 10500+ |

说明：

- `当前类数` 指当前 Java 文件数（main + test），不是单独的 main 类数量。
- 该配额来自较早基线，若扩容前项目已经继续增长，应以第 10 节命令重新统计为准。
- 当前更稳妥的目标是新增 **3500 到 4500 行有效 Java 代码**；如果按本表全部实现，最终可能达到 11500+ 行，允许超出。

## 6. 模块扩展设计

### 6.1 `common-domain` 扩展

新增类建议：

| 类 | 类型 | 用途 |
| --- | --- | --- |
| `MaintenanceWindow` | Domain | 设备维护窗口，供告警抑制使用 |
| `MaintenanceWindowEvent` | Event | 维护窗口变更事件 |
| `SlaPolicy` | Domain | 工单 SLA 策略 |
| `SlaBreachEvent` | Event | SLA 超时事件 |
| `VendorTicket` | Domain | 厂商协同单 |
| `EscalationLevel` | Enum | 升级等级 |
| `NotificationPreference` | Domain | 人员通知偏好 |
| `DeviceLifecycleStatus` | Enum | 设备生命周期状态 |
| `ExportJob` | Domain | 看板导出任务 |
| `OperationResult` | DTO | 统一操作结果 |

有效复杂度要求：

- `MaintenanceWindow` 必须包含 `regionCode` 或 `deviceId`，但它不是 Case C 的修改目标。
- `SlaPolicy` 和 `SlaBreachEvent` 应被 `workorder-service` 使用。
- `VendorTicket` 用于第二批 `WAITING_VENDOR` 状态 case。

建议新增测试：

```text
MaintenanceWindowTest
SlaPolicyTest
VendorTicketTest
```

### 6.2 `device-collector-service` 扩展

新增类建议：

| 类 | 类型 | 用途 |
| --- | --- | --- |
| `CollectorScheduleController` | Controller | 采集计划 API |
| `CollectorScheduleService` | Service | 启停采集计划 |
| `CollectorScheduleRepository` | Repository | 采集计划存储 |
| `CollectorScheduleRequest` | DTO | 采集计划请求 |
| `CollectorScheduleResponse` | DTO | 采集计划响应 |
| `DeviceBatchImportController` | Controller | 批量导入设备 |
| `DeviceBatchImportService` | Service | CSV/JSON 设备导入模拟 |
| `DeviceImportValidator` | Validator | 导入校验 |
| `VendorAlarmAdapter` | Interface | 厂商原生告警适配 |
| `HuaweiVendorAlarmAdapter` | Impl | 华为原生告警适配 |
| `ZteVendorAlarmAdapter` | Impl | 中兴原生告警适配 |
| `VendorAlarmAdapterRegistry` | Registry | 厂商告警 adapter 分发 |

新增同名噪音：

- `CollectorScheduleService.process(...)`
- `DeviceBatchImportService.process(...)`
- `VendorAlarmAdapter.normalize(...)`
- `VendorAlarmAdapterRegistry.resolve(...)`

不要污染 Case A：

- `DeviceMetricIngestController.ingestMetric` 仍是指标入口。
- 批量导入和采集计划不能成为 Case A 的核心链路。
- 这些新增 API 只能作为 grep 干扰和第二批 case 支撑。

建议测试：

```text
CollectorScheduleServiceTest
DeviceBatchImportServiceTest
VendorAlarmAdapterRegistryTest
DeviceImportValidatorTest
```

### 6.3 `alarm-engine-service` 扩展

新增类建议：

| 类 | 类型 | 用途 |
| --- | --- | --- |
| `AlarmSuppressionService` | Service | 维护窗口内告警抑制 |
| `SuppressionRuleEvaluator` | Service | 非 `RuleEvaluator` 的 evaluate 干扰 |
| `MaintenanceWindowService` | Service | 维护窗口查询 |
| `MaintenanceWindowRepository` | Repository | 维护窗口存储 |
| `AlarmEscalationService` | Service | 告警升级 |
| `AlarmEscalationPolicy` | Interface | 告警升级策略 |
| `SeverityAlarmEscalationPolicy` | Impl | 按级别升级 |
| `DurationAlarmEscalationPolicy` | Impl | 按持续时间升级 |
| `AlarmExportController` | Controller | 告警导出 API |
| `AlarmExportService` | Service | 告警导出 |
| `AlarmExportRequest` | DTO | 导出请求 |
| `AlarmExportResponse` | DTO | 导出响应 |

新增同名噪音：

- `SuppressionRuleEvaluator.evaluate(...)`
- `AlarmEscalationPolicy.evaluate(...)`
- `AlarmExportService.process(...)`
- `MaintenanceWindowService.resolve(...)`

Case B 约束：

- 新增的 `SuppressionRuleEvaluator.evaluate`、`AlarmEscalationPolicy.evaluate` 都不能实现 `RuleEvaluator`。
- `RuleEvaluator.evaluate(DeviceMetric, ThresholdRule)` 的目标身份必须保持唯一。
- 如果新增接口也叫 `Evaluator`，ground truth 要明确它不是 Case B 目标。

建议测试：

```text
AlarmSuppressionServiceTest
SuppressionRuleEvaluatorTest
AlarmEscalationServiceTest
AlarmExportServiceTest
```

### 6.4 `workorder-service` 扩展

这是最推荐扩容的模块，因为它能自然支撑第二批 L3 修改 case。

新增类建议：

| 类 | 类型 | 用途 |
| --- | --- | --- |
| `VendorTicketService` | Service | 创建和更新厂商协同单 |
| `VendorTicketRepository` | Repository | 厂商协同单存储 |
| `VendorTicketController` | Controller | 厂商协同 API |
| `VendorTicketMapper` | Mapper | 工单和厂商单转换 |
| `VendorTicketRequest` | DTO | 厂商单请求 |
| `VendorTicketResponse` | DTO | 厂商单响应 |
| `WaitingVendorPolicy` | Policy | 是否进入 `WAITING_VENDOR` |
| `WorkOrderSlaBreachService` | Service | SLA 超时处理 |
| `WorkOrderSlaPolicyRepository` | Repository | SLA 策略存储 |
| `SlaBreachEventPublisher` | Event | 发布 SLA 超时事件 |
| `WorkOrderBulkActionController` | Controller | 批量派单/关闭 |
| `WorkOrderBulkActionService` | Service | 批量操作 |

强烈建议新增状态：

```text
WAITING_VENDOR
```

状态机新增边：

```text
PROCESSING -> WAITING_VENDOR
WAITING_VENDOR -> PROCESSING
WAITING_VENDOR -> RESOLVED
WAITING_VENDOR -> ESCALATED
```

Case D 支撑任务：

```text
新增或修改 WAITING_VENDOR 状态流转规则，并同步更新状态机、Controller、DTO、SLA、VendorTicket 和测试。
```

建议测试：

```text
VendorTicketServiceTest
WaitingVendorPolicyTest
WorkOrderSlaBreachServiceTest
WorkOrderBulkActionServiceTest
WorkOrderStateMachineWaitingVendorTest
```

### 6.5 `notification-service` 扩展

新增类建议：

| 类 | 类型 | 用途 |
| --- | --- | --- |
| `NotificationRule` | Domain | 通知规则 |
| `NotificationRuleRepository` | Repository | 规则存储 |
| `NotificationRuleService` | Service | 规则匹配 |
| `NotificationRetryService` | Service | 失败重试 |
| `NotificationFailureRepository` | Repository | 失败记录 |
| `TemplateVariableResolver` | Interface | 模板变量解析 |
| `AlarmTemplateVariableResolver` | Impl | 告警变量 |
| `WorkOrderTemplateVariableResolver` | Impl | 工单变量 |
| `SlaTemplateVariableResolver` | Impl | SLA 变量 |
| `TemplateVariableRegistry` | Registry | 变量 resolver 分发 |

新增同名噪音：

- `NotificationRuleService.evaluate(...)`
- `TemplateVariableResolver.resolve(...)`
- `NotificationRetryService.process(...)`
- `NotificationChannel.send(...)` 保持作为第二批影响分析 case。

Case E 支撑任务：

```text
修改 NotificationChannel.send(NotificationRequest request) 签名，需要同步三个渠道实现、NotificationService、RetryService、测试。
```

建议测试：

```text
NotificationRuleServiceTest
NotificationRetryServiceTest
TemplateVariableRegistryTest
AlarmTemplateVariableResolverTest
```

### 6.6 `ops-gateway-service` 扩展

新增类建议：

| 类 | 类型 | 用途 |
| --- | --- | --- |
| `DashboardDrilldownController` | Controller | 看板 drill-down API |
| `DashboardDrilldownService` | Service | 设备/告警/工单详情聚合 |
| `DashboardExportController` | Controller | 看板导出 API |
| `DashboardExportService` | Service | 导出任务 |
| `DashboardExportRepository` | Repository | 导出任务存储 |
| `DashboardHealthScoreService` | Service | 健康评分 |
| `DeviceHealthEvaluator` | Service | 非 Case B `evaluate` 干扰 |
| `RegionHealthEvaluator` | Service | 区域健康评分 |
| `DashboardQueryValidator` | Validator | 查询参数校验 |
| `DashboardCacheService` | Service | 简单内存缓存 |

必须修复当前半成品：

- `DeviceClient.fetchDevice(String)` 不应 `return null`。
- `AlarmClient.fetchAlarm(String)` 不应 `return null`。
- `WorkOrderClient.fetchWorkOrder(String)` 不应 `return null`。

推荐改为内存 fake 数据：

```text
private final Map<String, DeviceInfo> devices = new ConcurrentHashMap<>();
public DeviceInfo fetchDevice(String deviceId) { return devices.get(deviceId); }
```

或返回 `Optional<T>`，但不要保留裸 `null`，否则后续图谱分析容易把它当成无意义桩代码。

`return null` 判定规则：

- 允许：明确业务分支，例如 `AutoWorkOrderService.createForAlarm` 对 `INFO` / `WARNING` 告警不创建工单而返回 `null`。
- 不允许：fake client、repository、mapper 或 service 以 `return null` 作为未实现桩代码。
- 如果确实存在“查无结果”语义，优先返回 `Optional<T>` 或空集合。

建议测试：

```text
DashboardDrilldownServiceTest
DashboardExportServiceTest
DashboardHealthScoreServiceTest
DashboardQueryValidatorTest
```

## 7. 第二批 benchmark case 扩展

扩容不只是为了行数，应顺手形成第二批 case。

### 7.0 Case ID 映射

原蓝图已经列出第二批候选 case。本补充蓝图对其中部分 case 做了增强，并新增一个维护窗口 case。为了避免后续 case registry 混乱，统一采用下面映射：

| 最终 Case ID | 来源 | 状态 | 说明 |
| --- | --- | --- | --- |
| `telecom-case-d-workorder-state` | 原 Case D | 保留并增强 | 以 `WAITING_VENDOR` 状态为核心 |
| `telecom-case-e-notification-channel-impact` | 原 Case E | 保留 | 以 `NotificationChannel.send` 签名影响为核心 |
| `telecom-case-f-dashboard-drilldown-flow` | 原 Case F 的增强版 | 重命名增强 | 原 `telecom-case-f-dashboard-flow` 扩展为 drill-down 执行流 |
| `telecom-case-g-vendor-adapter-impact` | 原 Case G | 保留 | 仍用于 `VendorAdapter.normalizeRawMetric` 影响分析 |
| `telecom-case-h-severity-enum-change` | 原 Case H | 保留 | 仍用于 `AlarmRecord.severity` 类型/枚举变更 |
| `telecom-case-i-maintenance-window-suppression` | 本补充蓝图新增 | 新增 | 维护窗口告警抑制 case，避免占用原 G/H 编号 |

后续新增 YAML 时必须使用上表的最终 ID，不要复用旧编号。

### Case D：`WAITING_VENDOR` 状态修改

类型：

```text
L3 - small_code_change
```

任务：

```text
请为工单流转增加 WAITING_VENDOR 状态，允许 PROCESSING -> WAITING_VENDOR，
WAITING_VENDOR -> PROCESSING / RESOLVED / ESCALATED。
同步更新状态机、Controller、DTO、VendorTicket、SLA、测试和 ground truth。
```

验证价值：

- 状态机修改。
- 多服务 DTO / enum 传播。
- 测试覆盖要求高。

### Case E：`NotificationChannel.send` 影响分析

类型：

```text
L2 - impact_analysis
```

任务：

```text
如果给 NotificationChannel.send(NotificationRequest request) 增加 DeliveryContext context 参数，
需要同步检查哪些实现类、调用方、重试逻辑、模板变量解析和测试？
```

验证价值：

- 多实现接口。
- 同名 `send` 噪音。
- Retry / Rule / Template 旁路增加影响面。

### Case F：Dashboard Drill-down 执行流追踪

类型：

```text
L1 - flow_tracing
```

任务：

```text
请分析 GET /api/dashboard/regions/{regionCode}/drilldown 从入口到设备、告警、工单详情聚合的完整调用链。
```

验证价值：

- 聚合型查询链路。
- 多 fake client。
- `regionCode` 干扰字段多，grep 噪音更高。

### Case G：`VendorAdapter.normalizeRawMetric` 影响分析

类型：

```text
L2 - impact_analysis
```

任务：

```text
如果给 VendorAdapter.normalizeRawMetric(RawDeviceMetric rawMetric, DeviceInfo deviceInfo)
增加 VendorContext context 参数，需要同步检查哪些厂商实现、Registry、MetricCollectorService、测试和文档？
```

验证价值：

- 厂商适配多态。
- `normalize` 同名噪音更高。
- 与采集计划、批量导入、厂商原生告警适配形成干扰。

### Case H：`AlarmRecord.severity` 类型收紧

类型：

```text
L3 - small_code_change
```

任务：

```text
请将 AlarmRecord.severity 的写入路径收紧为只能通过 AlarmSeverityClassifier 和指定枚举值生成，
同步检查告警评估、导出、Dashboard、工单优先级映射和测试。
```

验证价值：

- 字段类型和业务规则传播。
- 告警到工单的跨模块影响。
- 与 `SeverityAlarmEscalationPolicy`、`AlarmEscalationPolicy` 形成额外路径。

### Case I：维护窗口告警抑制

类型：

```text
L2 - impact_analysis 或 L3 - small_code_change
```

任务：

```text
请分析如果调整维护窗口内告警抑制逻辑，会影响哪些告警评估、升级、导出、Dashboard 和测试？
```

验证价值：

- 与 Case B 的 `evaluate` 干扰相互增强。
- 增加告警链路旁支。

## 8. 有效行数生成策略

弱模型生成扩容代码时，优先采用以下方式增加有效行数。

### 8.1 每个新增 service 的最小结构

每个 service 至少包含：

- 构造函数注入依赖。
- 3 个 public 方法。
- 1 个 private helper。
- 至少 1 个字段传递或状态判断。
- 至少 1 个 repository / registry / mapper 调用。
- 对应测试覆盖核心分支。

示例：

```text
createX(...)
updateX(...)
findX(...)
private validateX(...)
```

### 8.2 每个新增 repository 的最小结构

每个 repository 至少包含：

```text
save
findById
findAll
findByRegionCode 或 findByStatus
delete 或 markInactive
```

### 8.3 每个新增 mapper 的最小结构

每个 mapper 至少包含：

```text
toDomain
toResponse
toEvent 或 toRequest
copyRegionFields / copyAuditFields
```

### 8.4 每个新增测试类的最小结构

每个测试类至少包含：

- 3 个 `@Test`。
- 1 个正常路径。
- 1 个边界路径。
- 1 个错误或过滤路径。

不要只写“能构造对象”的薄测试。

## 9. 扩容 goal 模板

### Goal A：扩容 common-domain 和 workorder

```text
/goal
请基于 docs/telecom-ops-platform-scale-expansion-blueprint.md 扩容 telecom-ops-platform。
本轮只扩 common-domain 和 workorder-service。

必须新增 MaintenanceWindow、SlaPolicy、VendorTicket、SlaBreachEvent 等 common-domain 类；
必须在 workorder-service 中新增 WAITING_VENDOR 状态、VendorTicketService、WaitingVendorPolicy、WorkOrderSlaBreachService。

要求：
1. 新增不少于 1800 行有效 Java 代码。
2. 不允许空类、注释堆行数。
3. 保持 mvn test 通过。
4. 新增至少 8 个测试类或扩展现有测试覆盖 WAITING_VENDOR 和 VendorTicket。
5. 更新 docs/benchmark/v3/telecom/cases，新增 telecom-case-d-workorder-state.yaml 和 ground truth。
6. 同步更新 README.md 和 docs/architecture.md，说明新增状态和 Case D。
```

### Goal B：扩容 alarm-engine 和 notification

```text
/goal
请基于 docs/telecom-ops-platform-scale-expansion-blueprint.md 扩容 alarm-engine-service 和 notification-service。

alarm-engine-service 增加 AlarmSuppressionService、SuppressionRuleEvaluator、MaintenanceWindowService、AlarmEscalationPolicy、AlarmExportService。
notification-service 增加 NotificationRuleService、NotificationRetryService、TemplateVariableResolver 及三个实现。

要求：
1. 新增不少于 1700 行有效 Java 代码。
2. 增加 evaluate / process / resolve / send 的真实同名噪音。
3. 不改变 Case B 的目标接口 RuleEvaluator.evaluate 身份。
4. 保持 mvn test 通过。
5. 新增 telecom-case-e-notification-channel-impact.yaml 和 telecom-case-i-maintenance-window-suppression.yaml。
6. 保留 telecom-case-g-vendor-adapter-impact 和 telecom-case-h-severity-enum-change 的 ID，不要复用 G/H。
7. 同步更新 README.md 和 docs/architecture.md。
```

### Goal C：扩容 collector 和 gateway

```text
/goal
请基于 docs/telecom-ops-platform-scale-expansion-blueprint.md 扩容 device-collector-service 和 ops-gateway-service。

collector 增加采集计划、批量导入、厂商原生告警适配。
gateway 增加 drill-down、导出、健康评分、缓存，并修复 DeviceClient/AlarmClient/WorkOrderClient 的 return null。

要求：
1. 新增不少于 1700 行有效 Java 代码。
2. 增加 Dashboard drill-down 执行流 case。
3. 保持 mvn test 通过。
4. 新增 telecom-case-f-dashboard-drilldown-flow.yaml 和 ground truth。
5. 确保 regionCode 干扰字段更多，但不破坏 Case C 的主传播链。
6. 如果同时补 VendorAdapter 扩容，新增 telecom-case-g-vendor-adapter-impact.yaml 和 ground truth。
7. 同步更新 README.md 和 docs/architecture.md。
```

## 10. 扩容验收命令

PowerShell：

```powershell
$env:JAVA_HOME='C:\Program Files\JetBrains\PyCharm 2026.1.1\jbr'
$env:MAVEN_HOME='C:\maven\apache-maven-3.9.8'
$env:PATH="$env:JAVA_HOME\bin;$env:MAVEN_HOME\bin;$env:PATH"

$root='F:\develop\codes\Gitnexus-case-project'
$main=(Get-ChildItem -Recurse -Path $root -Filter *.java | Where-Object { $_.FullName -like '*\src\main\java\*' })
$test=(Get-ChildItem -Recurse -Path $root -Filter *.java | Where-Object { $_.FullName -like '*\src\test\java\*' })
$all=(Get-ChildItem -Recurse -Path $root -Filter *.java)
$lines=0; foreach($f in $all){ $lines += (Get-Content -LiteralPath $f.FullName | Measure-Object -Line).Lines }
[pscustomobject]@{MainJava=$main.Count; TestJava=$test.Count; AllJava=$all.Count; JavaLines=$lines}

mvn test
```

通过标准：

| 项 | 标准 |
| --- | --- |
| Java 总行数 | >= 10000 |
| Main Java 类 | >= 180 |
| Test Java 类 | >= 45 |
| `mvn test` | 通过 |
| Benchmark case YAML | >= 7 |
| JSON fixture | >= 10 |
| `return null` 裸桩 | 0 个，业务允许分支除外 |

## 11. 最终判断标准

扩容完成后，这个测试项目应该具备：

- 足够大的文本搜索噪音。
- 多条真实执行流。
- 多个接口/策略影响分析 case。
- 至少一个状态机修改 case。
- 至少一个字段传播修改 case。
- 至少一个 Dashboard 聚合追踪 case。
- 能稳定通过 `mvn test`。
- 每个 benchmark case 都有 ground truth。

达到这个状态后，项目才更接近“企业级 AI Coding 检索能力 benchmark”，而不是一个功能齐全但规模偏小的 demo。
