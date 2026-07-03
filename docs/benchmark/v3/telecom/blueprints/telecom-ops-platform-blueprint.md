# Telecom Ops Platform 测试项目蓝图

## 1. 目标

本蓝图用于设计一个可生成、可索引、可评测的 Java/Spring Boot 合成微服务项目，作为 GitNexus 在 AI Coding 场景下对比传统 `grep` / `rg` / 文件读取能力的实验数据集。

项目不追求真实上线能力，但要满足三类要求：

1. **企业项目形态真实**：多微服务、分层架构、事件流、状态机、策略模式、DTO / Entity / Mapper / Repository / Test fixture。
2. **图谱优势可测量**：内置同名符号、多态接口、跨模块执行流、字段传播、改后影响校验等结构。
3. **Ground truth 可审计**：每个 benchmark case 都有明确入口、必要文件、关键符号、干扰项、验证命令和评分口径。

业务背景：

> 运营商网络运维平台。系统采集设备运行指标，标准化后进入告警引擎；告警引擎根据阈值和规则生成告警；告警达到预警线后自动创建工单；人工接单、派单、处理、升级和关闭工单；看板服务聚合设备健康、告警和工单数据。

## 2. 非目标

- 不连接真实 Kafka、Redis、MySQL、设备网管或内网服务。
- 不实现完整生产级安全、权限、审计、配置中心。
- 不模拟复杂前端，只保留 API 和 DTO。
- 不让 benchmark 依赖运行时环境。核心 case 应可通过静态代码理解、单元测试和 Maven 编译验证。

## 3. 技术选型

推荐：

| 项 | 选择 |
| --- | --- |
| Java | 17 |
| Framework | Spring Boot 3.x 风格 |
| Build | Maven multi-module |
| Tests | JUnit 5 |
| Persistence | In-memory repository |
| Event | 接口模拟 publisher / consumer，不依赖真实 broker |
| API | Spring MVC 注解 |

项目应能执行：

```bash
mvn test
```

可选执行：

```bash
mvn -q -DskipTests compile
```

## 4. 仓库结构

建议独立仓库名：

```text
telecom-ops-platform/
  pom.xml
  README.md
  docs/
    architecture.md
    benchmark-cases/
      telecom-case-a-metric-to-workorder-flow.yaml
      telecom-case-b-rule-evaluator-impact.yaml
      telecom-case-c-region-code-rename.yaml
      ground-truth/
        telecom-case-a-ground-truth.yaml
        telecom-case-b-ground-truth.yaml
        telecom-case-c-ground-truth.yaml
  common-domain/
    pom.xml
    src/main/java/com/example/telecom/common/...
    src/test/java/com/example/telecom/common/...
  device-collector-service/
    pom.xml
    src/main/java/com/example/telecom/collector/...
    src/test/java/com/example/telecom/collector/...
  alarm-engine-service/
    pom.xml
    src/main/java/com/example/telecom/alarm/...
    src/test/java/com/example/telecom/alarm/...
  workorder-service/
    pom.xml
    src/main/java/com/example/telecom/workorder/...
    src/test/java/com/example/telecom/workorder/...
  notification-service/
    pom.xml
    src/main/java/com/example/telecom/notification/...
    src/test/java/com/example/telecom/notification/...
  ops-gateway-service/
    pom.xml
    src/main/java/com/example/telecom/gateway/...
    src/test/java/com/example/telecom/gateway/...
```

### 4.1 Maven 依赖矩阵

实现模型必须按下面矩阵配置模块依赖，避免循环依赖或所有模块互相依赖。

| 模块 | 允许依赖 | 禁止依赖 |
| --- | --- | --- |
| `common-domain` | 无业务模块依赖；只允许 JDK、测试依赖、必要 annotation 依赖 | 任何 service module |
| `device-collector-service` | `common-domain` | `alarm-engine-service`、`workorder-service`、`notification-service`、`ops-gateway-service` |
| `alarm-engine-service` | `common-domain` | `device-collector-service`、`workorder-service`、`notification-service`、`ops-gateway-service` |
| `workorder-service` | `common-domain` | `device-collector-service`、`alarm-engine-service`、`notification-service`、`ops-gateway-service` |
| `notification-service` | `common-domain` | `device-collector-service`、`alarm-engine-service`、`workorder-service`、`ops-gateway-service` |
| `ops-gateway-service` | `common-domain` | 直接依赖其他 service module；跨服务查询用 fake client 类模拟 |

跨服务流程不要靠 Maven 依赖互调实现，而要通过共享 event 类型、`DomainEventBus` 和 fake client 表达。这样项目既像微服务，又能让静态分析看到关键调用边。

Root `pom.xml` 必须声明 6 个 module：

```xml
<modules>
  <module>common-domain</module>
  <module>device-collector-service</module>
  <module>alarm-engine-service</module>
  <module>workorder-service</module>
  <module>notification-service</module>
  <module>ops-gateway-service</module>
</modules>
```

## 5. 规模约束

目标规模：

| 模块 | Main 类数量 | Test 类数量 | 目标代码量 |
| --- | ---: | ---: | ---: |
| `common-domain` | 24 | 3 | 1800 行 |
| `device-collector-service` | 24 | 5 | 2100 行 |
| `alarm-engine-service` | 28 | 7 | 2600 行 |
| `workorder-service` | 30 | 7 | 2800 行 |
| `notification-service` | 18 | 4 | 1500 行 |
| `ops-gateway-service` | 18 | 4 | 1500 行 |
| **合计** | **142** | **30** | **12300 行左右** |

行数不应通过无意义注释填充。建议通过 DTO、校验、mapper、策略、repository、测试 fixture 和状态机自然形成代码量。

## 6. 模块设计

### 6.1 `common-domain`

职责：

- 共享领域对象、事件、枚举、基础响应对象。
- 承载跨服务字段传播 case。

建议包结构：

```text
com.example.telecom.common
  api
  audit
  device
  alarm
  workorder
  event
  user
  region
  exception
```

建议类清单：

| 类 | 类型 | 说明 |
| --- | --- | --- |
| `ApiResponse<T>` | DTO | 统一响应包装 |
| `PagedResult<T>` | DTO | 分页结果 |
| `AuditEntry` | Domain | 审计记录 |
| `DomainException` | Exception | 基础业务异常 |
| `ValidationException` | Exception | 参数校验异常 |
| `DeviceInfo` | Domain | 设备基础信息，包含 `regionCode` |
| `DeviceMetric` | Domain | 标准化设备指标 |
| `RawDeviceMetric` | DTO | 原始厂商指标 |
| `DeviceMetricEvent` | Event | 指标事件 |
| `DeviceType` | Enum | `BASE_STATION`, `OLT`, `ROUTER`, `SWITCH` |
| `MetricType` | Enum | `CPU_USAGE`, `MEMORY_USAGE`, `OPTICAL_POWER`, `PACKET_LOSS`, `TEMPERATURE` |
| `AlarmRecord` | Domain | 告警记录 |
| `AlarmEvent` | Event | 告警事件 |
| `AlarmStatus` | Enum | `OPEN`, `ACKED`, `CLEARED` |
| `Severity` | Enum | `INFO`, `WARNING`, `MAJOR`, `CRITICAL` |
| `ThresholdRule` | Domain | 阈值规则 |
| `EvaluationResult` | Domain | 规则评估结果 |
| `EvaluationContext` | Domain | 规则评估上下文，Case B 可新增/强化 |
| `WorkOrder` | Domain | 工单 |
| `WorkOrderEvent` | Event | 工单事件 |
| `WorkOrderStatus` | Enum | 工单状态 |
| `WorkOrderPriority` | Enum | 工单优先级 |
| `OperatorUser` | Domain | 运维人员 |
| `Region` | Domain | 区域，保留 `regionCode` 作为 Case C 干扰项 |

关键字段设计：

```java
DeviceInfo {
  String deviceId;
  String deviceName;
  DeviceType deviceType;
  String vendor;
  String regionCode;
  String siteCode;
  String managementIp;
  boolean active;
}
```

干扰字段：

- `Region.regionCode`：区域实体自身编码，不应随 `DeviceInfo.regionCode` case 自动改名。
- `OperatorUser.regionCode`：人员所属区域，不应被误改为设备维护区域。

### 6.2 `device-collector-service`

职责：

- 管理设备注册信息。
- 接收设备指标。
- 根据厂商做原始指标适配。
- 标准化并发布 `DeviceMetricEvent`。

建议包结构：

```text
com.example.telecom.collector
  controller
  service
  repository
  adapter
  event
  mapper
  validator
  config
```

建议类清单：

| 类 | 类型 | 说明 |
| --- | --- | --- |
| `DeviceCollectorApplication` | App | Spring Boot 入口 |
| `DeviceMetricIngestController` | Controller | `POST /api/devices/{deviceId}/metrics` |
| `DeviceRegistryController` | Controller | 设备注册查询 |
| `CollectorHealthController` | Controller | 采集服务健康状态 |
| `DeviceRegistryService` | Service | 查找、注册、停用设备 |
| `MetricCollectorService` | Service | 接收指标主流程 |
| `DeviceMetricNormalizer` | Service | 标准化指标 |
| `DeviceMetricValidator` | Validator | 指标合法性 |
| `DeviceMetricMapper` | Mapper | request / domain 转换 |
| `DeviceMetricRepository` | Repository | 指标内存存储 |
| `DeviceRegistryRepository` | Repository | 设备信息内存存储 |
| `MetricEventPublisher` | Event | 发布 `DeviceMetricEvent` |
| `CollectorAuditService` | Service | 记录采集审计 |
| `CollectorClock` | Utility | 时间抽象，方便测试 |
| `VendorAdapter` | Interface | 厂商适配接口 |
| `HuaweiVendorAdapter` | Impl | 华为指标适配 |
| `ZteVendorAdapter` | Impl | 中兴指标适配 |
| `FiberHomeVendorAdapter` | Impl | 烽火指标适配 |
| `GenericSnmpVendorAdapter` | Impl | 通用 SNMP 适配 |
| `VendorAdapterRegistry` | Registry | 根据 vendor 选择 adapter |
| `MetricIngestRequest` | DTO | 指标上报请求 |
| `DeviceRegistrationRequest` | DTO | 设备注册请求 |
| `DeviceMetricResponse` | DTO | 指标响应 |
| `CollectorProperties` | Config | 采集配置 |

核心接口：

```java
public interface VendorAdapter {
  DeviceMetric normalizeRawMetric(RawDeviceMetric rawMetric, DeviceInfo deviceInfo);
}
```

核心流程：

```text
DeviceMetricIngestController.ingestMetric
  -> DeviceRegistryService.findActiveDevice
  -> VendorAdapterRegistry.resolve
  -> VendorAdapter.normalizeRawMetric
  -> MetricCollectorService.acceptMetric
  -> DeviceMetricValidator.validate
  -> DeviceMetricNormalizer.normalize
  -> DeviceMetricRepository.save
  -> MetricEventPublisher.publish
```

### 6.3 `alarm-engine-service`

职责：

- 消费 `DeviceMetricEvent`。
- 加载阈值规则。
- 调用策略评估器生成评估结果。
- 分类告警等级、去重、关联。
- 保存告警并发布 `AlarmEvent`。

建议包结构：

```text
com.example.telecom.alarm
  controller
  consumer
  service
  repository
  rule
  event
  mapper
  config
```

建议类清单：

| 类 | 类型 | 说明 |
| --- | --- | --- |
| `AlarmEngineApplication` | App | Spring Boot 入口 |
| `AlarmController` | Controller | 告警查询和确认 |
| `ThresholdRuleController` | Controller | 阈值规则维护 |
| `DeviceMetricEventConsumer` | Consumer | 消费指标事件 |
| `AlarmEvaluationService` | Service | 告警评估主流程 |
| `ThresholdRuleService` | Service | 规则加载 |
| `AlarmSeverityClassifier` | Service | 告警级别分类 |
| `AlarmDeduplicationService` | Service | 告警去重 |
| `AlarmCorrelationService` | Service | 告警关联 |
| `AlarmLifecycleService` | Service | 告警确认、清除 |
| `AlarmRepository` | Repository | 告警存储 |
| `ThresholdRuleRepository` | Repository | 规则存储 |
| `AlarmEventPublisher` | Event | 发布告警事件 |
| `AlarmAuditService` | Service | 告警审计 |
| `AlarmRecordMapper` | Mapper | DTO / domain 转换 |
| `RuleEvaluator` | Interface | 规则评估接口 |
| `CpuUsageRuleEvaluator` | Impl | CPU 阈值 |
| `MemoryUsageRuleEvaluator` | Impl | 内存阈值 |
| `OpticalPowerRuleEvaluator` | Impl | 光功率阈值 |
| `PacketLossRuleEvaluator` | Impl | 丢包阈值 |
| `TemperatureRuleEvaluator` | Impl | 温度阈值 |
| `RuleEvaluatorRegistry` | Registry | 根据指标类型选择 evaluator |
| `AlarmQueryRequest` | DTO | 告警查询请求 |
| `AlarmResponse` | DTO | 告警响应 |
| `ThresholdRuleRequest` | DTO | 阈值规则请求 |
| `AlarmEngineProperties` | Config | 告警配置 |
| `SlaEvaluator` | Service | SLA 评估，制造 `evaluate` 干扰 |
| `RiskEvaluator` | Service | 风险评估，制造 `evaluate` 干扰 |

核心接口：

```java
public interface RuleEvaluator {
  EvaluationResult evaluate(DeviceMetric metric, ThresholdRule rule);
}
```

Case B 的变更目标：

```java
EvaluationResult evaluate(DeviceMetric metric, ThresholdRule rule, EvaluationContext context);
```

核心流程：

```text
DeviceMetricEventConsumer.onMetric
  -> AlarmEvaluationService.evaluate
  -> ThresholdRuleService.loadRules
  -> RuleEvaluatorRegistry.resolve
  -> RuleEvaluator.evaluate
  -> AlarmSeverityClassifier.classify
  -> AlarmDeduplicationService.deduplicate
  -> AlarmCorrelationService.correlate
  -> AlarmRepository.save
  -> AlarmEventPublisher.publish
```

### 6.4 `workorder-service`

职责：

- 消费 `AlarmEvent`。
- 达到预警线后自动生成工单。
- 支持派单、接单、处理中、升级、解决、关闭。
- 管理工单状态机和审计。

建议包结构：

```text
com.example.telecom.workorder
  controller
  consumer
  service
  repository
  workflow
  assignment
  event
  mapper
  config
```

建议类清单：

| 类 | 类型 | 说明 |
| --- | --- | --- |
| `WorkOrderApplication` | App | Spring Boot 入口 |
| `WorkOrderController` | Controller | 工单 API |
| `WorkOrderFlowController` | Controller | 状态流转 API |
| `AlarmEventConsumer` | Consumer | 消费告警事件 |
| `AutoWorkOrderService` | Service | 告警转自动工单 |
| `WorkOrderFlowService` | Service | 工单流转 |
| `WorkOrderAssignmentService` | Service | 派单 |
| `WorkOrderEscalationService` | Service | 升级 |
| `WorkOrderAuditService` | Service | 工单审计 |
| `WorkOrderSlaService` | Service | SLA 计算 |
| `WorkOrderRepository` | Repository | 工单存储 |
| `WorkOrderStateMachine` | Workflow | 状态机 |
| `WorkOrderEventPublisher` | Event | 发布工单事件 |
| `WorkOrderMapper` | Mapper | DTO / domain 转换 |
| `AssigneeSelector` | Interface | 派单策略 |
| `RegionBasedAssigneeSelector` | Impl | 按区域派单 |
| `SkillBasedAssigneeSelector` | Impl | 按技能派单 |
| `LoadBalancedAssigneeSelector` | Impl | 按负载派单 |
| `AssigneeSelectorRegistry` | Registry | 选择派单策略 |
| `EscalationPolicy` | Interface | 升级策略 |
| `SeverityEscalationPolicy` | Impl | 按告警级别升级 |
| `SlaEscalationPolicy` | Impl | 按 SLA 升级 |
| `WorkOrderCreateRequest` | DTO | 创建工单请求 |
| `WorkOrderTransitionRequest` | DTO | 状态流转请求 |
| `WorkOrderResponse` | DTO | 工单响应 |
| `AssignmentResponse` | DTO | 派单响应 |
| `WorkOrderProperties` | Config | 工单配置 |
| `WorkOrderFixtureFactory` | Test Utility | 测试 fixture |

状态机：

```text
CREATED -> ASSIGNED
ASSIGNED -> PROCESSING
PROCESSING -> RESOLVED
RESOLVED -> CLOSED
PROCESSING -> ESCALATED
ESCALATED -> PROCESSING
ASSIGNED -> CANCELLED
```

第二批可选修改 case：

```text
新增 WAITING_VENDOR 状态：
PROCESSING -> WAITING_VENDOR
WAITING_VENDOR -> PROCESSING
WAITING_VENDOR -> RESOLVED
```

核心流程：

```text
AlarmEventConsumer.onAlarmCreated
  -> AutoWorkOrderService.createForAlarm
  -> WorkOrderRepository.save
  -> WorkOrderFlowService.assign
  -> WorkOrderAssignmentService.assign
  -> AssigneeSelectorRegistry.resolve
  -> AssigneeSelector.select
  -> WorkOrderStateMachine.transition
  -> WorkOrderEventPublisher.publish
```

### 6.5 `notification-service`

职责：

- 消费工单事件。
- 根据模板和渠道发送通知。
- 记录通知审计。

建议包结构：

```text
com.example.telecom.notification
  controller
  consumer
  service
  repository
  channel
  template
  mapper
  config
```

建议类清单：

| 类 | 类型 | 说明 |
| --- | --- | --- |
| `NotificationApplication` | App | Spring Boot 入口 |
| `NotificationController` | Controller | 通知查询和重发 |
| `WorkOrderEventConsumer` | Consumer | 消费工单事件 |
| `NotificationService` | Service | 通知主流程 |
| `NotificationTemplateService` | Service | 模板渲染 |
| `NotificationAuditService` | Service | 审计 |
| `NotificationRepository` | Repository | 通知记录 |
| `NotificationMapper` | Mapper | DTO / domain 转换 |
| `NotificationChannel` | Interface | 发送渠道 |
| `SmsNotificationChannel` | Impl | 短信 |
| `EmailNotificationChannel` | Impl | 邮件 |
| `WeComNotificationChannel` | Impl | 企业微信 |
| `NotificationChannelRegistry` | Registry | 渠道选择 |
| `NotificationTemplate` | Domain | 模板 |
| `NotificationRecord` | Domain | 通知记录 |
| `NotificationRequest` | DTO | 通知请求 |
| `NotificationResponse` | DTO | 通知响应 |
| `NotificationProperties` | Config | 通知配置 |

核心接口：

```java
public interface NotificationChannel {
  SendResult send(NotificationRequest request);
}
```

干扰点：

- 多个类使用 `send()`、`render()`、`process()`。
- 可用于第二批同名符号噪音 case。

### 6.6 `ops-gateway-service`

职责：

- 提供运维看板 API。
- 聚合设备、告警、工单概要。
- 模拟跨服务客户端调用。

建议包结构：

```text
com.example.telecom.gateway
  controller
  service
  client
  mapper
  dto
  config
```

建议类清单：

| 类 | 类型 | 说明 |
| --- | --- | --- |
| `OpsGatewayApplication` | App | Spring Boot 入口 |
| `OpsDashboardController` | Controller | 看板 API |
| `DeviceOverviewController` | Controller | 设备视图 API |
| `AlarmOverviewController` | Controller | 告警视图 API |
| `WorkOrderOverviewController` | Controller | 工单视图 API |
| `DashboardAggregationService` | Service | 聚合主流程 |
| `OpsQueryService` | Service | 查询编排 |
| `DeviceClient` | Client | 模拟设备服务客户端 |
| `AlarmClient` | Client | 模拟告警服务客户端 |
| `WorkOrderClient` | Client | 模拟工单服务客户端 |
| `DashboardResponseMapper` | Mapper | 看板响应转换 |
| `DeviceHealthSummary` | DTO | 设备健康概要 |
| `AlarmSummary` | DTO | 告警概要 |
| `WorkOrderSummary` | DTO | 工单概要 |
| `DashboardResponse` | DTO | 看板响应 |
| `RegionFilterRequest` | DTO | 区域过滤请求 |
| `GatewayAuditService` | Service | 网关审计 |
| `DashboardHealthEvaluator` | Service | 看板健康度评估，制造 `evaluate` 干扰 |
| `OpsGatewayProperties` | Config | 网关配置 |

核心流程：

```text
OpsDashboardController.getDeviceHealth
  -> DashboardAggregationService.aggregateDeviceHealth
  -> DeviceClient.fetchDeviceSummary
  -> AlarmClient.fetchActiveAlarmSummary
  -> WorkOrderClient.fetchOpenWorkOrderSummary
  -> DashboardResponseMapper.toResponse
```

## 7. 跨服务事件链

项目应显式保留 publisher / consumer 类，即使事件只在测试中通过内存调用模拟。

**硬性约束：事件链必须通过显式 Java 方法调用连接。** 不允许只靠类名、注释、README 或“发布事件后另一个服务理论上消费”的语义关联来表达跨服务流程。否则静态图谱无法稳定建立调用链，Case A 会退化成人工脑补流程，不适合作为可审计 benchmark。

```text
MetricEventPublisher.publish(DeviceMetricEvent)
  -> DeviceMetricEventConsumer.onMetric(DeviceMetricEvent)

AlarmEventPublisher.publish(AlarmEvent)
  -> AlarmEventConsumer.onAlarmCreated(AlarmEvent)

WorkOrderEventPublisher.publish(WorkOrderEvent)
  -> WorkOrderEventConsumer.onWorkOrderChanged(WorkOrderEvent)
```

在源码中建议把 producer 和 consumer 放在不同模块，形成跨模块追踪场景。

推荐增加一个轻量事件桥：

```java
public interface DomainEventBus {
  void publish(DeviceMetricEvent event);
  void publish(AlarmEvent event);
  void publish(WorkOrderEvent event);
}
```

测试项目中提供内存实现：

```java
public class InMemoryDomainEventBus implements DomainEventBus {
  private final DeviceMetricEventConsumer metricConsumer;
  private final AlarmEventConsumer alarmConsumer;
  private final WorkOrderEventConsumer workOrderConsumer;

  @Override
  public void publish(DeviceMetricEvent event) {
    metricConsumer.onMetric(event);
  }

  @Override
  public void publish(AlarmEvent event) {
    alarmConsumer.onAlarmCreated(event);
  }

  @Override
  public void publish(WorkOrderEvent event) {
    workOrderConsumer.onWorkOrderChanged(event);
  }
}
```

各业务 publisher 不直接调用 consumer，而是调用 `DomainEventBus`：

```text
MetricEventPublisher.publish
  -> DomainEventBus.publish(DeviceMetricEvent)
  -> InMemoryDomainEventBus.publish(DeviceMetricEvent)
  -> DeviceMetricEventConsumer.onMetric
```

这样设计的目的不是模拟真实 MQ，而是为静态分析提供可见的事件桥。后续如果要模拟真实 Kafka，可另建第二套 adapter，但第一批 benchmark 必须保留这条显式方法调用路径。

## 8. 故意设计的检索难点

### 8.1 同名方法噪音

以下方法名应在多个模块重复出现：

| 方法名 | 出现位置 | 用途 |
| --- | --- | --- |
| `process` | service、consumer、channel | 制造高频通用动作噪音 |
| `evaluate` | rule、SLA、risk、policy | Case B 干扰项 |
| `create` | order、alarm、request、event | 常见创建动作 |
| `publish` | metric、alarm、workorder event | 事件发布链 |
| `send` | notification、client、publisher | 通知/客户端干扰 |
| `normalize` | metric、vendor、mapper | 采集标准化干扰 |
| `resolve` | registry、state machine、client | 注册表/解析干扰 |
| `validate` | validator、service、state machine | 校验干扰 |

### 8.2 接口和多态

至少保留这些接口：

| 接口 | 实现数 | 主要验证点 |
| --- | ---: | --- |
| `VendorAdapter` | 4 | 厂商适配多态 |
| `RuleEvaluator` | 5 | 规则评估影响分析 |
| `AssigneeSelector` | 3 | 派单策略 |
| `EscalationPolicy` | 2 | 工单升级策略 |
| `NotificationChannel` | 3 | 通知发送渠道 |

接口实现约束：

- `RuleEvaluator.evaluate` 必须通过接口类型调用，不能让 `AlarmEvaluationService` 直接 `new CpuUsageRuleEvaluator()` 或直接调用具体类。
- 每个接口至少有一个 registry / resolver 类，用于制造真实企业项目里的间接分发路径。
- 非目标同名方法必须存在，但不能参与目标链路。例如 `SlaEvaluator.evaluate` 和 `RiskEvaluator.evaluate` 不能实现 `RuleEvaluator`。
- 至少一个目标实现类应包含重载方法，制造 grep 噪音，但 ground truth 必须明确哪个签名才是目标。

推荐写法：

```java
RuleEvaluator evaluator = ruleEvaluatorRegistry.resolve(rule.getMetricType());
EvaluationResult result = evaluator.evaluate(metric, rule);
```

不推荐写法：

```java
EvaluationResult result = new CpuUsageRuleEvaluator().evaluate(metric, rule);
```

### 8.3 字段传播与干扰

主字段：

```text
DeviceInfo.regionCode
```

应传播到：

- `DeviceMetricEvent.deviceRegionCode`
- `AlarmRecord.deviceRegionCode`
- `AlarmEvent.deviceRegionCode`
- `WorkOrder.maintenanceRegionCode`
- `DashboardResponse.regionCode` 或 `DeviceHealthSummary.regionCode`
- 测试 fixture JSON

干扰字段：

- `Region.regionCode`
- `OperatorUser.regionCode`
- `RegionFilterRequest.regionCode`

Case C 评分时必须区分这些字段是否与 `DeviceInfo.regionCode` 同一语义。

字段传播约束：

- 不要让所有下游字段都机械地叫 `regionCode`。否则 grep 搜索一个字符串即可命中大部分正确点，case 区分度不足。
- 下游字段应体现不同 bounded context 的语义命名，例如 `deviceRegionCode`、`alarmRegionCode`、`maintenanceRegionCode`。
- Case C 的真实任务不是“全局替换字符串”，而是“识别 `DeviceInfo.regionCode` 作为设备维护区域源字段，并更新其传播链路”。
- `Region.regionCode`、`OperatorUser.regionCode`、`RegionFilterRequest.regionCode` 必须保留，作为不应修改的干扰项。

推荐传播链：

```text
DeviceInfo.regionCode
  -> DeviceMetricEvent.deviceRegionCode
  -> AlarmRecord.alarmRegionCode
  -> AlarmEvent.deviceRegionCode
  -> WorkOrder.maintenanceRegionCode
  -> DashboardDeviceHealth.regionCode
```

评分时要拆开判断：

- Java 类型、方法和 mapper 是否更新。
- JSON fixture / 字符串 key 是否更新。
- 干扰字段是否被误改。
- graph 组是否正确说明哪些字段需要 grep 或人工补充确认。

## 9. Benchmark Case 设计

### 9.0 Case 区分度原则

后续代码实现模型必须遵守以下原则。若实现产物违反这些原则，应先修设计实现，不要进入 benchmark 运行。

| 原则 | 要求 | 目的 |
| --- | --- | --- |
| 静态可见 | 关键链路通过 Java 方法调用、接口实现、字段访问或 mapper 连接 | 避免图谱无法表达，只能靠人脑补 |
| 噪音真实 | 同名方法和相似字段来自真实业务模块，不是随意堆垃圾类 | 测试 grep 噪音处理能力 |
| 目标唯一 | 每个 case 的目标符号或字段语义必须清楚 | 避免评分变成开放题 |
| 干扰明确 | ground truth 里列出不应修改或不应纳入核心链路的干扰项 | 检查误判能力 |
| 验证可跑 | 修改类 case 必须有测试或编译命令 | 避免只评价回答好不好看 |

第一批 case 的推荐优先级：

1. Case B：接口 / 多态影响分析，区分度最强，优先作为 proof case。
2. Case A：端到端执行流，适合 demo，但必须保留 `DomainEventBus` 显式事件桥。
3. Case C：字段传播真实修改，作为边界和真实修改 case，不包装成图谱必胜 case。

### 9.1 Case A：设备指标到自动工单执行流

文件：

```text
docs/benchmark/v3/telecom/cases/telecom-case-a-metric-to-workorder-flow.yaml
```

级别：

```text
L1 - flow_tracing
```

任务：

```text
请分析设备指标从 POST /api/devices/{deviceId}/metrics 进入系统，
到生成告警、达到阈值后自动创建工单的完整调用链，并标注每一步副作用。
不要修改代码。
```

Graph 组建议查询：

```text
query({search_query: "device metric to alarm to work order flow"})
context({name: "DeviceMetricIngestController"})
context({name: "AlarmEvaluationService"})
context({name: "AutoWorkOrderService"})
```

grep 组建议搜索：

```text
rg "POST /api/devices|/api/devices/.*/metrics|ingestMetric"
rg "DeviceMetricEvent|AlarmEvent|WorkOrderEvent"
rg "evaluate|createForAlarm|publish"
```

Ground truth 必须包含：

```text
DeviceMetricIngestController.ingestMetric
DeviceRegistryService.findActiveDevice
VendorAdapterRegistry.resolve
VendorAdapter.normalizeRawMetric
MetricCollectorService.acceptMetric
DeviceMetricValidator.validate
DeviceMetricNormalizer.normalize
DeviceMetricRepository.save
MetricEventPublisher.publish
DomainEventBus.publish(DeviceMetricEvent)
InMemoryDomainEventBus.publish(DeviceMetricEvent)
DeviceMetricEventConsumer.onMetric
AlarmEvaluationService.evaluate
ThresholdRuleService.loadRules
RuleEvaluatorRegistry.resolve
RuleEvaluator.evaluate
AlarmSeverityClassifier.classify
AlarmDeduplicationService.deduplicate
AlarmRepository.save
AlarmEventPublisher.publish
DomainEventBus.publish(AlarmEvent)
InMemoryDomainEventBus.publish(AlarmEvent)
AlarmEventConsumer.onAlarmCreated
AutoWorkOrderService.createForAlarm
WorkOrderRepository.save
WorkOrderFlowService.assign
WorkOrderAssignmentService.assign
AssigneeSelectorRegistry.resolve
AssigneeSelector.select
WorkOrderStateMachine.transition
WorkOrderEventPublisher.publish
DomainEventBus.publish(WorkOrderEvent)
InMemoryDomainEventBus.publish(WorkOrderEvent)
```

必须识别的副作用：

- 指标写入内存 repository。
- 指标事件发布。
- 阈值规则读取。
- 告警写入 repository。
- 告警事件发布。
- 工单写入 repository。
- 工单状态流转。
- 工单事件发布。

Case A 实现硬约束：

- `MetricEventPublisher`、`AlarmEventPublisher`、`WorkOrderEventPublisher` 必须调用 `DomainEventBus`。
- `InMemoryDomainEventBus` 必须真实调用对应 consumer 方法，形成静态可见调用边。
- 不允许只写 `// Kafka publish` 或空实现 `publish(event)`。
- 允许在 README 中说明真实生产会替换为 MQ，但 benchmark 默认使用内存事件桥。

扣分点：

- 把 `ops-gateway-service` 看板查询误认为指标入口。
- 漏掉 `DeviceMetricEventConsumer` 或 `AlarmEventConsumer`。
- 把通知发送作为自动工单创建的必经步骤。通知可以是后续副作用，但不是创建工单的核心链路。
- 忽略 `DomainEventBus`，导致事件链断成多个不连续片段。

### 9.2 Case B：`RuleEvaluator.evaluate` 影响分析

文件：

```text
docs/benchmark/v3/telecom/cases/telecom-case-b-rule-evaluator-impact.yaml
```

级别：

```text
L2 - impact_analysis
```

任务：

```text
如果给 RuleEvaluator.evaluate(DeviceMetric metric, ThresholdRule rule)
增加一个 EvaluationContext context 参数，需要同步检查哪些实现类、调用方、测试和文档？
不要修改代码，先输出完整影响分析。
```

Graph 组建议查询：

```text
impact({target: "evaluate", direction: "upstream"})
context({name: "RuleEvaluator"})
query({search_query: "alarm rule evaluator evaluation context"})
```

grep 组建议搜索：

```text
rg "interface RuleEvaluator|class .*RuleEvaluator|evaluate\\("
rg "RuleEvaluatorRegistry|AlarmEvaluationService"
rg "EvaluationResult|ThresholdRule"
```

Ground truth 必须包含：

```text
RuleEvaluator
CpuUsageRuleEvaluator
MemoryUsageRuleEvaluator
OpticalPowerRuleEvaluator
PacketLossRuleEvaluator
TemperatureRuleEvaluator
RuleEvaluatorRegistry
AlarmEvaluationService
ThresholdRuleService
DeviceMetricEventConsumer
AlarmEvaluationServiceTest
RuleEvaluatorRegistryTest
CpuUsageRuleEvaluatorTest
OpticalPowerRuleEvaluatorTest
PacketLossRuleEvaluatorTest
```

必须说明：

- 这是接口签名变更，所有实现类必须同步。
- `AlarmEvaluationService` 是核心调用方，需要构造或传递 `EvaluationContext`。
- `RuleEvaluatorRegistry` 可能不直接调用 `evaluate`，但需要检查注册和类型引用。
- `SlaEvaluator.evaluate`、`RiskEvaluator.evaluate` 不是目标接口方法，属于同名干扰。
- 可选参数或重载方案风险较低，但需要保持实现一致。

Case B 实现硬约束：

- `AlarmEvaluationService` 必须通过 `RuleEvaluator` 接口变量调用 `evaluate`。
- 五个目标实现类必须分散在 `rule` 包下，不要合并成一个 switch 方法。
- 至少保留四个非目标同名 `evaluate` 干扰项：`SlaEvaluator.evaluate`、`RiskEvaluator.evaluate`、`EscalationPolicy.evaluate`、`DashboardHealthEvaluator.evaluate`。
- 至少一个目标实现类必须包含重载方法，例如 `boolean evaluate(DeviceInfo deviceInfo)`，用于检查 agent 是否能区分签名。
- 测试必须分散到 service、registry、具体 evaluator 三类测试文件，不要只保留一个大而全的测试。

建议风险等级：

```text
HIGH
```

原因：

- 接口方法签名影响多个实现类和测试。
- 命名噪音高。
- 告警生成链路是核心业务链路。

验证命令：

```bash
mvn -pl alarm-engine-service test
mvn test
```

### 9.3 Case C：`DeviceInfo.regionCode` 字段重命名

文件：

```text
docs/benchmark/v3/telecom/cases/telecom-case-c-region-code-rename.yaml
```

级别：

```text
L3 - small_code_change
```

任务：

```text
将 DeviceInfo.regionCode 重命名为 maintenanceRegionCode，
同步更新采集、告警、工单、Dashboard 和测试 fixture。
修改前先输出影响分析，修改后说明变更范围。
```

Graph 组建议查询：

```text
context({name: "DeviceInfo"})
impact({target: "regionCode", direction: "upstream"})
query({search_query: "DeviceInfo region code metric alarm work order dashboard"})
detect_changes()
```

grep 组建议搜索：

```text
rg "regionCode"
rg "DeviceInfo"
rg "DeviceMetricEvent|AlarmRecord|WorkOrder|DashboardResponse"
```

Ground truth 应修改：

```text
common-domain/.../device/DeviceInfo.java
common-domain/.../event/DeviceMetricEvent.java
common-domain/.../alarm/AlarmRecord.java
common-domain/.../event/AlarmEvent.java
common-domain/.../workorder/WorkOrder.java
device-collector-service/.../DeviceMetricMapper.java
device-collector-service/.../DeviceRegistryService.java
alarm-engine-service/.../AlarmRecordMapper.java
alarm-engine-service/.../AlarmEvaluationService.java
workorder-service/.../AutoWorkOrderService.java
ops-gateway-service/.../DashboardAggregationService.java
ops-gateway-service/.../DashboardResponseMapper.java
相关测试 fixture JSON
```

不应修改或需谨慎确认：

```text
common-domain/.../region/Region.java
common-domain/.../user/OperatorUser.java
ops-gateway-service/.../RegionFilterRequest.java
```

必须说明：

- `DeviceInfo.regionCode` 是设备维护区域字段。
- 下游字段不一定同名，必须沿 mapper / event / domain 传播链确认，例如 `deviceRegionCode`、`alarmRegionCode`、`maintenanceRegionCode`。
- `Region.regionCode` 是区域实体主编码，不是同一个字段语义。
- `OperatorUser.regionCode` 是人员所属区域，不应盲目改名。
- JSON fixture 和 mapper 比单纯 Java 调用更容易遗漏，grep 可作为补充。
- Graph 组的 `detect_changes` 用于改后确认影响面，不应混入改前检索评分。

Case C 实现硬约束：

- `DeviceInfo` 初始字段为 `regionCode`，任务目标是改为 `maintenanceRegionCode`。
- 至少三层下游字段使用不同但相关的语义名：`DeviceMetricEvent.deviceRegionCode`、`AlarmRecord.alarmRegionCode`、`WorkOrder.maintenanceRegionCode`。
- `Region.regionCode`、`OperatorUser.regionCode`、`RegionFilterRequest.regionCode` 必须存在且不应修改。
- 至少 4 个 JSON fixture 必须包含区域字段，检查非 Java 文本层面的遗漏。
- mapper 中必须显式读取和写入这些字段，不允许让字段完全靠构造器顺序隐式传递。

验证命令：

```bash
mvn test
```

评分重点：

- 是否正确区分字段所属类型。
- 是否遗漏 mapper、DTO、fixture。
- 是否误改 `Region.regionCode` 或 `OperatorUser.regionCode`。
- typecheck / tests 是否通过。

## 10. 第二批可扩展 Case

| Case | 类型 | 任务 | 价值 |
| --- | --- | --- | --- |
| `telecom-case-d-workorder-state` | L3 | 新增 `WAITING_VENDOR` 状态 | 状态机和流程修改 |
| `telecom-case-e-notification-channel-impact` | L2 | 修改 `NotificationChannel.send` 签名 | 多实现接口 + 同名 `send` 噪音 |
| `telecom-case-f-dashboard-flow` | L1 | 追踪看板聚合链路 | 跨服务 client 聚合 |
| `telecom-case-g-vendor-adapter-impact` | L2 | 修改 `VendorAdapter.normalizeRawMetric` | 厂商适配多态 |
| `telecom-case-h-severity-enum-change` | L3 | `AlarmRecord.severity` 类型收紧 | 字段类型传播 |

## 11. 测试设计

每个模块至少保留这些测试：

### `device-collector-service`

```text
DeviceMetricIngestControllerTest
MetricCollectorServiceTest
VendorAdapterRegistryTest
DeviceMetricNormalizerTest
DeviceMetricMapperTest
```

### `alarm-engine-service`

```text
AlarmEvaluationServiceTest
RuleEvaluatorRegistryTest
CpuUsageRuleEvaluatorTest
OpticalPowerRuleEvaluatorTest
PacketLossRuleEvaluatorTest
AlarmDeduplicationServiceTest
DeviceMetricEventConsumerTest
```

### `workorder-service`

```text
AutoWorkOrderServiceTest
WorkOrderFlowServiceTest
WorkOrderStateMachineTest
WorkOrderAssignmentServiceTest
RegionBasedAssigneeSelectorTest
AlarmEventConsumerTest
WorkOrderControllerTest
```

### `notification-service`

```text
NotificationServiceTest
NotificationChannelRegistryTest
NotificationTemplateServiceTest
WorkOrderEventConsumerTest
```

### `ops-gateway-service`

```text
DashboardAggregationServiceTest
DashboardResponseMapperTest
OpsDashboardControllerTest
RegionFilterRequestTest
```

## 12. Fixture 设计

建议保留 JSON fixture：

```text
src/test/resources/fixtures/device-info/base-station-huawei.json
src/test/resources/fixtures/device-metric/cpu-critical.json
src/test/resources/fixtures/device-metric/optical-power-warning.json
src/test/resources/fixtures/alarm/alarm-critical-region-east.json
src/test/resources/fixtures/workorder/auto-created-critical-alarm.json
src/test/resources/fixtures/dashboard/device-health-summary.json
```

这些 fixture 应包含 `regionCode`，用于 Case C 检查 grep 和图谱在非 Java 字符串层面的互补边界。

## 13. README 要求

项目 README 应包含：

- 业务背景。
- 模块说明。
- 本项目是合成 benchmark，不连接真实设备或内网系统。
- 如何运行 `mvn test`。
- 三个 benchmark case 的简短说明。
- 工具策略：grep-only、graph-only、mixed。

## 14. GitNexus 索引期望

索引后应能观察到：

- Spring 路由节点：设备指标入口、告警查询、工单流转、看板查询。
- 接口实现边：`RuleEvaluator`、`VendorAdapter`、`AssigneeSelector`、`NotificationChannel`。
- 调用边：Controller -> Service -> Repository / Publisher。
- 跨模块导入关系：服务模块依赖 `common-domain`。
- 执行流：指标采集到告警、告警到工单、工单到通知、看板聚合。

若索引无法识别事件 publisher / consumer 的跨服务关系，应在 ground truth 中标记为“人工确认事件桥”，不要把索引缺陷误记为 agent 失败。

## 15. 实现顺序建议

1. 创建 Maven multi-module skeleton。
2. 实现 `common-domain` 的 domain、event、enum。
3. 实现 `device-collector-service` 的指标入口和事件发布。
4. 实现 `alarm-engine-service` 的规则评估和告警事件。
5. 实现 `workorder-service` 的自动工单和状态机。
6. 实现 `notification-service` 的工单通知。
7. 实现 `ops-gateway-service` 的看板聚合。
8. 补齐测试和 fixture。
9. 编写 `docs/benchmark/v3/telecom/cases/*.yaml` 和 ground truth。
10. 运行 `mvn test`。
11. 用 GitNexus analyze 建索引，记录符号数、关系数、执行流数。
12. 手动跑一轮 grep-only 和 graph-only，校准 case 难度。

## 16. 给代码生成模型的执行约束

这一节面向后续负责生成 Java 代码的模型。实现模型可以能力较弱，但必须严格遵守本节，不能为了快速完成而降级设计。

### 16.1 总体生成原则

- 先生成能 `mvn test` 的完整 Maven multi-module 项目，再追求代码细节丰富度。
- 不允许把多个微服务合并成单模块。
- 不允许把核心业务逻辑集中到一个 `DemoService`、`MainService` 或 `Utils` 类。
- 不允许只生成接口和空方法。核心流程中的每个方法都要有可读的业务逻辑、字段传递和测试断言。
- 不允许通过大量注释、README 或无意义 getter/setter 填充 10000+ 行代码目标。
- 不允许用反射、运行时扫描、字符串拼接魔法隐藏关键调用关系。
- 不允许引入真实数据库、Kafka、Redis、注册中心或需要外部服务才能通过测试的依赖。
- 允许使用 in-memory repository、in-memory event bus、简单 fake client。
- Spring 注解应使用真实 Spring MVC 注解，让 GitNexus 能检测 route。

### 16.2 强制交付物

实现完成时必须存在：

```text
telecom-ops-platform/pom.xml
telecom-ops-platform/README.md
telecom-ops-platform/docs/architecture.md
telecom-ops-platform/docs/benchmark-cases/telecom-case-a-metric-to-workorder-flow.yaml
telecom-ops-platform/docs/benchmark-cases/telecom-case-b-rule-evaluator-impact.yaml
telecom-ops-platform/docs/benchmark-cases/telecom-case-c-region-code-rename.yaml
telecom-ops-platform/docs/benchmark-cases/ground-truth/telecom-case-a-ground-truth.yaml
telecom-ops-platform/docs/benchmark-cases/ground-truth/telecom-case-b-ground-truth.yaml
telecom-ops-platform/docs/benchmark-cases/ground-truth/telecom-case-c-ground-truth.yaml
telecom-ops-platform/common-domain/pom.xml
telecom-ops-platform/device-collector-service/pom.xml
telecom-ops-platform/alarm-engine-service/pom.xml
telecom-ops-platform/workorder-service/pom.xml
telecom-ops-platform/notification-service/pom.xml
telecom-ops-platform/ops-gateway-service/pom.xml
```

每个 service module 必须同时包含：

- `src/main/java`
- `src/test/java`
- 至少一个 Controller。
- 至少一个 Service。
- 至少一个 Repository 或 Client。
- 至少一个 Mapper 或 DTO。
- 至少一个测试类。

### 16.3 代码规模下限

生成后必须满足：

| 项 | 下限 |
| --- | ---: |
| main Java 类 | 100 |
| test Java 类 | 25 |
| 总 Java 行数 | 10000 |
| Spring Controller 类 | 8 |
| Interface 类 | 5 |
| Interface 实现类 | 15 |
| JSON fixture 文件 | 6 |

如果一次性生成达不到行数目标，优先增加真实测试、mapper、validator、repository 方法和 DTO，不要增加空类或注释。

### 16.4 必须真实存在的关键类

实现模型必须逐字生成这些类名。缺少任意一个都视为不完整。

Case A 关键类：

```text
DeviceMetricIngestController
DeviceRegistryService
VendorAdapterRegistry
MetricCollectorService
DeviceMetricValidator
DeviceMetricNormalizer
DeviceMetricRepository
MetricEventPublisher
DomainEventBus
InMemoryDomainEventBus
DeviceMetricEventConsumer
AlarmEvaluationService
ThresholdRuleService
RuleEvaluatorRegistry
AlarmSeverityClassifier
AlarmDeduplicationService
AlarmRepository
AlarmEventPublisher
AlarmEventConsumer
AutoWorkOrderService
WorkOrderRepository
WorkOrderFlowService
WorkOrderAssignmentService
AssigneeSelectorRegistry
WorkOrderStateMachine
WorkOrderEventPublisher
```

Case B 关键类：

```text
RuleEvaluator
CpuUsageRuleEvaluator
MemoryUsageRuleEvaluator
OpticalPowerRuleEvaluator
PacketLossRuleEvaluator
TemperatureRuleEvaluator
SlaEvaluator
RiskEvaluator
EscalationPolicy
DashboardHealthEvaluator
AlarmEvaluationServiceTest
RuleEvaluatorRegistryTest
CpuUsageRuleEvaluatorTest
OpticalPowerRuleEvaluatorTest
PacketLossRuleEvaluatorTest
```

Case C 关键类：

```text
DeviceInfo
DeviceMetricEvent
AlarmRecord
AlarmEvent
WorkOrder
Region
OperatorUser
RegionFilterRequest
DeviceMetricMapper
AlarmRecordMapper
DashboardAggregationService
DashboardResponseMapper
```

### 16.5 必须真实存在的关键调用

实现模型必须让这些调用在 Java 源码中真实发生，不能只出现在文档或测试注释里。

```text
DeviceMetricIngestController.ingestMetric -> MetricCollectorService.acceptMetric
MetricCollectorService.acceptMetric -> DeviceMetricRepository.save
MetricCollectorService.acceptMetric -> MetricEventPublisher.publish
MetricEventPublisher.publish -> DomainEventBus.publish(DeviceMetricEvent)
InMemoryDomainEventBus.publish(DeviceMetricEvent) -> DeviceMetricEventConsumer.onMetric
DeviceMetricEventConsumer.onMetric -> AlarmEvaluationService.evaluate
AlarmEvaluationService.evaluate -> RuleEvaluatorRegistry.resolve
AlarmEvaluationService.evaluate -> RuleEvaluator.evaluate
AlarmEvaluationService.evaluate -> AlarmRepository.save
AlarmEventPublisher.publish -> DomainEventBus.publish(AlarmEvent)
InMemoryDomainEventBus.publish(AlarmEvent) -> AlarmEventConsumer.onAlarmCreated
AlarmEventConsumer.onAlarmCreated -> AutoWorkOrderService.createForAlarm
AutoWorkOrderService.createForAlarm -> WorkOrderRepository.save
AutoWorkOrderService.createForAlarm -> WorkOrderFlowService.assign
WorkOrderFlowService.assign -> WorkOrderAssignmentService.assign
WorkOrderAssignmentService.assign -> AssigneeSelectorRegistry.resolve
WorkOrderAssignmentService.assign -> AssigneeSelector.select
WorkOrderFlowService.assign -> WorkOrderStateMachine.transition
WorkOrderEventPublisher.publish -> DomainEventBus.publish(WorkOrderEvent)
```

### 16.6 必须真实存在的字段传播

初始实现必须保留这些字段语义：

```text
DeviceInfo.regionCode
DeviceMetricEvent.deviceRegionCode
AlarmRecord.alarmRegionCode
AlarmEvent.deviceRegionCode
WorkOrder.maintenanceRegionCode
DashboardDeviceHealth.regionCode 或 DeviceHealthSummary.regionCode
Region.regionCode
OperatorUser.regionCode
RegionFilterRequest.regionCode
```

其中：

- `DeviceInfo.regionCode` 是 Case C 的源字段。
- `DeviceMetricEvent.deviceRegionCode`、`AlarmRecord.alarmRegionCode`、`AlarmEvent.deviceRegionCode`、`WorkOrder.maintenanceRegionCode` 是传播链。
- `Region.regionCode`、`OperatorUser.regionCode`、`RegionFilterRequest.regionCode` 是干扰项，不属于 Case C 修改目标。

mapper 中必须显式传递这些字段。例如：

```text
DeviceInfo.regionCode -> DeviceMetricEvent.deviceRegionCode
DeviceMetricEvent.deviceRegionCode -> AlarmRecord.alarmRegionCode
AlarmRecord.alarmRegionCode -> AlarmEvent.deviceRegionCode
AlarmEvent.deviceRegionCode -> WorkOrder.maintenanceRegionCode
WorkOrder.maintenanceRegionCode -> DashboardDeviceHealth.regionCode
```

### 16.7 分阶段 goal 模板

如果用 `/goal` 风格指令驱动弱模型，建议不要一次性要求它生成所有内容。按以下阶段执行，每阶段必须通过验收再进入下一阶段。

#### Goal 1：项目骨架

```text
/goal
请基于 docs/telecom-ops-platform-blueprint.md 创建 telecom-ops-platform Maven multi-module 项目骨架。
只完成 root pom、6 个 module pom、README、docs/architecture.md、基础包目录。
不要实现业务代码。
验收：mvn -q -DskipTests compile 至少能识别所有模块；目录结构必须与蓝图一致。
```

#### Goal 2：common-domain

```text
/goal
请实现 common-domain 模块的 domain、event、enum、exception、api 基础类。
必须包含 DeviceInfo.regionCode、DeviceMetricEvent.deviceRegionCode、AlarmRecord.alarmRegionCode、AlarmEvent.deviceRegionCode、WorkOrder.maintenanceRegionCode、Region.regionCode、OperatorUser.regionCode。
不要实现其他服务模块。
验收：common-domain 至少 24 个 main Java 类，mvn -pl common-domain test 通过。
```

#### Goal 3：采集和事件桥

```text
/goal
请实现 device-collector-service，并实现跨服务事件桥的公共接口 DomainEventBus 和 InMemoryDomainEventBus。
必须让 DeviceMetricIngestController.ingestMetric 到 MetricEventPublisher.publish 再到 DomainEventBus.publish(DeviceMetricEvent) 的调用链真实存在。
验收：采集模块至少 24 个 main Java 类，包含 VendorAdapter 四个实现，mvn -pl device-collector-service test 通过。
```

#### Goal 4：告警引擎

```text
/goal
请实现 alarm-engine-service。
必须包含 RuleEvaluator 五个目标实现、SlaEvaluator/RiskEvaluator/DashboardHealthEvaluator/EscalationPolicy 四类 evaluate 干扰项，并让 AlarmEvaluationService 通过 RuleEvaluator 接口变量调用 evaluate。
验收：告警模块至少 28 个 main Java 类，至少 7 个测试类，mvn -pl alarm-engine-service test 通过。
```

#### Goal 5：工单流转

```text
/goal
请实现 workorder-service。
必须包含 AlarmEventConsumer、AutoWorkOrderService、WorkOrderFlowService、WorkOrderAssignmentService、AssigneeSelector 三个实现、WorkOrderStateMachine，并让告警事件到自动工单创建和派单的调用链真实存在。
验收：工单模块至少 30 个 main Java 类，至少 7 个测试类，mvn -pl workorder-service test 通过。
```

#### Goal 6：通知和网关

```text
/goal
请实现 notification-service 和 ops-gateway-service。
通知模块必须包含 NotificationChannel 三个实现。网关模块必须包含 DashboardAggregationService、DeviceClient、AlarmClient、WorkOrderClient、DashboardResponseMapper、DashboardHealthEvaluator。
验收：两个模块合计至少 36 个 main Java 类，mvn -pl notification-service,ops-gateway-service test 通过。
```

#### Goal 7：benchmark case 和最终补齐

```text
/goal
请补齐 docs/benchmark-cases 下三个 case YAML、ground-truth YAML、JSON fixture，并检查整个 telecom-ops-platform 是否满足蓝图完成判定。
必须运行 mvn test。
如果类数量、测试数量或行数不足，只能通过增加真实业务类、测试、mapper、validator、repository 方法补齐，不能增加空类或注释。
```

### 16.8 一次性 goal 模板

如果必须一次性生成，使用下面的强约束版本：

```text
/goal
请基于 docs/telecom-ops-platform-blueprint.md 生成完整 telecom-ops-platform 测试项目。
这是一个 Java 17 + Spring Boot 3.x 风格 + Maven multi-module 合成微服务项目，用于 GitNexus vs grep 的 AI Coding benchmark。

硬性要求：
1. 必须创建 common-domain、device-collector-service、alarm-engine-service、workorder-service、notification-service、ops-gateway-service 六个模块。
2. 必须生成 100+ main Java 类、25+ test Java 类、10000+ Java 行。
3. 必须能运行 mvn test。
4. 必须实现显式 DomainEventBus / InMemoryDomainEventBus 事件桥，不能只写空 publish。
5. 必须实现 RuleEvaluator 五个目标实现和至少四个 evaluate 干扰项。
6. 必须实现 DeviceInfo.regionCode 到 deviceRegionCode/alarmRegionCode/maintenanceRegionCode 的语义字段传播链，同时保留 Region.regionCode、OperatorUser.regionCode、RegionFilterRequest.regionCode 作为干扰项。
7. 必须生成 docs/benchmark-cases 三个 case YAML 和 ground-truth YAML。
8. 必须生成至少 6 个 JSON fixture。
9. 不允许通过空类、注释、无意义 getter/setter 堆行数。
10. 不允许合并模块或删减蓝图中的第一批 case。

完成前请自检并报告：模块列表、main Java 类数量、test Java 类数量、Java 总行数、关键调用链是否存在、mvn test 结果。
```

### 16.9 生成后自检命令

实现模型完成后应运行：

```bash
find . -path "*/src/main/java/*.java" -o -path "*/src/main/java/**/*.java" | wc -l
find . -path "*/src/test/java/*.java" -o -path "*/src/test/java/**/*.java" | wc -l
find . -name "*.java" -print0 | xargs -0 wc -l
mvn test
```

Windows PowerShell 可用：

```powershell
(Get-ChildItem -Recurse -Path . -Filter *.java | Where-Object { $_.FullName -like "*\src\main\java\*" }).Count
(Get-ChildItem -Recurse -Path . -Filter *.java | Where-Object { $_.FullName -like "*\src\test\java\*" }).Count
(Get-ChildItem -Recurse -Path . -Filter *.java | Get-Content | Measure-Object -Line).Lines
mvn test
```

关键调用链可用文本 sanity check：

```bash
grep -R "class InMemoryDomainEventBus" -n .
grep -R "metricConsumer.onMetric" -n .
grep -R "alarmConsumer.onAlarmCreated" -n .
grep -R "RuleEvaluator evaluator" -n .
grep -R "DashboardHealthEvaluator" -n .
grep -R "maintenanceRegionCode" -n .
```

## 17. 完成判定

这个测试项目的蓝图完成标准：

- 明确业务背景和非目标。
- 明确多模块结构和技术栈。
- 类数量达到 100+，代码量目标达到 10000+ 行。
- 每个模块有职责、包结构、类清单、核心流程。
- 至少 3 个第一批 benchmark case 有任务、ground truth、干扰项、验证命令。
- 覆盖执行流追踪、接口多态影响分析、字段传播真实修改三类能力。
- 明确 grep 组和 graph 组的建议查询方式。
- 明确测试、fixture、README、GitNexus 索引期望。

实现产物完成标准：

- `mvn test` 通过。
- root pom 能聚合 6 个模块。
- main Java 类数量不少于 100。
- test Java 类数量不少于 25。
- Java 总行数不少于 10000。
- `DomainEventBus` 和 `InMemoryDomainEventBus` 存在，并真实调用 consumer。
- `RuleEvaluator` 五个实现和四个 `evaluate` 干扰项存在。
- Case A / B / C 的 ground truth YAML 存在。
- Case C 的干扰字段存在，且字段传播链不全是同名 `regionCode`。
- README 明确这是合成 benchmark 项目，不连接真实内网服务。
