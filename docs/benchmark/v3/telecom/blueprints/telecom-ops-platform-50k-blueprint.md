# Telecom Ops Platform 50K 代码规模蓝图

## 1. 目标

本文档将 **telecom-ops-platform** 从当前约 12,387 行 Java（215 main 类 + 89 test 类）扩容到 **50,000 行**，作为 GitNexus vs grep 在 **企业级规模** 下的 AI Coding 检索能力 benchmark。

当前基线（基于 `telecom-ops-platform-large` 快照）：

| 指标 | 当前值 | 目标值 | 缺口 |
|------|------:|------:|-----:|
| Java 总行数 | 12,387 | 50,000 | +37,613 |
| Main Java 类 | 215 | 600+ | +385 |
| Test Java 类 | 89 | 200+ | +111 |
| JSON fixture | 6 | 30+ | +24 |
| Benchmark cases | 9 | 18+ | +9 |
| Maven 模块 | 6 | 10~12 | +4~6 |
| `mvn test` | 通过 | 通过 | - |

## 2. 扩容原则

### 2.1 必须做

- **每新增 1000 行代码，至少包含 1 个可测试的 benchmark case 或 ground truth 扩展。**
- 每个新增模块/包必须属于明确业务领域，不能是随机堆砌。
- 每个新增 service 至少有 3~5 个 public 方法 + 1~2 个 private helper。
- 每个新增 repository 至少有 save / findById / findAll / findByXxx / delete 五个方法。
- 每个新增 mapper 至少有 toDomain / toResponse / toEvent / updateFromRequest / copyFields 五个方法。
- 每个新增测试类至少有 3 个 `@Test`：正常路径、边界路径、错误路径。
- 保持 `mvn test` 始终通过。
- 保持 `common-domain` 不依赖任何 service module。
- 每个跨服务调用必须通过 `DomainEventBus` 或 `*Client` 类，不能直接 Maven 依赖。

### 2.2 禁止做

- 禁止用空类、注释、无意义 getter/setter 堆行数。
- 禁止把算法题、LeetCode 风格代码塞进项目。
- 禁止引入真实数据库、Kafka、Redis、注册中心。
- 禁止让新增代码改变现有 Case A~I 的核心答案，除非同步更新 ground truth。
- 禁止一个类超过 500 行（超过应考虑拆分）。
- 禁止 `return null` 作为桩代码（业务允许分支除外，使用 `Optional` 替代）。

### 2.3 行数构成策略

50,000 行不能均匀分配到所有类。推荐按以下分布自然形成：

| 代码类型 | 占比 | 目标行数 | 策略 |
|----------|-----:|---------:|------|
| Domain / Entity / Event / Enum | 15% | 7,500 | 每个 domain 类 30~80 行，含字段、构造、builder |
| DTO / Request / Response | 12% | 6,000 | 每个 DTO 30~60 行，含校验注解 |
| Service 业务逻辑 | 25% | 12,500 | 每个 service 80~200 行，含业务判断 |
| Repository / DAO | 10% | 5,000 | 每个 repository 60~120 行，含 5+ 方法 |
| Mapper / Converter | 8% | 4,000 | 每个 mapper 50~150 行，含字段映射 |
| Controller / API | 8% | 4,000 | 每个 controller 60~120 行，含参数校验 |
| Config / Properties | 3% | 1,500 | 配置类 |
| Test / Fixture / JSON | 12% | 6,000 | 测试覆盖 |
| Policy / Strategy / Workflow | 7% | 3,500 | 策略模式、状态机 |
| **合计** | **100%** | **50,000** | |

## 3. 模块架构扩展

### 3.1 新增模块

当前 6 个模块 → 扩展到 **12 个模块**：

```
telecom-ops-platform/
  pom.xml                                    # Root POM, 聚合 12 个 module
  common-domain/                             # 共享领域对象 (现有, 扩展)
  common-test/                               # 共享测试工具 (新增)
  device-collector-service/                  # 设备采集 (现有, 扩展)
  device-lifecycle-service/                  # 设备生命周期管理 (新增)
  alarm-engine-service/                      # 告警引擎 (现有, 扩展)
  alarm-federated-service/                   # 告警联邦/多局告警汇聚 (新增)
  workorder-service/                         # 工单流转 (现有, 扩展)
  vendor-collaboration-service/              # 厂商协同 (新增)
  notification-service/                      # 通知服务 (现有, 扩展)
  dispatch-service/                          # 派单/调度引擎 (新增)
  sla-engine-service/                        # SLA 计算引擎 (新增)
  ops-gateway-service/                       # 运维看板 (现有, 扩展)
```

### 3.2 Maven 依赖矩阵

| 模块 | 允许依赖 | 禁止依赖 |
|------|---------|---------|
| `common-domain` | 无业务模块 | 任何 service |
| `common-test` | `common-domain`, 测试框架 | 任何 service |
| `device-collector-service` | `common-domain`, `common-test`(test) | 其他 service |
| `device-lifecycle-service` | `common-domain`, `common-test`(test) | 其他 service |
| `alarm-engine-service` | `common-domain`, `common-test`(test) | 其他 service |
| `alarm-federated-service` | `common-domain`, `common-test`(test) | 其他 service |
| `workorder-service` | `common-domain`, `common-test`(test) | 其他 service |
| `vendor-collaboration-service` | `common-domain`, `common-test`(test) | 其他 service |
| `notification-service` | `common-domain`, `common-test`(test) | 其他 service |
| `dispatch-service` | `common-domain`, `common-test`(test) | 其他 service |
| `sla-engine-service` | `common-domain`, `common-test`(test) | 其他 service |
| `ops-gateway-service` | `common-domain`, `common-test`(test) | 其他 service（用 fake client） |

### 3.3 模块配额分配

| 模块 | 当前行数 | 目标行数 | 新增行数 | Main 类目标 | Test 类目标 |
|------|--------:|---------:|---------:|-----------:|-----------:|
| `common-domain` | 1,966 | 3,500 | +1,534 | 65 | 15 |
| `common-test` | 0 | 1,500 | +1,500 | 20 | 0 |
| `device-collector-service` | 2,331 | 5,000 | +2,669 | 50 | 20 |
| `device-lifecycle-service` | 0 | 4,000 | +4,000 | 35 | 15 |
| `alarm-engine-service` | 2,860 | 6,000 | +3,140 | 60 | 25 |
| `alarm-federated-service` | 0 | 5,000 | +5,000 | 45 | 18 |
| `workorder-service` | 2,888 | 6,500 | +3,612 | 65 | 25 |
| `vendor-collaboration-service` | 0 | 4,500 | +4,500 | 40 | 18 |
| `notification-service` | 1,151 | 4,000 | +2,849 | 45 | 18 |
| `dispatch-service` | 0 | 4,500 | +4,500 | 40 | 18 |
| `sla-engine-service` | 0 | 4,000 | +4,000 | 35 | 15 |
| `ops-gateway-service` | 1,191 | 5,500 | +4,309 | 50 | 20 |
| **合计** | **12,387** | **50,000** | **+37,613** | **550+ main** | **207+ test** |

> 注意：加上测试文件后，总 Java 文件数约 750+ 个。

## 4. 现有模块扩展设计

### 4.1 `common-domain` 扩展 (+1,534 行)

现有 41 main 文件 → 扩展到 65 main 文件。

**新增领域对象：**

| 类 | 类型 | 行数预估 | 用途 |
|----|------|---------|------|
| `NetworkSlice` | Domain | 60 | 网络切片 |
| `NetworkSliceEvent` | Event | 40 | 切片变更事件 |
| `SlaContract` | Domain | 80 | SLA 合同定义 |
| `SlaMetricSnapshot` | Domain | 50 | SLA 指标快照 |
| `DispatchOrder` | Domain | 80 | 调度指令 |
| `DispatchOrderEvent` | Event | 40 | 调度事件 |
| `FederatedAlarmSource` | Domain | 50 | 联邦告警源 |
| `FederatedAlarmRecord` | Domain | 70 | 联邦告警记录 |
| `VendorSlaReport` | Domain | 60 | 厂商 SLA 报告 |
| `DeviceCertificate` | Domain | 50 | 设备证书 |
| `DeviceFirmwareVersion` | Domain | 40 | 固件版本 |
| `MaintenancePlan` | Domain | 70 | 维护计划 |
| `MaintenancePlanEvent` | Event | 40 | 维护计划事件 |
| `PerformanceReport` | Domain | 60 | 性能报告 |
| `TopologyLink` | Domain | 50 | 拓扑链路 |
| `TopologyNode` | Domain | 50 | 拓扑节点 |
| `TopologyEvent` | Event | 40 | 拓扑事件 |
| `EscalationRule` | Domain | 60 | 升级规则（增强现有） |
| `HolidayCalendar` | Domain | 60 | 节假日日历（SLA 计算用） |
| `ShiftSchedule` | Domain | 60 | 排班表 |
| `BulkOperationBatch` | Domain | 50 | 批量操作批次 |
| `BulkOperationItem` | Domain | 40 | 批量操作项 |
| `NotificationRuleConfig` | Domain | 50 | 通知规则配置 |
| `DashboardWidgetConfig` | Domain | 50 | 看板组件配置 |

**新增枚举：**

| 枚举 | 常量数 | 用途 |
|------|-------:|------|
| `NetworkSliceStatus` | 5 | 切片状态 |
| `DispatchPriority` | 4 | 调度优先级 |
| `VendorSlaStatus` | 4 | 厂商 SLA 状态 |
| `MaintenanceStatus` | 4 | 维护状态 |
| `FederatedAlarmStatus` | 5 | 联邦告警状态 |
| `TopologyChangeType` | 4 | 拓扑变更类型 |
| `ShiftType` | 3 | 班次类型 |
| `BulkOperationStatus` | 4 | 批量操作状态 |
| `DeviceCertStatus` | 3 | 证书状态 |

**干扰字段增强：**

新增 `regionCode` 干扰项——以下新类也包含 `regionCode`，但它们**不是** Case C 的修改目标：

- `NetworkSlice.regionCode` — 网络切片所属区域
- `MaintenancePlan.regionCode` — 维护计划区域
- `ShiftSchedule.regionCode` — 排班区域
- `TopologyNode.regionCode` — 拓扑节点区域

### 4.2 `common-test` 模块（新增，1,500 行）

共享测试工具和 fixture。

| 类 | 类型 | 行数 | 用途 |
|----|------|-----:|------|
| `TestDataFactory` | Utility | 200 | 统一测试数据工厂 |
| `DeviceTestDataBuilder` | Builder | 150 | 设备测试数据构建 |
| `AlarmTestDataBuilder` | Builder | 150 | 告警测试数据构建 |
| `WorkOrderTestDataBuilder` | Builder | 150 | 工单测试数据构建 |
| `InMemoryRepositoryBase` | Abstract | 100 | 内存 repository 基类 |
| `ReflectionTestUtils` | Utility | 80 | 反射测试工具 |
| `JsonFixtureLoader` | Utility | 100 | JSON fixture 加载器 |
| `MockDomainEventBus` | Mock | 80 | 模拟事件总线 |
| `TestClockProvider` | Utility | 60 | 测试时钟 |
| `ParameterizedTestUtils` | Utility | 80 | 参数化测试工具 |
| `AssertionHelper` | Utility | 100 | 断言辅助 |
| `CsvImportTestReader` | Utility | 80 | CSV 测试数据读取 |
| `TimeRangeTestUtils` | Utility | 70 | 时间范围测试 |

### 4.3 `device-collector-service` 扩展 (+2,669 行)

当前 33 main 文件 → 扩展到 50 main 文件。

**新增类：**

| 类 | 类型 | 行数 | 用途 |
|----|------|-----:|------|
| `CollectorScheduleController` | Controller | 100 | 采集计划 API（已有接口增强） |
| `CollectorScheduleService` | Service | 180 | 采集计划启停 |
| `CollectorScheduleRepository` | Repository | 120 | 采集计划存储 |
| `CollectorScheduleRequest` | DTO | 50 | 采集计划请求 |
| `CollectorScheduleResponse` | DTO | 50 | 采集计划响应 |
| `DeviceBatchImportController` | Controller | 120 | 批量导入 API |
| `DeviceBatchImportService` | Service | 200 | CSV/JSON 导入 |
| `DeviceBatchImportRequest` | DTO | 60 | 导入请求 |
| `DeviceBatchImportResponse` | DTO | 50 | 导入结果 |
| `DeviceImportValidator` | Validator | 120 | 导入校验 |
| `DeviceImportAuditService` | Service | 100 | 导入审计 |
| `VendorAlarmAdapter` | Interface | 20 | 厂商原生告警适配接口 |
| `HuaweiVendorAlarmAdapter` | Impl | 120 | 华为告警适配 |
| `ZteVendorAlarmAdapter` | Impl | 120 | 中兴告警适配 |
| `FiberHomeVendorAlarmAdapter` | Impl | 100 | 烽火告警适配 |
| `VendorAlarmAdapterRegistry` | Registry | 80 | 告警 adapter 分发 |
| `VendorSnmpMibMapper` | Mapper | 150 | SNMP MIB 映射 |
| `SnmpTrapReceiver` | Service | 150 | SNMP Trap 接收模拟 |
| `SnmpTrapEventConsumer` | Consumer | 80 | Trap 事件处理 |

**现有类增强：**

- `DeviceMetricIngestController` — 增加批量指标上报接口（+80 行）
- `VendorAdapterRegistry` — 增加缓存和 fallback 逻辑（+50 行）
- `DeviceMetricNormalizer` — 增加更多指标类型标准化（+80 行）
- `DeviceMetricValidator` — 增加更多校验规则（+60 行）
- `DeviceRegistryRepository` — 增加分页查询、按状态过滤（+60 行）

**新增同名噪音：**

- `CollectorScheduleService.process(...)` — 计划处理
- `DeviceBatchImportService.process(...)` — 导入处理
- `VendorAlarmAdapter.normalize(...)` — 告警标准化噪音
- `VendorAlarmAdapterRegistry.resolve(...)` — 注册表解析噪音
- `SnmpTrapReceiver.receive(...)` — Trap 接收

**新增测试（4 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `CollectorScheduleServiceTest` | 4 | 200 |
| `DeviceBatchImportServiceTest` | 4 | 220 |
| `VendorAlarmAdapterRegistryTest` | 3 | 150 |
| `DeviceImportValidatorTest` | 3 | 150 |

### 4.4 `alarm-engine-service` 扩展 (+3,140 行)

当前 43 main 文件 → 扩展到 60 main 文件。

**新增类：**

| 类 | 类型 | 行数 | 用途 |
|----|------|-----:|------|
| `AlarmSuppressionRule` | Domain | 60 | 告警抑制规则（补充现有） |
| `AlarmSuppressionRuleRepository` | Repository | 100 | 抑制规则存储 |
| `AlarmSuppressionService` | Service | 200 | 告警抑制（增强现有） |
| `AlarmSuppressionRuleEvaluator` | Evaluator | 120 | 抑制规则评估（非 RuleEvaluator） |
| `AlarmCorrelationRule` | Domain | 60 | 告警关联规则 |
| `AlarmCorrelationRuleRepository` | Repository | 100 | 关联规则存储 |
| `AlarmCorrelationEngine` | Service | 200 | 告警关联引擎（增强现有） |
| `AlarmTriageService` | Service | 180 | 告警分类 |
| `AlarmTriageRule` | Domain | 60 | 分类规则 |
| `AlarmTriageRuleRepository` | Repository | 100 | 分类规则存储 |
| `AlarmLifecycleHook` | Interface | 20 | 告警生命周期钩子 |
| `AlarmCreationHook` | Impl | 80 | 创建钩子 |
| `AlarmClearedHook` | Impl | 80 | 清除钩子 |
| `AlarmEscalationHook` | Impl | 80 | 升级钩子 |
| `AlarmHookRegistry` | Registry | 80 | 钩子注册表 |
| `AlarmStatisticsService` | Service | 180 | 告警统计（增强现有） |
| `AlarmTrendAnalysisService` | Service | 180 | 告警趋势分析 |
| `AlarmAnalyticsController` | Controller | 120 | 告警分析 API |
| `AlarmAnalyticsRequest` | DTO | 50 | 分析请求 |
| `AlarmAnalyticsResponse` | DTO | 60 | 分析响应 |
| `AlarmExportAsyncService` | Service | 150 | 异步导出增强 |
| `AlarmSummaryReportGenerator` | Service | 150 | 告警汇总报告 |
| `AlarmReportScheduler` | Service | 120 | 报告调度 |

**新增同名噪音：**

- `AlarmSuppressionRuleEvaluator.evaluate(...)` — 抑制评估（非 RuleEvaluator）
- `AlarmTriageService.classify(...)` — 分类
- `AlarmLifecycleHook.process(...)` — 钩子处理
- `AlarmTrendAnalysisService.analyze(...)` — 趋势分析
- `AlarmSummaryReportGenerator.generate(...)` — 报告生成

**干扰项约束：**

- `SuppressionRuleEvaluator.evaluate` 不实现 `RuleEvaluator`
- `AlarmCorrelationEngine` 包含 `correlate()` 方法，与现有 `AlarmCorrelationService.correlate()` 形成同名噪音

**新增测试（5 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `AlarmSuppressionServiceTest` | 4 | 220 |
| `AlarmCorrelationEngineTest` | 4 | 220 |
| `AlarmTriageServiceTest` | 3 | 180 |
| `AlarmHookRegistryTest` | 3 | 150 |
| `AlarmTrendAnalysisServiceTest` | 3 | 180 |

## 5. 新增模块设计

### 5.1 `device-lifecycle-service`（新增，4,000 行）

**职责：** 管理设备全生命周期——注册、激活、停用、退役、固件升级、证书管理。

**包结构：**

```
com.example.telecom.device.lifecycle
  controller/       # 设备生命周期 API
  service/           # 生命周期服务
  repository/        # 存储
  workflow/          # 设备状态机
  event/             # 事件发布
  policy/            # 生命周期策略
  mapper/            # DTO 转换
  validator/         # 校验
  config/            # 配置
```

**类清单：**

| 类 | 类型 | 行数 |
|----|------|-----:|
| `DeviceLifecycleApplication` | App | 15 |
| `DeviceLifecycleController` | Controller | 150 |
| `DeviceFirmwareController` | Controller | 120 |
| `DeviceCertificateController` | Controller | 120 |
| `DeviceLifecycleService` | Service | 250 |
| `DeviceFirmwareService` | Service | 200 |
| `DeviceCertificateService` | Service | 180 |
| `DeviceDeprecationService` | Service | 180 |
| `DeviceLifecycleRepository` | Repository | 150 |
| `DeviceFirmwareRepository` | Repository | 120 |
| `DeviceCertificateRepository` | Repository | 120 |
| `DeviceStateMachine` | Workflow | 250 |
| `DeviceLifecycleEventPublisher` | Event | 100 |
| `DeviceFirmwareEventConsumer` | Consumer | 80 |
| `DeviceCertificateEventConsumer` | Consumer | 80 |
| `DeviceDeprecationPolicy` | Policy | 120 |
| `FirmwareUpgradePolicy` | Policy | 120 |
| `CertificateRotationPolicy` | Policy | 100 |
| `DeviceLifecycleMapper` | Mapper | 150 |
| `DeviceLifecycleValidator` | Validator | 120 |
| `DeviceFirmwareRequest` | DTO | 60 |
| `DeviceFirmwareResponse` | DTO | 50 |
| `DeviceCertificateRequest` | DTO | 60 |
| `DeviceCertificateResponse` | DTO | 50 |
| `DeviceLifecycleRequest` | DTO | 50 |
| `DeviceLifecycleResponse` | DTO | 50 |
| `DeviceLifecycleEvent` | Event | 60 |
| `DeviceFirmwareEvent` | Event | 50 |
| `DeviceCertificateEvent` | Event | 50 |
| `LifecycleProperties` | Config | 40 |
| `DeviceLifecycleAuditService` | Service | 120 |

**设备状态机：**

```
REGISTERED -> ACTIVE
ACTIVE -> SUSPENDED
SUSPENDED -> ACTIVE
ACTIVE -> RETIRED
RETIRED -> DECOMMISSIONED
ACTIVE -> FIRMWARE_UPGRADING
FIRMWARE_UPGRADING -> ACTIVE
FIRMWARE_UPGRADING -> FAILED
FAILED -> ACTIVE
```

**新增同名噪音：**

- `DeviceStateMachine.transition(...)` — 与 WorkOrderStateMachine 同名
- `DeviceDeprecationPolicy.evaluate(...)` — 新的 evaluate 噪音
- `DeviceLifecycleValidator.validate(...)` — 与现有 validate 同名
- `CertificateRotationPolicy.evaluate(...)` — 新的 evaluate 噪音

**测试（5 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `DeviceLifecycleServiceTest` | 5 | 280 |
| `DeviceFirmwareServiceTest` | 4 | 240 |
| `DeviceStateMachineTest` | 5 | 280 |
| `DeviceDeprecationPolicyTest` | 3 | 160 |
| `DeviceCertificateServiceTest` | 3 | 180 |

### 5.2 `alarm-federated-service`（新增，5,000 行）

**职责：** 多局/多区域告警汇聚、联邦告警关联、跨区域告警升级。

**包结构：**

```
com.example.telecom.alarm.federated
  controller/       # 联邦告警 API
  service/          # 汇聚和关联服务
  repository/       # 联邦告警存储
  aggregation/      # 汇聚策略
  correlation/      # 跨区域关联
  event/            # 事件
  mapper/           # DTO 转换
  config/           # 配置
```

**类清单（约 45 个类）：**

核心类包括：

| 类 | 类型 | 行数 |
|----|------|-----:|
| `FederatedAlarmApplication` | App | 15 |
| `FederatedAlarmController` | Controller | 180 |
| `FederatedAlarmQueryController` | Controller | 120 |
| `FederatedAlarmIngestController` | Controller | 120 |
| `AlarmIngestionService` | Service | 200 |
| `FederatedAlarmAggregationService` | Service | 300 |
| `FederatedAlarmCorrelationService` | Service | 280 |
| `FederatedAlarmDeduplicationService` | Service | 200 |
| `FederatedAlarmEscalationService` | Service | 220 |
| `FederatedAlarmRepository` | Repository | 180 |
| `FederatedAlarmSourceRepository` | Repository | 120 |
| `FederatedAlarmSourceRegistry` | Registry | 100 |
| `AggregationStrategy` | Interface | 20 |
| `RegionBasedAggregationStrategy` | Impl | 120 |
| `SeverityBasedAggregationStrategy` | Impl | 120 |
| `TimeWindowAggregationStrategy` | Impl | 120 |
| `FederatedCorrelationEngine` | Service | 250 |
| `CorrelationRuleMatcher` | Service | 150 |
| `AlarmFederationEventPublisher` | Event | 100 |
| `FederatedAlarmEventConsumer` | Consumer | 100 |
| `FederatedAlarmMapper` | Mapper | 180 |
| `FederatedAlarmRequest` | DTO | 60 |
| `FederatedAlarmResponse` | DTO | 60 |
| `FederatedAlarmSummary` | DTO | 50 |
| `AggregationResult` | DTO | 50 |
| `FederatedProperties` | Config | 40 |
| `FederatedAuditService` | Service | 120 |
| `FederatedHealthCheckService` | Service | 100 |
| `FederatedAlarmExportService` | Service | 150 |
| `CrossRegionAlarmView` | DTO | 60 |

**新增同名噪音：**

- `FederatedAlarmDeduplicationService.deduplicate(...)` — 与现有 deduplicate 同名
- `AggregationStrategy.aggregate(...)` — 聚合策略
- `FederatedAlarmEscalationService.escalate(...)` — 升级
- `CorrelationRuleMatcher.match(...)` — 匹配
- `FederatedAlarmSourceRegistry.resolve(...)` — 与现有 resolve 同名

**测试（6 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `FederatedAlarmAggregationServiceTest` | 4 | 240 |
| `FederatedAlarmCorrelationServiceTest` | 4 | 250 |
| `FederatedAlarmDeduplicationServiceTest` | 3 | 180 |
| `AggregationStrategyTest` | 3 | 200 |
| `FederatedCorrelationEngineTest` | 3 | 180 |
| `AlarmIngestionServiceTest` | 3 | 180 |

### 5.3 `vendor-collaboration-service`（新增，4,500 行）

**职责：** 厂商协同单管理、厂商 SLA 跟踪、厂商工单反馈闭环。

**包结构：**

```
com.example.telecom.vendor
  controller/       # 厂商协同 API
  service/          # 协同服务
  repository/       # 存储
  workflow/         # 厂商协同状态机
  evaluation/       # 厂商评估
  event/            # 事件
  mapper/           # 映射
  config/           # 配置
```

**核心类：**

| 类 | 类型 | 行数 |
|----|------|-----:|
| `VendorCollaborationApplication` | App | 15 |
| `VendorTicketController` | Controller | 150 |
| `VendorSlaReportController` | Controller | 120 |
| `VendorFeedbackController` | Controller | 120 |
| `VendorTicketService` | Service | 280 |
| `VendorSlaTrackingService` | Service | 220 |
| `VendorFeedbackService` | Service | 200 |
| `VendorEvaluationService` | Service | 200 |
| `VendorPerformanceCalculator` | Service | 180 |
| `VendorTicketRepository` | Repository | 150 |
| `VendorSlaRepository` | Repository | 120 |
| `VendorFeedbackRepository` | Repository | 120 |
| `VendorPerformanceRepository` | Repository | 120 |
| `VendorCollaborationStateMachine` | Workflow | 200 |
| `VendorTicketEventPublisher` | Event | 100 |
| `VendorTicketEventConsumer` | Consumer | 80 |
| `VendorEvaluator` | Interface | 20 |
| `ResponseTimeVendorEvaluator` | Impl | 120 |
| `ResolutionRateVendorEvaluator` | Impl | 120 |
| `QualityScoreVendorEvaluator` | Impl | 120 |
| `VendorEvaluatorRegistry` | Registry | 80 |
| `VendorTicketMapper` | Mapper | 150 |
| `VendorTicketRequest` | DTO | 60 |
| `VendorTicketResponse` | DTO | 50 |
| `VendorSlaReportRequest` | DTO | 50 |
| `VendorSlaReportResponse` | DTO | 50 |
| `VendorFeedbackRequest` | DTO | 50 |
| `VendorFeedbackResponse` | DTO | 50 |
| `VendorPerformanceReport` | DTO | 60 |
| `VendorCollaborationProperties` | Config | 40 |
| `VendorNotificationService` | Service | 120 |

**厂商协同状态机：**

```
CREATED -> AWAITING_VENDOR
AWAITING_VENDOR -> VENDOR_ACKED
VENDOR_ACKED -> VENDOR_IN_PROGRESS
VENDOR_IN_PROGRESS -> VENDOR_RESOLVED
VENDOR_RESOLVED -> VERIFIED
VERIFIED -> CLOSED
VENDOR_IN_PROGRESS -> ESCALATED
ESCALATED -> VENDOR_IN_PROGRESS
```

**新增同名噪音：**

- `VendorEvaluator.evaluate(...)` — 厂商评估（与 RuleEvaluator 噪音不同接口）
- `VendorCollaborationStateMachine.transition(...)` — 与 WorkOrderStateMachine 同名
- `VendorPerformanceCalculator.calculate(...)` — 性能计算
- `VendorSlaTrackingService.track(...)` — SLA 跟踪
- `VendorTicketEventConsumer.onVendorEvent(...)` — 事件消费

**测试（5 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `VendorTicketServiceTest` | 4 | 240 |
| `VendorSlaTrackingServiceTest` | 3 | 200 |
| `VendorEvaluationServiceTest` | 4 | 220 |
| `VendorCollaborationStateMachineTest` | 4 | 240 |
| `VendorEvaluatorRegistryTest` | 3 | 160 |

### 5.4 `dispatch-service`（新增，4,500 行）

**职责：** 工单和任务的智能调度引擎——按区域、技能、负载、优先级自动派单。

**包结构：**

```
com.example.telecom.dispatch
  controller/       # 调度 API
  service/          # 调度服务
  repository/       # 存储
  engine/           # 调度引擎
  rule/             # 调度规则
  event/            # 事件
  mapper/           # 映射
  config/           # 配置
```

**核心类：**

| 类 | 类型 | 行数 |
|----|------|-----:|
| `DispatchApplication` | App | 15 |
| `DispatchController` | Controller | 150 |
| `DispatchRuleController` | Controller | 120 |
| `DispatchHistoryController` | Controller | 100 |
| `DispatchOrchestrationService` | Service | 300 |
| `DispatchRuleService` | Service | 200 |
| `DispatchHistoryService` | Service | 150 |
| `DispatchEngine` | Engine | 300 |
| `DispatchScoringService` | Service | 200 |
| `DispatchRepository` | Repository | 150 |
| `DispatchRuleRepository` | Repository | 120 |
| `DispatchHistoryRepository` | Repository | 120 |
| `DispatchOptimizer` | Service | 200 |
| `DispatchRule` | Interface | 20 |
| `SkillMatchRule` | Impl | 120 |
| `LoadBalanceRule` | Impl | 120 |
| `ProximityRule` | Impl | 120 |
| `PriorityOverrideRule` | Impl | 100 |
| `DispatchRuleRegistry` | Registry | 80 |
| `DispatchEventPublisher` | Event | 100 |
| `WorkOrderAssignmentEventConsumer` | Consumer | 80 |
| `DispatchAuditService` | Service | 120 |
| `DispatchMapper` | Mapper | 150 |
| `DispatchRequest` | DTO | 60 |
| `DispatchResponse` | DTO | 50 |
| `DispatchRuleRequest` | DTO | 50 |
| `DispatchRuleResponse` | DTO | 50 |
| `DispatchSummaryResponse` | DTO | 50 |
| `DispatchProperties` | Config | 40 |
| `DispatchStatisticsService` | Service | 150 |
| `OperatorAvailabilityService` | Service | 150 |

**新增同名噪音：**

- `DispatchEngine.dispatch(...)` — 调度
- `DispatchOptimizer.optimize(...)` — 优化
- `DispatchRule.evaluate(...)` — 评估规则
- `SkillMatchRule.evaluate(...)` — 技能匹配评估
- `LoadBalanceRule.evaluate(...)` — 负载均衡评估
- `OperatorAvailabilityService.check(...)` — 可用性检查
- `DispatchStatisticsService.calculate(...)` — 统计计算

**测试（5 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `DispatchOrchestrationServiceTest` | 4 | 260 |
| `DispatchEngineTest` | 5 | 300 |
| `DispatchScoringServiceTest` | 3 | 180 |
| `DispatchRuleTest` | 4 | 240 |
| `OperatorAvailabilityServiceTest` | 3 | 160 |

### 5.5 `sla-engine-service`（新增，4,000 行）

**职责：** SLA 合同管理、SLA 指标计算、SLA 违约检测与升级触发。

**包结构：**

```
com.example.telecom.sla
  controller/       # SLA API
  service/          # SLA 服务
  repository/       # 存储
  calculator/       # 指标计算
  monitor/          # 违约监控
  event/            # 事件
  mapper/           # 映射
  config/           # 配置
```

**核心类：**

| 类 | 类型 | 行数 |
|----|------|-----:|
| `SlaEngineApplication` | App | 15 |
| `SlaContractController` | Controller | 150 |
| `SlaMonitorController` | Controller | 120 |
| `SlaReportController` | Controller | 120 |
| `SlaContractService` | Service | 250 |
| `SlaMonitoringService` | Service | 250 |
| `SlaBreachDetectionService` | Service | 220 |
| `SlaBreachEscalationService` | Service | 200 |
| `SlaReportService` | Service | 180 |
| `SlaContractRepository` | Repository | 150 |
| `SlaMetricRepository` | Repository | 120 |
| `SlaBreachRepository` | Repository | 120 |
| `SlaReportRepository` | Repository | 100 |
| `SlaTimeCalculator` | Calculator | 180 |
| `SlaAvailabilityCalculator` | Calculator | 180 |
| `SlaResponseTimeCalculator` | Calculator | 180 |
| `SlaResolutionTimeCalculator` | Calculator | 180 |
| `SlaCalculatorRegistry` | Registry | 80 |
| `SlaMonitor` | Monitor | 200 |
| `SlaBreachPolicy` | Policy | 120 |
| `SlaHolidayCalendarService` | Service | 120 |
| `SlaEventPublisher` | Event | 100 |
| `WorkOrderSlaEventConsumer` | Consumer | 80 |
| `SlaMapper` | Mapper | 150 |
| `SlaContractRequest` | DTO | 60 |
| `SlaContractResponse` | DTO | 60 |
| `SlaBreachResponse` | DTO | 50 |
| `SlaReportRequest` | DTO | 50 |
| `SlaReportResponse` | DTO | 60 |
| `SlaProperties` | Config | 40 |
| `SlaAuditService` | Service | 120 |
| `SlaNotificationService` | Service | 120 |

**新增同名噪音：**

- `SlaTimeCalculator.calculate(...)` — 时间计算
- `SlaAvailabilityCalculator.calculate(...)` — 可用性计算
- `SlaResponseTimeCalculator.calculate(...)` — 响应时间计算
- `SlaResolutionTimeCalculator.calculate(...)` — 解决时间计算
- `SlaMonitor.monitor(...)` — 监控
- `SlaBreachDetectionService.detect(...)` — 违约检测
- `SlaBreachPolicy.evaluate(...)` — 违约策略评估
- `SlaCalculatorRegistry.resolve(...)` — 注册表解析

**测试（5 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `SlaContractServiceTest` | 4 | 240 |
| `SlaBreachDetectionServiceTest` | 4 | 250 |
| `SlaCalculatorTest` | 4 | 280 |
| `SlaMonitorTest` | 3 | 180 |
| `SlaHolidayCalendarServiceTest` | 3 | 160 |

## 6. 现有模块增强（ops-gateway-service, workorder-service, notification-service）

### 6.1 `ops-gateway-service` 扩展 (+4,309 行)

当前 28 main 文件 → 扩展到 50 main 文件。

**新增类：**

| 类 | 类型 | 行数 | 用途 |
|----|------|-----:|------|
| `DashboardDrilldownController` | Controller | 120 | Drill-down API（已有增强） |
| `DashboardDrilldownService` | Service | 200 | Drill-down 聚合 |
| `DashboardExportController` | Controller | 120 | 导出 API |
| `DashboardExportService` | Service | 200 | 导出任务管理 |
| `DashboardExportRepository` | Repository | 120 | 导出任务存储 |
| `DashboardExportTask` | Domain | 60 | 导出任务 |
| `DashboardExportResponse` | DTO | 50 | 导出响应 |
| `DashboardHealthScoreService` | Service | 200 | 健康评分 |
| `DeviceHealthEvaluator` | Evaluator | 120 | 设备健康评估（非 Case B） |
| `RegionHealthEvaluator` | Evaluator | 120 | 区域健康评估 |
| `ServiceHealthEvaluator` | Evaluator | 120 | 服务健康评估 |
| `DashboardHealthScoreRequest` | DTO | 50 | 健康评分请求 |
| `DashboardHealthScoreResponse` | DTO | 60 | 健康评分响应 |
| `DashboardCacheService` | Service | 150 | 内存缓存 |
| `DashboardQueryValidator` | Validator | 120 | 查询参数校验 |
| `DashboardTrendController` | Controller | 120 | 趋势 API |
| `DashboardTrendService` | Service | 180 | 趋势聚合 |
| `DashboardTrendResponse` | DTO | 60 | 趋势响应 |
| `DashboardAlarmRankingController` | Controller | 100 | 告警排名 API |
| `DashboardAlarmRankingService` | Service | 150 | 告警排名 |
| `DashboardTopologyController` | Controller | 100 | 拓扑视图 API |
| `DashboardTopologyService` | Service | 150 | 拓扑聚合 |

**现有类增强：**

- `DeviceClient` — 改为 `Map` 存储，增加批量查询（+60 行）
- `AlarmClient` — 改为 `Map` 存储，增加批量查询（+60 行）
- `WorkOrderClient` — 改为 `Map` 存储，增加批量查询（+60 行）
- `DashboardAggregationService` — 增加多区域聚合（+100 行）
- `DashboardResponseMapper` — 增加更多字段映射（+60 行）

**新增测试（5 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `DashboardDrilldownServiceTest` | 4 | 240 |
| `DashboardHealthScoreServiceTest` | 4 | 220 |
| `DashboardExportServiceTest` | 3 | 180 |
| `DashboardCacheServiceTest` | 3 | 150 |
| `DashboardTrendServiceTest` | 3 | 180 |

### 6.2 `workorder-service` 扩展 (+3,612 行)

当前 41 main 文件 → 扩展到 65 main 文件。

**新增类：**

| 类 | 类型 | 行数 | 用途 |
|----|------|-----:|------|
| `WorkOrderStatisticsController` | Controller | 120 | 工单统计 API |
| `WorkOrderStatisticsService` | Service | 200 | 工单统计（增强现有） |
| `WorkOrderTrendService` | Service | 180 | 工单趋势 |
| `WorkOrderCategoryService` | Service | 150 | 工单分类 |
| `WorkOrderCategoryRepository` | Repository | 100 | 分类存储 |
| `WorkOrderCategoryRequest` | DTO | 50 | 分类请求 |
| `WorkOrderCategoryResponse` | DTO | 50 | 分类响应 |
| `WorkOrderReportController` | Controller | 100 | 报告 API |
| `WorkOrderReportService` | Service | 180 | 工单报告生成 |
| `WorkOrderReportRequest` | DTO | 50 | 报告请求 |
| `WorkOrderReportResponse` | DTO | 50 | 报告响应 |
| `WorkOrderCommentController` | Controller | 100 | 备注 API |
| `WorkOrderCommentService` | Service | 150 | 备注管理 |
| `WorkOrderCommentRepository` | Repository | 100 | 备注存储 |
| `WorkOrderCommentRequest` | DTO | 40 | 备注请求 |
| `WorkOrderCommentResponse` | DTO | 40 | 备注响应 |
| `WorkOrderAttachmentService` | Service | 150 | 附件模拟 |
| `WorkOrderAttachmentRepository` | Repository | 100 | 附件存储 |
| `WorkOrderHistoryService` | Service | 150 | 工单历史 |
| `WorkOrderHistoryRepository` | Repository | 100 | 历史存储 |
| `WorkOrderTemplateController` | Controller | 100 | 工单模板 API |
| `WorkOrderTemplateService` | Service | 150 | 工单模板 |
| `WorkOrderTemplateRepository` | Repository | 100 | 模板存储 |
| `WorkOrderTemplateRequest` | DTO | 50 | 模板请求 |
| `WorkOrderTemplateResponse` | DTO | 50 | 模板响应 |

**现有类增强：**

- `WorkOrderStateMachine` — 增加 WAITING_VENDOR 完整状态支持（+80 行）
- `WorkOrderFlowService` — 增加更多流转校验（+60 行）
- `AutoWorkOrderService` — 增加更多告警类型到工单的映射（+60 行）

**新增测试（6 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `WorkOrderStatisticsServiceTest` | 4 | 220 |
| `WorkOrderCommentServiceTest` | 3 | 180 |
| `WorkOrderHistoryServiceTest` | 3 | 160 |
| `WorkOrderTemplateServiceTest` | 3 | 180 |
| `WorkOrderReportServiceTest` | 3 | 180 |
| `WorkOrderCategoryServiceTest` | 3 | 160 |

### 6.3 `notification-service` 扩展 (+2,849 行)

当前 29 main 文件 → 扩展到 45 main 文件。

**新增类：**

| 类 | 类型 | 行数 | 用途 |
|----|------|-----:|------|
| `NotificationRule` | Domain | 60 | 通知规则 |
| `NotificationRuleRepository` | Repository | 120 | 规则存储 |
| `NotificationRuleService` | Service | 200 | 规则匹配 |
| `NotificationRuleRequest` | DTO | 50 | 规则请求 |
| `NotificationRuleResponse` | DTO | 50 | 规则响应 |
| `NotificationRetryService` | Service | 200 | 失败重试 |
| `NotificationRetryPolicy` | Policy | 100 | 重试策略 |
| `NotificationFailureRepository` | Repository | 100 | 失败记录 |
| `NotificationPriorityService` | Service | 120 | 通知优先级 |
| `NotificationBatchController` | Controller | 100 | 批量通知 API |
| `NotificationBatchService` | Service | 180 | 批量通知 |
| `NotificationBatchRequest` | DTO | 50 | 批量请求 |
| `NotificationBatchResponse` | DTO | 50 | 批量响应 |
| `NotificationPreferenceController` | Controller | 100 | 偏好 API |
| `NotificationPreferenceService` | Service | 150 | 偏好管理 |
| `NotificationPreferenceRepository` | Repository | 100 | 偏好存储 |
| `NotificationChannelStatsService` | Service | 120 | 渠道统计 |
| `NotificationChannelHealthCheck` | Service | 100 | 渠道健康检查 |
| `SmsNotificationChannel` | Impl | 120 | 短信增强 |
| `EmailNotificationChannel` | Impl | 120 | 邮件增强 |
| `WeComNotificationChannel` | Impl | 100 | 企微增强 |
| `NotificationChannelMetrics` | Service | 100 | 渠道指标 |

**现有类增强：**

- `NotificationTemplateService` — 增加更多模板变量解析（+80 行）
- `NotificationService` — 增加异步发送逻辑（+60 行）

**新增测试（4 个）：**

| 测试类 | 方法数 | 行数 |
|--------|-------:|-----:|
| `NotificationRuleServiceTest` | 4 | 220 |
| `NotificationRetryServiceTest` | 3 | 200 |
| `NotificationBatchServiceTest` | 3 | 180 |
| `NotificationPreferenceServiceTest` | 3 | 160 |

## 7. 干扰项与噪音设计（全局）

### 7.1 `evaluate` 方法噪音总表

| 类名 | 模块 | 实现接口 | 是否为 Case B 目标 |
|------|------|---------|:---:|
| `CpuUsageRuleEvaluator.evaluate` | alarm-engine | `RuleEvaluator` | ✅ |
| `MemoryUsageRuleEvaluator.evaluate` | alarm-engine | `RuleEvaluator` | ✅ |
| `OpticalPowerRuleEvaluator.evaluate` | alarm-engine | `RuleEvaluator` | ✅ |
| `PacketLossRuleEvaluator.evaluate` | alarm-engine | `RuleEvaluator` | ✅ |
| `TemperatureRuleEvaluator.evaluate` | alarm-engine | `RuleEvaluator` | ✅ |
| `SlaEvaluator.evaluate` | alarm-engine | 无 | ❌ 干扰 |
| `RiskEvaluator.evaluate` | alarm-engine | 无 | ❌ 干扰 |
| `SuppressionRuleEvaluator.evaluate` | alarm-engine | 无 | ❌ 干扰 |
| `AlarmEscalationPolicy.evaluate` | alarm-engine | `AlarmEscalationPolicy` | ❌ 干扰 |
| `SeverityAlarmEscalationPolicy.evaluate` | alarm-engine | `AlarmEscalationPolicy` | ❌ 干扰 |
| `DurationAlarmEscalationPolicy.evaluate` | alarm-engine | `AlarmEscalationPolicy` | ❌ 干扰 |
| `DashboardHealthEvaluator.evaluate` | ops-gateway | 无 | ❌ 干扰 |
| `DeviceHealthEvaluator.evaluate` | ops-gateway | 无 | ❌ 干扰 |
| `RegionHealthEvaluator.evaluate` | ops-gateway | 无 | ❌ 干扰 |
| `ServiceHealthEvaluator.evaluate` | ops-gateway | 无 | ❌ 干扰 |
| `EscalationPolicy.evaluate` | workorder | `EscalationPolicy` | ❌ 干扰 |
| `SeverityEscalationPolicy.evaluate` | workorder | `EscalationPolicy` | ❌ 干扰 |
| `SlaEscalationPolicy.evaluate` | workorder | `EscalationPolicy` | ❌ 干扰 |
| `DispatchRule.evaluate` | dispatch | `DispatchRule` | ❌ 干扰 |
| `SkillMatchRule.evaluate` | dispatch | `DispatchRule` | ❌ 干扰 |
| `LoadBalanceRule.evaluate` | dispatch | `DispatchRule` | ❌ 干扰 |
| `ProximityRule.evaluate` | dispatch | `DispatchRule` | ❌ 干扰 |
| `PriorityOverrideRule.evaluate` | dispatch | `DispatchRule` | ❌ 干扰 |
| `VendorEvaluator.evaluate` | vendor-collaboration | `VendorEvaluator` | ❌ 干扰 |
| `ResponseTimeVendorEvaluator.evaluate` | vendor-collaboration | `VendorEvaluator` | ❌ 干扰 |
| `ResolutionRateVendorEvaluator.evaluate` | vendor-collaboration | `VendorEvaluator` | ❌ 干扰 |
| `QualityScoreVendorEvaluator.evaluate` | vendor-collaboration | `VendorEvaluator` | ❌ 干扰 |
| `DeviceDeprecationPolicy.evaluate` | device-lifecycle | 无 | ❌ 干扰 |
| `CertificateRotationPolicy.evaluate` | device-lifecycle | 无 | ❌ 干扰 |
| `SlaBreachPolicy.evaluate` | sla-engine | 无 | ❌ 干扰 |
| `SlaMonitoringService.evaluate` | sla-engine | 无 | ❌ 干扰 |
| `NotificationRuleService.evaluate` | notification | 无 | ❌ 干扰 |
| `WorkOrderStatisticsService.evaluate` | workorder | 无 | ❌ 干扰 |

**总计：5 个目标 + 28 个干扰 = 33 个 `evaluate` 方法**

### 7.2 `regionCode` 字段干扰总表

| 类 | 字段名 | 语义 | Case C 修改目标 |
|----|--------|------|:---:|
| `DeviceInfo.regionCode` | `regionCode` | 设备维护区域 | ✅ 源字段 |
| `DeviceMetricEvent.deviceRegionCode` | `deviceRegionCode` | 设备区域 | ✅ 传播链 |
| `AlarmRecord.alarmRegionCode` | `alarmRegionCode` | 告警区域 | ✅ 传播链 |
| `AlarmEvent.deviceRegionCode` | `deviceRegionCode` | 告警事件区域 | ✅ 传播链 |
| `WorkOrder.maintenanceRegionCode` | `maintenanceRegionCode` | 工单维护区域 | ✅ 传播链 |
| `DashboardDeviceHealth.regionCode` | `regionCode` | 设备健康区域 | ✅ 传播链 |
| `DeviceHealthSummary.regionCode` | `regionCode` | 设备健康概要 | ✅ 传播链 |
| `Region.regionCode` | `regionCode` | 区域编码 | ❌ 干扰 |
| `OperatorUser.regionCode` | `regionCode` | 人员所属区域 | ❌ 干扰 |
| `RegionFilterRequest.regionCode` | `regionCode` | 过滤区域 | ❌ 干扰 |
| `NetworkSlice.regionCode` | `regionCode` | 切片区域 | ❌ 干扰 |
| `MaintenancePlan.regionCode` | `regionCode` | 维护计划区域 | ❌ 干扰 |
| `ShiftSchedule.regionCode` | `regionCode` | 排班区域 | ❌ 干扰 |
| `TopologyNode.regionCode` | `regionCode` | 拓扑节点区域 | ❌ 干扰 |
| `FederatedAlarmRecord.sourceRegionCode` | `sourceRegionCode` | 联邦告警源区域 | ❌ 干扰 |
| `DispatchOrder.targetRegionCode` | `targetRegionCode` | 调度目标区域 | ❌ 干扰 |
| `VendorTicket.vendorRegionCode` | `vendorRegionCode` | 厂商区域 | ❌ 干扰 |
| `SlaContract.regionCode` | `regionCode` | SLA 合同区域 | ❌ 干扰 |

**总计：7 个目标 + 11 个干扰 = 18 个 `regionCode` 相关字段**

### 7.3 其他高频方法名噪音

| 方法名 | 出现模块数 | 出现频次 | 干扰强度 |
|--------|----------:|---------:|:--------:|
| `process` | 10+ | 25+ | 🔴 极高 |
| `evaluate` | 8+ | 33+ | 🔴 极高 |
| `resolve` | 6+ | 15+ | 🟠 高 |
| `send` | 4+ | 10+ | 🟠 高 |
| `publish` | 8+ | 15+ | 🟠 高 |
| `create` | 8+ | 15+ | 🟠 高 |
| `normalize` | 4+ | 8+ | 🟡 中 |
| `validate` | 6+ | 12+ | 🟠 高 |
| `calculate` | 6+ | 15+ | 🟠 高 |
| `transition` | 3+ | 3+ | 🟡 中 |
| `classify` | 3+ | 4+ | 🟡 中 |
| `aggregate` | 3+ | 5+ | 🟡 中 |
| `dispatch` | 2+ | 4+ | 🟡 中 |
| `monitor` | 2+ | 3+ | 🟡 中 |
| `detect` | 2+ | 3+ | 🟡 中 |
| `track` | 3+ | 4+ | 🟡 中 |
| `generate` | 3+ | 4+ | 🟡 中 |
| `check` | 4+ | 6+ | 🟡 中 |
| `match` | 3+ | 4+ | 🟡 中 |

## 8. Benchmark Case 扩展

### 8.1 现有 Case 维护

现有 Case A~I 的 ground truth 保持不变。如果新增代码创建了新的同名方法或干扰字段，必须在 ground truth 的 "干扰项" 章节补充新增的干扰内容。

### 8.2 新增 Case J~R

| Case ID | 类型 | 模块 | 任务 | 价值 |
|---------|------|------|------|------|
| **J** | L2 | dispatch | `DispatchRule.evaluate` 接口签名变更影响分析 | 多实现 + 大量 evaluate 噪音 |
| **K** | L1 | alarm-federated | 联邦告警汇聚执行流追踪 | 跨区域聚合链路 |
| **L** | L3 | device-lifecycle | 设备状态机新增 MAINTENANCE 状态 | 状态机修改 |
| **M** | L2 | sla-engine | `SlaCalculator.calculate` 签名变更影响 | 多实现 + calculate 噪音 |
| **N** | L1 | vendor-collaboration | 厂商协同单全流程追踪 | 跨服务流程 |
| **O** | L2 | device-lifecycle | `DeviceStateMachine.transition` 参数变更 | 状态机 + 同名 transition |
| **P** | L3 | ops-gateway | `DashboardHealthScoreService` 评分公式变更 | 字段/计算逻辑修改 |
| **Q** | L2 | notification | `NotificationRuleService.evaluate` 签名变更 | 新增 evaluate 干扰 |
| **R** | L3 | common-domain | `NetworkSlice.regionCode` 字段重命名 | 与 Case C 类似的 field rename |

### 8.3 Case J 详细设计：`DispatchRule.evaluate` 影响分析

**文件：** `docs/benchmark/v3/telecom/cases/telecom-case-j-dispatch-rule-impact.yaml`

**任务：**
```
如果给 DispatchRule.evaluate(DispatchContext context) 增加 DispatchConfig config 参数，
需要同步检查哪些实现类、调用方、Registry、DispatchEngine、测试和文档？
```

**Ground truth 必须包含：**
```text
DispatchRule (interface)
SkillMatchRule
LoadBalanceRule
ProximityRule
PriorityOverrideRule
DispatchRuleRegistry
DispatchEngine
DispatchScoringService
DispatchOrchestrationService
DispatchEngineTest
DispatchRuleTest
```

**干扰项（不应包含）：**
```text
RuleEvaluator.evaluate (不同接口，不同领域)
VendorEvaluator.evaluate (不同接口)
SlaEvaluator.evaluate (不实现任何接口)
DeviceDeprecationPolicy.evaluate (不实现 DispatchRule)
```

### 8.4 Case K 详细设计：联邦告警汇聚执行流

**文件：** `docs/benchmark/v3/telecom/cases/telecom-case-k-federated-alarm-flow.yaml`

**任务：**
```
请分析联邦告警从多个局站告警源上报，到汇聚、去重、关联、生成联邦告警的完整调用链。
```

**核心流程：**
```text
FederatedAlarmIngestController.ingestAlarm
  -> AlarmIngestionService.ingest
  -> FederatedAlarmSourceRegistry.resolve
  -> FederatedAlarmAggregationService.aggregate
  -> AggregationStrategy.aggregate
  -> FederatedAlarmDeduplicationService.deduplicate
  -> FederatedAlarmCorrelationService.correlate
  -> CorrelationRuleMatcher.match
  -> FederatedCorrelationEngine.correlate
  -> FederatedAlarmRepository.save
  -> AlarmFederationEventPublisher.publish
```

### 8.5 Case R 详细设计：`NetworkSlice.regionCode` 字段重命名

**文件：** `docs/benchmark/v3/telecom/cases/telecom-case-r-network-slice-region-rename.yaml`

**任务：**
```
将 NetworkSlice.regionCode 重命名为 sliceRegionCode，
同步更新所有引用、mapper、事件、fixture 和测试。
```

**干扰项：**
```text
DeviceInfo.regionCode (Case C 源字段，不应改)
Region.regionCode (不应改)
OperatorUser.regionCode (不应改)
MaintenancePlan.regionCode (不应改)
ShiftSchedule.regionCode (不应改)
TopologyNode.regionCode (不应改)
```

## 9. 接口与多态扩展

### 9.1 全局接口清单

| 接口 | 模块 | 实现数 | Benchmark Case |
|------|------|-------:|:-------------:|
| `VendorAdapter` | collector | 4 | Case G |
| `RuleEvaluator` | alarm-engine | 5 | Case B |
| `AssigneeSelector` | workorder | 3 | (Case A 旁支) |
| `EscalationPolicy` | workorder | 2 | (Case D 旁支) |
| `NotificationChannel` | notification | 3 | Case E |
| `AlarmEscalationPolicy` | alarm-engine | 2 | Case I 旁支 |
| `AlarmLifecycleHook` | alarm-engine | 3 | Case I 旁支 |
| `AggregationStrategy` | alarm-federated | 3 | Case K |
| `VendorEvaluator` | vendor-collaboration | 3 | Case N |
| `DispatchRule` | dispatch | 5 | **Case J** |
| `SlaCalculator` | sla-engine | 4 | **Case M** |
| `TemplateVariableResolver` | notification | 3 | Case E 旁支 |
| **总计** | 12 接口 | 40+ 实现 | |

### 9.2 接口实现约束

每个接口必须满足：

1. 至少通过接口类型变量调用（`RuleEvaluator evaluator = registry.resolve(...)`）
2. 至少有一个 registry / resolver / factory 类做分发
3. 至少有两个非目标同名方法出现在同模块中（如 `SlaEvaluator.evaluate` 不实现 `RuleEvaluator`）

## 10. 测试与 Fixture 扩展

### 10.1 测试配额

| 模块 | 当前 Test 类 | 目标 Test 类 | 新增 |
|------|:-----------:|:-----------:|:----:|
| `common-domain` | 11 | 15 | 4 |
| `common-test` | 0 | 0 | 0 (工具类) |
| `device-collector-service` | 16 | 20 | 4 |
| `device-lifecycle-service` | 0 | 15 | 15 |
| `alarm-engine-service` | 22 | 25 | 3 |
| `alarm-federated-service` | 0 | 18 | 18 |
| `workorder-service` | 21 | 25 | 4 |
| `vendor-collaboration-service` | 0 | 18 | 18 |
| `notification-service` | 9 | 18 | 9 |
| `dispatch-service` | 0 | 18 | 18 |
| `sla-engine-service` | 0 | 15 | 15 |
| `ops-gateway-service` | 10 | 20 | 10 |
| **合计** | **89** | **207** | **118** |

### 10.2 JSON Fixture 扩展

从当前 6 个扩展到 **30+ 个**：

```text
src/test/resources/fixtures/
  device-info/
    base-station-huawei.json              # 已有
    olt-zte.json                          # 新增
    router-fiberhome.json                 # 新增
    switch-cisco.json                     # 新增
  device-metric/
    cpu-critical.json                     # 已有
    optical-power-warning.json            # 已有
    memory-high-utilization.json          # 新增
    packet-loss-severe.json               # 新增
    temperature-over-threshold.json       # 新增
  device-lifecycle/
    device-activation-request.json        # 新增
    firmware-upgrade-event.json           # 新增
    certificate-expiry-event.json         # 新增
  alarm/
    alarm-critical-region-east.json       # 已有
    alarm-major-region-west.json          # 新增
    alarm-correlation-group.json          # 新增
    federated-alarm-multi-source.json     # 新增
    alarm-suppression-window.json         # 新增
  workorder/
    auto-created-critical-alarm.json      # 已有
    workorder-waiting-vendor.json         # 新增
    workorder-sla-breach.json             # 新增
    workorder-escalated.json              # 新增
    bulk-workorder-close-request.json     # 新增
  dashboard/
    device-health-summary.json            # 已有
    dashboard-drilldown-response.json     # 新增
    dashboard-region-summary.json         # 新增
    dashboard-trend-response.json         # 新增
  vendor/
    vendor-ticket-created.json            # 新增
    vendor-sla-report.json                # 新增
    vendor-feedback-submitted.json        # 新增
  sla/
    sla-contract-definition.json          # 新增
    sla-breach-event.json                 # 新增
    sla-metric-snapshot.json              # 新增
  dispatch/
    dispatch-order-created.json           # 新增
    dispatch-rule-config.json             # 新增
  notification/
    notification-batch-request.json       # 新增
    notification-retry-event.json         # 新增
```

## 11. 执行流程扩展

### 11.1 新增核心执行流

| 执行流名称 | 入口 | 终点 | Case |
|-----------|------|------|:----:|
| 设备采集→标准化→事件发布 | `POST /api/devices/{id}/metrics` | `MetricEventPublisher` | A |
| 指标事件→告警评估→告警事件 | `DeviceMetricEventConsumer` | `AlarmEventPublisher` | A |
| 告警事件→自动工单→派单 | `AlarmEventConsumer` | `WorkOrderEventPublisher` | A |
| 工单事件→通知发送 | `WorkOrderEventConsumer` | `NotificationChannel.send` | E |
| **联邦告警汇聚流** | `POST /api/federated/alarms` | `AlarmFederationEventPublisher` | **K** |
| **调度引擎派单流** | `POST /api/dispatch/assign` | `WorkOrderAssignmentEventConsumer` | **J** |
| **设备生命周期流** | `POST /api/devices/lifecycle` | `DeviceLifecycleEventPublisher` | **L** |
| **SLA 违约检测流** | `WorkOrderSlaEventConsumer` | `SlaBreachEventPublisher` | **M** |
| **厂商协同工单流** | `POST /api/vendor/tickets` | `VendorTicketEventPublisher` | **N** |
| **看板 Drill-down 流** | `GET /api/dashboard/regions/{code}/drilldown` | `DashboardDrilldownService` | **F** |

### 11.2 事件链跨服务总图

```text
DeviceMetricEvent
  -> DeviceMetricEventConsumer (alarm-engine)

AlarmEvent
  -> AlarmEventConsumer (workorder)

WorkOrderEvent
  -> WorkOrderEventConsumer (notification)

WorkOrderAssignmentEvent
  -> WorkOrderAssignmentEventConsumer (dispatch)

AlarmFederationEvent
  -> FederatedAlarmEventConsumer (alarm-federated)

DeviceLifecycleEvent
  -> DeviceLifecycleEventConsumer (device-lifecycle)

SlaBreachEvent
  -> SlaBreachEventConsumer (sla-engine)

VendorTicketEvent
  -> VendorTicketEventConsumer (vendor-collaboration)
```

每个事件链必须通过 `DomainEventBus` 桥接，形成静态可见的方法调用边。

## 12. 同名符号噪音密度

50,000 行规模的噪音密度目标：

| 指标 | 当前（12K） | 目标（50K） |
|------|:----------:|:----------:|
| `evaluate` 出现次数 | ~15 | 50+ |
| `regionCode` 出现次数 | ~30 | 80+ |
| `process` 出现次数 | ~10 | 40+ |
| `resolve` 出现次数 | ~8 | 25+ |
| `send` 出现次数 | ~6 | 20+ |
| `publish` 出现次数 | ~10 | 30+ |
| `create` 出现次数 | ~15 | 40+ |
| `calculate` 出现次数 | ~3 | 25+ |
| 接口总数 | 5 | 12+ |
| 接口实现类总数 | 15+ | 40+ |
| 总 Java 类数 | 304 | 750+ |
| 总 Java 行数 | 12,387 | 50,000 |

## 13. 分阶段实施计划

### Phase 1：骨架与 common-test（2~3 天）

```
目标：新增 2 个模块骨架 + common-test 模块 + 所有 pom.xml 更新
文件：新增 ~15 个文件，~1,500 行
验收：mvn -q compile 通过
```

**具体任务：**
1. 更新 root pom.xml，从 6 个 module 扩展到 12 个
2. 创建 6 个新模块的 pom.xml
3. 实现 `common-test` 模块的测试工具类
4. 创建新模块的 Spring Boot Application 类和包目录

### Phase 2：`device-lifecycle-service`（3~4 天）

```
目标：完整实现设备生命周期管理模块
文件：新增 ~40 个文件，~4,000 行
验收：mvn -pl device-lifecycle-service test 通过
```

### Phase 3：`alarm-federated-service`（3~4 天）

```
目标：完整实现联邦告警汇聚模块
文件：新增 ~45 个文件，~5,000 行
验收：mvn -pl alarm-federated-service test 通过
```

### Phase 4：`vendor-collaboration-service`（3~4 天）

```
目标：完整实现厂商协同模块
文件：新增 ~40 个文件，~4,500 行
验收：mvn -pl vendor-collaboration-service test 通过
```

### Phase 5：`dispatch-service`（3~4 天）

```
目标：完整实现调度引擎模块
文件：新增 ~40 个文件，~4,500 行
验收：mvn -pl dispatch-service test 通过
```

### Phase 6：`sla-engine-service`（2~3 天）

```
目标：完整实现 SLA 引擎模块
文件：新增 ~35 个文件，~4,000 行
验收：mvn -pl sla-engine-service test 通过
```

### Phase 7：现有模块扩容（5~7 天）

```
目标：将 6 个现有模块扩容到目标行数
文件：新增 ~100 个文件，~10,000 行
验收：每个模块的 mvn test 通过
```

**具体每个模块的增量：**
- `common-domain`: +1,500 行
- `device-collector-service`: +2,700 行
- `alarm-engine-service`: +3,100 行
- `workorder-service`: +3,600 行
- `notification-service`: +2,800 行
- `ops-gateway-service`: +4,300 行

### Phase 8：Benchmark case 补齐（2~3 天）

```
目标：新增 Case J~R 的 YAML 和 ground truth
文件：新增 ~18 个 YAML 文件
验收：所有 case 的 ground truth 与实际代码一致
```

### Phase 9：最终集成验证（1~2 天）

```
目标：确保全项目 mvn test 通过
验收命令：
  mvn test
  find . -name "*.java" -not -path "*/node_modules/*" | wc -l
  find . -name "*.java" -exec cat {} + | wc -l
```

## 14. 验收标准

### 14.1 量化验收

| 检查项 | 标准 |
|--------|------|
| `mvn test` | 通过 |
| Java 总行数 | >= 50,000 |
| Main Java 类 | >= 550 |
| Test Java 类 | >= 200 |
| JSON fixture 文件 | >= 30 |
| Benchmark case YAML（含 ground truth） | >= 18 (A~R) |
| Maven 模块 | 12 个 |
| `evaluate` 方法数 | >= 30 |
| `regionCode` 相关字段数 | >= 15 |
| 接口数 | >= 12 |
| 接口实现类数 | >= 40 |
| `return null` 非业务桩 | 0 |
| `DomainEventBus` + `InMemoryDomainEventBus` | 存在且真实调用 consumer |

### 14.2 质量验收

- 每个 service 至少有 3 个 public 方法 + 1 个 private helper
- 每个 repository 至少有 5 个方法
- 每个 mapper 至少有 5 个方法
- 每个测试类至少有 3 个 `@Test`
- 没有空类、注释堆行数、无意义 getter/setter 堆行数
- 所有接口都通过接口类型变量调用（不直接 `new` 实现类）
- 事件链通过 `DomainEventBus` 桥接，形成静态可见的方法调用边
- 新增的 `evaluate` / `regionCode` 噪音不污染现有 Case B / Case C 的 ground truth

## 15. 命令参考

### 15.1 统计命令

PowerShell：
```powershell
$root='C:\qinliuwei\code\Gitnexus-benchmark\telecom-ops-platform-large'
$main=(Get-ChildItem -Recurse -Path $root -Filter *.java | Where-Object { $_.FullName -like '*\src\main\java\*' })
$test=(Get-ChildItem -Recurse -Path $root -Filter *.java | Where-Object { $_.FullName -like '*\src\test\java\*' })
$all=(Get-ChildItem -Recurse -Path $root -Filter *.java)
$lines=0; foreach($f in $all){ $lines += (Get-Content -LiteralPath $f.FullName | Measure-Object -Line).Lines }
[pscustomobject]@{MainJava=$main.Count; TestJava=$test.Count; AllJava=$all.Count; JavaLines=$lines}
```

Bash：
```bash
root="C:/qinliuwei/code/Gitnexus-benchmark/telecom-ops-platform-large"
find "$root" -path "*/src/main/java/*.java" | wc -l
find "$root" -path "*/src/test/java/*.java" | wc -l
find "$root" -name "*.java" -exec cat {} + | wc -l
```

### 15.2 噪音密度检查

```bash
grep -r "\.evaluate(" --include="*.java" | wc -l
grep -r "regionCode" --include="*.java" | wc -l
grep -r "\.process(" --include="*.java" | wc -l
grep -r "\.resolve(" --include="*.java" | wc -l
grep -r "interface.*{" --include="*.java" | wc -l
```

### 15.3 关键调用链验证

```bash
grep -r "class InMemoryDomainEventBus" --include="*.java" .
grep -r "metricConsumer.onMetric" --include="*.java" .
grep -r "alarmConsumer.onAlarmCreated" --include="*.java" .
grep -r "RuleEvaluator evaluator" --include="*.java" .
grep -r "DispatchRule rule" --include="*.java" .
grep -r "SlaCalculator calculator" --include="*.java" .
```
