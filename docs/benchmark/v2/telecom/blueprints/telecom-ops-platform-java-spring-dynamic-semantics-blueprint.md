# Telecom Ops Platform v2 Java / Spring / 动态调用语义专项蓝图

## 1. 目的

本文档是以下蓝图的专项补充：

- [telecom-ops-platform-blueprint.md](./telecom-ops-platform-blueprint.md)
- [telecom-ops-platform-scale-expansion-blueprint.md](./telecom-ops-platform-scale-expansion-blueprint.md)
- [telecom-ops-platform-50k-blueprint.md](./telecom-ops-platform-50k-blueprint.md)

目标是在现有 `telecom-ops-platform` 中新增一个真实可编译、可运行、可索引的 Java 17 / Spring Boot 3.2 模块，专门评测两款代码图谱产品对以下能力的实际表现：

1. Java 注解类型、注解应用和注解元素的识别与符号绑定。
2. Spring MVC 路由注解及类级路径组合。
3. Spring stereotype、构造器注入、`@Qualifier`、`@Primary` 和集合注入。
4. `@Transactional`、Spring Data JPA、Spring Event、AOP 等框架语义。
5. Java 重载、构造器、接口调用、抽象类模板方法、override/default method。
6. lambda、method reference、callback、反射和代理调用。
7. 对 direct call、possible dynamic target 和 runtime-selected target 的分层表达。

本蓝图的重点不是继续增加普通业务代码，而是构造一组**可以区分语法识别、编译器符号绑定、调用图恢复、动态目标展开和框架语义解释**的受控实验样本。

## 2. 与现有项目的关系

被扩展项目：

```text
F:\develop\codes\Gitnexus-case-project\telecom-ops-platform
```

当前项目已经具备：

- 6 个 Maven module。
- Spring MVC Controller 和常见 mapping 注解。
- `RuleEvaluator`、`VendorAdapter`、`NotificationChannel` 等接口与实现。
- 显式 `DomainEventBus` 事件桥。
- Case A～I 及对应 ground truth。

当前项目不适合作为完整注解专项样本的原因：

- 大量 service/repository 是普通 Java 类，没有 `@Service`、`@Repository`。
- 基本没有 `@Autowired`、`@Qualifier`、`@Primary` 和集合注入。
- 没有 `@Transactional`、JPA entity/repository、Spring Event listener、AOP。
- 现有 Controller 主要覆盖短名 `@GetMapping/@PostMapping`，缺少 legacy、组合注解、数组路径和全限定名对照。
- 接口调用已经存在，但没有把 static target、may-call target、Spring runtime selection 三种 truth 分开。

本专项新增第 7 个 module：

```text
network-change-service
```

业务含义：运营商网络变更编排服务，负责路由器、传输设备和无线设备的软件升级、配置下发、审批、执行、回滚、审计和事件通知。

选择该业务的原因：

- “不同设备类型选择不同执行器”天然需要接口动态分派。
- 审批、执行、回滚天然需要事务边界。
- 变更单、执行步骤和审计记录天然适合 JPA 映射。
- 变更完成事件天然适合 Spring Event。
- 审计和权限校验天然适合自定义注解与 AOP。
- Controller 可以自然覆盖完整 Spring MVC 注解矩阵。

## 3. 非目标

- 不要求 AKA 或 GitNexus 推断真实 Spring 容器在所有 profile/property 下的最终运行时对象。
- 不把 `REFERENCES` 边等同于 `CALLS` 边。
- 不把接口的所有实现都当作某一调用点的 runtime truth。
- 不使用真实 MySQL、Kafka、Redis、设备网管或外部服务。
- 不依赖 Lombok、MapStruct 或代码生成器，避免源码中缺少真实方法体。
- 不用 mock-only 代码代替生产调用链。
- 不通过注释或空类堆代码量。
- 不修改 Case A～I 的 ground truth。

## 4. 实验对象与固定运行模式

必须分别记录以下配置，禁止只写“AKA 结果”或“GitNexus 结果”：

| Run ID | 产品模式 | 必须记录的信息 |
| --- | --- | --- |
| `aka-tier0` | AKA，仅 tree-sitter Tier-0 | AKA commit、grammar/version、规则包开关 |
| `aka-scip-java` | AKA Tier-0 + managed scip-java | AKA commit、scip-java 版本、JDK、Maven profile、analyzer diagnostics |
| `gitnexus-default` | GitNexus 默认 Java provider | GitNexus commit/version、分析参数、索引统计 |
| `grep-baseline` | `rg`/文件读取 | 查询字符串和读取文件数，仅作文本基线 |

推荐额外保留一个运行时 oracle：

```text
mvn -pl network-change-service -am test
```

运行时 oracle 用于证明实际选择了哪个 bean、哪个 override、哪个 listener；它不是静态工具必须达到的上限。

### 4.1 三层 ground truth

每个调用类 case 必须同时提供三层 truth：

| Truth 层 | 含义 | 示例 |
| --- | --- | --- |
| `static_target` | Java 编译期绑定的声明 | `ChangeExecutor.execute(ChangeContext)` |
| `possible_targets` | 在给定静态类型和项目实现集合下可能执行的方法 | 多个 executor 的 override |
| `runtime_target` | 固定测试配置和输入下实际选择的方法 | `RouterChangeExecutor.execute` |

评分时必须遵守：

- 普通 reference 命中 `static_target`，只能计入符号绑定分，不能计入调用边分。
- 枚举全部实现命中 `possible_targets`，可以计 may-call recall，但多出的不可达实现计 false positive。
- 只有固定 profile、qualifier、输入和 property 后，才定义唯一 `runtime_target`。
- Spring AOP、event listener、repository proxy 等框架边单独评分，不混入 Java 语言级 dispatch。

### 4.2 待验证假设

下表来自实现审查形成的实验假设，用于说明为什么要保留这些 probe；它**不能写入 ground truth，也不能在未运行产品前当作实测结果**。

| Case | AKA Tier-0 假设 | AKA + scip-java 假设 | GitNexus 假设 |
| --- | --- | --- | --- |
| S Route | 窄规则可能识别 R06 一类方法级静态 `@RequestMapping`；快捷注解覆盖低 | 与 Tier-0 Route 规则相同，SCIP 不负责 Spring route 解释 | 常见 shortcut + class prefix 覆盖较高；legacy method `@RequestMapping`、数组、组合注解仍可能缺失 |
| T Annotation | 主要是语法/文本 | 注解类型和具名元素可形成编译器级 reference，但未必有 `ANNOTATED_BY`/meta semantics | Annotation 定义和 Method 注解属性可见，元素绑定和 meta semantics 待测 |
| U DI | 不推断 Spring bean 选择 | 类型/注解 symbol reference 更准，但 qualifier/profile runtime selection 待测 | interface implementor 可见；qualifier/primary/profile 是否缩小 target 必须实测 |
| V/W Transaction/JPA | 主要识别普通定义和注解语法 | 可绑定 annotation/entity/repository symbol，不等于理解 proxy/propagation | framework annotations 可搜索；JPA mapping 和 transaction proxy semantics 待测 |
| X Dispatch | 同文件同名多实现容易因歧义而缺边 | javac 能绑定 interface method reference，但 AKA 是否生成 `CALLS` 是关键验证点 | 预计能形成 interface implementor fan-out，需测 false positive 和 template override |
| Y Overload/callback | 重载和 callback 召回有限 | 重载 target reference 应更准确，reference/call 类型必须分开 | 重载 CALLS 与 method reference/callback 覆盖需实测 |
| Z Framework/reflection | 预计不恢复隐式边 | symbol reference 增强，但 event/AOP/reflection 不应自动变成 direct call | framework/反射边预计仍是主要 coverage gap，重点检查是否过度宣称 |

若实测与假设不符，应更新分析报告，而不是修改 ground truth 迁就原结论。

## 5. Maven 模块设计

Root `pom.xml` 增加：

```xml
<module>network-change-service</module>
```

模块坐标：

```xml
<artifactId>network-change-service</artifactId>
```

允许依赖：

| 依赖 | scope | 用途 |
| --- | --- | --- |
| `common-domain` | compile | 复用 API response、设备与区域基础类型 |
| `spring-boot-starter-web` | compile | MVC 注解和 Controller |
| `spring-boot-starter-validation` | compile | 参数注解和校验 |
| `spring-boot-starter-data-jpa` | compile | JPA、repository proxy、transaction |
| `spring-boot-starter-aop` | compile | `@Aspect` 与 `ProceedingJoinPoint` |
| `spring-boot-starter-test` | test | JUnit 5、Spring Test、Mockito |
| `h2` | test | JPA/事务测试的内存数据库 |

禁止依赖其他 service module，避免形成 Maven 环。与其他服务的交互继续使用 common event 或本模块 fake client。

## 6. 目录与包结构

```text
network-change-service/
  pom.xml
  src/main/java/com/example/telecom/change/
    NetworkChangeApplication.java
    annotation/
    aop/
    config/
    controller/
    domain/
    dto/
    entity/
    event/
    executor/
    mapper/
    plugin/
    repository/
    service/
    validation/
  src/test/java/com/example/telecom/change/
    annotation/
    controller/
    executor/
    event/
    repository/
    service/
    support/
```

建议规模：

| 项 | 下限 |
| --- | ---: |
| main Java 文件 | 45 |
| test Java 文件 | 15 |
| Java 有效行数 | 3200 |
| 自定义 annotation type | 8 |
| Spring Controller | 3 |
| Spring service/component/repository/config | 15 |
| interface | 8 |
| interface/abstract override 实现 | 15 |
| benchmark case | 8 |
| ground-truth YAML | 8 |

### 6.1 强制类清单

以下类名必须真实存在，不能只出现在文档、注释或测试字符串中：

| 包 | 强制类型 |
| --- | --- |
| `annotation` | `AuditOperation`, `ChangeGuard`, `RegionScope`, `RequiredCapability`, `RequiredCapabilities`, `CriticalChange`, `OpsReadEndpoint`, `ChangeExecutorCandidate` |
| `aop` | `AuditOperationAspect`, `AuditSink`, `InMemoryAuditSink` |
| `config` | `ChangeInfrastructureConfiguration`, `ChangeExecutorConfiguration`, `ChangeProperties` |
| `controller` | `NetworkChangeController`, `LegacyNetworkChangeController`, `ComposedEndpointController` |
| `domain` | `NetworkChangePlan`, `ChangeContext`, `ExecutionResult`, `RollbackResult`, `ChangeCommand`, `EmergencyChangeCommand`, `DispatchResult`, `ChangeMode`, `DeviceFamily`, `ChangeStatus`, `ChangeRisk`, `AuditCategory` |
| `dto` | `ChangeRequest`, `ChangeResponse`, `ApprovalRequest`, `RiskUpdateRequest`, `ChangeSearchRequest` |
| `entity` | `NetworkChangeEntity`, `ChangeStepEntity`, `ChangeAuditEntity`, `ChangeApprovalEntity`, `ChangeWindowEmbeddable` |
| `event` | `ChangeApprovedEvent`, `ChangeCompletedEvent`, `ChangeApprovedListener`, `ChangeCompletedListener`, `ChangeNotificationListener` |
| `executor` | `ChangeExecutor`, `AbstractChangeExecutor`, `RouterChangeExecutor`, `TransmissionChangeExecutor`, `RadioChangeExecutor`, `DryRunChangeExecutor`, `SafeChangeExecutor`, `ChangeExecutorRegistry`, `ChangeStepExecutor`, `RollbackHandler`, `StandardRollbackHandler`, `RemoteRollbackHandler`, `DefaultExecutorFacade` |
| `mapper` | `NetworkChangeMapper`, `ChangeStepMapper`, `ChangeAuditMapper` |
| `plugin` | `ChangeValidationPlugin`, `BenchmarkChangeValidationPlugin`, `ChangePluginLoader`, `PluginDescriptor` |
| `repository` | `NetworkChangeJpaRepository`, `ChangeAuditJpaRepository`, `ChangeSnapshotStore`, `InMemoryChangeSnapshotStore` |
| `service` | `ChangePlanService`, `ChangePlanQueryService`, `ChangeExecutionService`, `ChangeAuditService`, `ChangeCommandBus`, `ChangeCallbackRegistry`, `LegacyChangeFacade`, `UnrelatedExecuteService`, `ChangeDocumentation` |
| `validation` | `ChangeValidator`, `RegionChangeValidator`, `RiskChangeValidator`, `MaintenanceWindowValidator` |

`ChangeInfrastructureConfiguration` 必须启用异步 listener 和 AOP 测试所需基础设施：

```java
@Configuration
@EnableAsync
@EnableAspectJAutoProxy
public class ChangeInfrastructureConfiguration {
    // deterministic test executor 通过 test configuration 覆盖
}
```

`@TransactionalEventListener(AFTER_COMMIT)` 测试必须使用真实测试事务提交或 `TransactionTemplate`，不能直接调用 listener 伪造框架分派。

## 7. Java 注解专项设计

### 7.1 自定义注解清单

| 注解 | Target | Retention | 关键元素 | 测试目的 |
| --- | --- | --- | --- | --- |
| `AuditOperation` | METHOD, ANNOTATION_TYPE | RUNTIME | `action`, `category`, `sensitive` | 注解类型与具名元素绑定 |
| `ChangeGuard` | METHOD, TYPE, ANNOTATION_TYPE | RUNTIME | `risk`, `requireApproval` | 类/方法应用与 AOP pointcut |
| `RegionScope` | METHOD, PARAMETER, TYPE_USE | RUNTIME | `value`, `includeChildren` | 参数和 type-use annotation |
| `RequiredCapability` | TYPE, METHOD | RUNTIME, Repeatable | `value` | repeatable annotation |
| `RequiredCapabilities` | TYPE, METHOD | RUNTIME | `value[]` | repeatable container |
| `CriticalChange` | METHOD | RUNTIME | 无 | meta/composed annotation |
| `OpsReadEndpoint` | METHOD | RUNTIME | `path[]` | Spring composed mapping |
| `ChangeExecutorCandidate` | TYPE, FIELD, PARAMETER | RUNTIME | 无 | 自定义 Spring qualifier，约束 registry 候选集 |

`AuditOperation` 必须允许作为元注解：

```java
@Target({ElementType.METHOD, ElementType.ANNOTATION_TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface AuditOperation {
    String action();
    AuditCategory category();
    boolean sensitive() default false;
}
```

`CriticalChange` 必须组合 `AuditOperation` 和 `ChangeGuard`：

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@AuditOperation(action = "critical-change", category = AuditCategory.CHANGE, sensitive = true)
@ChangeGuard(risk = ChangeRisk.CRITICAL, requireApproval = true)
public @interface CriticalChange {}
```

`OpsReadEndpoint` 必须是 Spring 组合注解：

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@GetMapping
public @interface OpsReadEndpoint {
    @AliasFor(annotation = GetMapping.class, attribute = "path")
    String[] path() default {};
}
```

`ChangeExecutorCandidate` 必须是自定义 Spring qualifier：

```java
@Target({ElementType.TYPE, ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Qualifier
public @interface ChangeExecutorCandidate {}
```

### 7.2 注解应用矩阵

源码中必须真实存在以下应用：

| 应用位置 | 示例 | Ground truth |
| --- | --- | --- |
| 类 | `@ChangeGuard` on `ChangeExecutionService` | type -> annotation type |
| 方法 | `@AuditOperation(action=..., category=...)` | method -> annotation type + element refs |
| 重复注解 | two `@RequiredCapability` | 两个 occurrence + container 语义 |
| 参数 | `@RegionScope("east") String regionCode` | parameter/type occurrence |
| type use | `List<@RegionScope("east") String>` | type-use occurrence |
| 组合注解 | `@CriticalChange` | direct annotation + meta-annotation chain |
| 全限定名 | `@com.example.telecom.change.annotation.AuditOperation(...)` | 与短名绑定到同一 symbol |
| 默认元素 | 省略 `sensitive` | element default 可从 annotation definition 导航 |

### 7.3 注解 ground truth 分层

必须分别计分：

1. annotation type definition 是否存在。
2. annotation application 是否能定位到正确 type symbol。
3. `action/category/sensitive` 是否绑定到正确 annotation method。
4. 是否有一等 `ANNOTATED_BY/APPLIES_TO` 边。
5. 是否解析 repeatable/meta annotation。
6. 是否把注解解释为 Route、transaction、DI、JPA、AOP 等框架语义。

不能因为工具能搜索到 `@AuditOperation` 文本，就判定第 2～6 项通过。

## 8. Spring MVC 路由矩阵

### 8.1 Controller 设计

新增：

```text
NetworkChangeController
LegacyNetworkChangeController
ComposedEndpointController
```

必须覆盖以下源码写法：

| ID | 写法 | Ground-truth route |
| --- | --- | --- |
| R01 | class `@RequestMapping("/api/network-changes")` + method `@GetMapping("/{id}")` | `GET /api/network-changes/{id}` |
| R02 | `@PostMapping(path="", consumes="application/json")` | `POST /api/network-changes` |
| R03 | `@PutMapping(path="/{id}")` | `PUT /api/network-changes/{id}` |
| R04 | `@PatchMapping(value="/{id}/risk")` | `PATCH /api/network-changes/{id}/risk` |
| R05 | `@DeleteMapping("/{id}")` | `DELETE /api/network-changes/{id}` |
| R06 | method `@RequestMapping("/legacy/preview")` | `ANY /legacy/preview` |
| R07 | method `@RequestMapping(path="/legacy/search", method=RequestMethod.GET)` | `GET /legacy/search` |
| R08 | `@GetMapping({"/active", "/open"})` | `GET /api/network-changes/active` 和 `GET /api/network-changes/open` |
| R09 | `@OpsReadEndpoint(path="/{id}/audit")` | `GET /api/network-changes/{id}/audit` |
| R10 | fully-qualified `@org.springframework.web.bind.annotation.GetMapping("/qualified")` | `GET /qualified` |
| R11 | `@GetMapping(path=ChangeRoutes.PENDING)`，常量值为 `/pending` | `GET /api/network-changes/pending` |
| R12 | class prefix + method `@GetMapping` 无路径 | `GET /api/network-changes` |

Controller 分配固定如下：

- `NetworkChangeController`：class prefix `/api/network-changes`，承载 R01～R05、R08、R11、R12。
- `LegacyNetworkChangeController`：无 class prefix，承载 R06、R07、R10。
- `ComposedEndpointController`：class prefix `/api/network-changes`，承载 R09。

### 8.2 路由负例

以下字符串必须存在，但不能成为 Route：

```text
"/api/network-changes/fake" in a log message
"@GetMapping(\"/comment-only\")" in a test fixture string
ChangeRouteDocumentation.describe("/active")
```

### 8.3 路由评分

每个产品输出：

```text
TP / FP / FN
HTTP method accuracy
class-prefix composition accuracy
path/value alias accuracy
array expansion accuracy
composed annotation accuracy
constant resolution accuracy
handler symbol linkage accuracy
```

R06 和 R07 必须分别保留：前者用于 AKA 当前窄 `@RequestMapping` 规则，后者用于检查 `method=RequestMethod.GET`；不能把两者合并。

## 9. Spring DI 与 bean 选择设计

### 9.1 接口及实现

核心接口：

```java
public interface ChangeExecutor {
    DeviceFamily supports();
    ExecutionResult execute(ChangeContext context);
}
```

实现：

| Bean | 注解 | supports | 用途 |
| --- | --- | --- | --- |
| `RouterChangeExecutor` | `@Component("routerExecutor")` | ROUTER | 普通实现 |
| `TransmissionChangeExecutor` | `@Component("transmissionExecutor")` | TRANSMISSION | 普通实现 |
| `RadioChangeExecutor` | `@Primary @Component("radioExecutor")` | RADIO | primary 选择 |
| `DryRunChangeExecutor` | `@Profile("dry-run") @Component` | ALL | profile 条件实现 |
| `SafeChangeExecutor` | `@Component("safeExecutor")` | ALL | qualifier 固定实现 |

`RouterChangeExecutor`、`TransmissionChangeExecutor`、`RadioChangeExecutor` 和 `DryRunChangeExecutor` 同时标记自定义 `@ChangeExecutorCandidate`；`SafeChangeExecutor` 不标记。该注解由 `@Qualifier` 元注解组成，使 registry 的候选集在 Spring 注入阶段就排除 safe executor。

### 9.2 注入形态

必须同时存在：

```java
public ChangeExecutionService(
        @Qualifier("safeExecutor") ChangeExecutor safeExecutor,
        @ChangeExecutorCandidate List<ChangeExecutor> executors,
        Map<String, ChangeExecutor> executorBeans,
        ObjectProvider<RollbackHandler> rollbackHandlerProvider) { ... }
```

`ChangeExecutorRegistry` 必须接收 `@ChangeExecutorCandidate List<ChangeExecutor>`；`DefaultExecutorFacade` 另接收一个无 qualifier 的 `ChangeExecutor`，用于验证 `@Primary RadioChangeExecutor`。两条注入路径不能合并。

另增加一个仅用于对照的 field injection：

```java
@Autowired
@Qualifier("routerExecutor")
private ChangeExecutor legacyExecutor;
```

field injection 只允许出现在 `LegacyChangeFacade`，避免整个模块采用不推荐风格。

### 9.3 条件 bean

```text
@Profile("dry-run")
@ConditionalOnProperty(name="telecom.change.remote.enabled", havingValue="true")
@Primary
@Bean(name="defaultRollbackHandler")
```

必须通过两个 Spring profile 测试形成确定的 runtime truth：

| Test profile | property | 预期 bean |
| --- | --- | --- |
| `benchmark` | remote=false | standard executors，无 remote bean |
| `dry-run` | remote=true | 包含 `DryRunChangeExecutor` 和 remote handler |

### 9.4 DI 评分边界

分别检查：

- interface -> implementation 关系。
- constructor parameter -> bean type reference。
- `@Qualifier` -> bean name 选择。
- `@Primary` 候选优先级。
- `List/Map` 注入的候选集合。
- profile/property 对 runtime target 的约束。

仅枚举实现类不能算 qualifier/profile 推理通过。

## 10. Transaction 与 JPA 设计

### 10.1 Entity

新增：

```text
NetworkChangeEntity
ChangeStepEntity
ChangeAuditEntity
ChangeApprovalEntity
ChangeWindowEmbeddable
```

必须覆盖：

```text
@Entity
@Table(name="network_change")
@Id
@GeneratedValue
@Column(name="change_id", nullable=false, unique=true)
@Enumerated(EnumType.STRING)
@Embedded
@OneToMany(mappedBy="change", cascade=ALL)
@ManyToOne(fetch=LAZY)
@Version
```

Repository：

```text
NetworkChangeJpaRepository extends JpaRepository<NetworkChangeEntity, Long>
ChangeAuditJpaRepository extends JpaRepository<ChangeAuditEntity, Long>
```

至少一个派生查询和一个 `@Query`：

```java
List<NetworkChangeEntity> findByRegionCodeAndStatus(String regionCode, ChangeStatus status);

@Query("select c from NetworkChangeEntity c where c.risk = :risk and c.status in :statuses")
List<NetworkChangeEntity> findRiskQueue(@Param("risk") ChangeRisk risk,
                                        @Param("statuses") Collection<ChangeStatus> statuses);
```

### 10.2 Transaction

必须覆盖：

| 方法 | 注解 | 目的 |
| --- | --- | --- |
| `ChangePlanService.createPlan` | `@Transactional` | 普通写事务 |
| `ChangePlanQueryService.findById` | `@Transactional(readOnly=true)` | read-only |
| `ChangeAuditService.record` | `@Transactional(propagation=REQUIRES_NEW)` | 新事务 |
| `ChangeExecutionService.execute` | class-level `@Transactional` | 类级继承 |
| `ChangePlanService.preview` | 无事务 | 负例 |
| `ChangePlanService.approveAndRecordInternally` | 调用同类 `recordInternal` | self-invocation 陷阱 |

必须在 ground truth 中声明：

- `approveAndRecordInternally -> recordInternal` 是普通 Java direct call。
- 即使 `recordInternal` 标有 `REQUIRES_NEW`，Spring self-invocation 默认不会经过 proxy。
- 工具若只识别注解存在，不代表它理解 transaction runtime semantics。

### 10.3 JPA/transaction 评分

分别检查：

- entity/table/column 节点或属性。
- repository interface 及继承关系。
- service -> repository method 调用。
- transaction annotation application。
- propagation/readOnly 属性。
- proxy/self-invocation 解释。

## 11. Java 调用与动态分派设计

### 11.1 重载与构造器

`ChangeCommandBus` 必须存在：

```java
DispatchResult dispatch(ChangeCommand command)
DispatchResult dispatch(EmergencyChangeCommand command)
DispatchResult dispatch(String changeId, ChangeMode mode)
```

调用点必须包含：

```java
commandBus.dispatch((ChangeCommand) command);
commandBus.dispatch(emergencyCommand);
commandBus.dispatch(changeId, ChangeMode.DRY_RUN);
```

构造器重载：

```text
ChangeContext(String changeId, DeviceFamily family)
ChangeContext(String changeId, DeviceFamily family, ChangeMode mode)
ChangeContext(ChangeRequest request)
```

Ground truth 必须精确到 descriptor/参数列表，不能只记方法名。

### 11.2 接口分派

`ChangeExecutionService.execute`：

```java
ChangeExecutor executor = registry.resolve(context.deviceFamily());
return executor.execute(context);
```

固定输入对应：

| deviceFamily | static target | possible target | runtime target |
| --- | --- | --- | --- |
| ROUTER | `ChangeExecutor.execute` | router/transmission/radio/dry-run | `RouterChangeExecutor.execute` |
| TRANSMISSION | `ChangeExecutor.execute` | 同上 | `TransmissionChangeExecutor.execute` |
| RADIO | `ChangeExecutor.execute` | 同上 | `RadioChangeExecutor.execute` |

`SafeChangeExecutor` 被自定义 qualifier 排除在 registry 之外，因此如果工具把它列入上述 registry call site 的 `possible_targets`，计一个 false positive。`safeExecutor.execute(context)` 是另一个调用点，其 runtime target 必须固定为 `SafeChangeExecutor.execute`，用于检查 qualifier 是否缩小 may-call 集合。

### 11.3 抽象类模板方法

```java
public abstract class AbstractChangeExecutor implements ChangeExecutor {
    protected final ExecutionResult executeTemplate(ChangeContext context) {
        validate(context);
        ExecutionResult result = apply(context);
        audit(context, result);
        return result;
    }

    protected abstract void validate(ChangeContext context);
    protected abstract ExecutionResult apply(ChangeContext context);
    protected void audit(ChangeContext context, ExecutionResult result) { ... }
}
```

四个 registry candidate concrete executor 必须各自 override 接口 `execute`，并调用继承的模板方法：

```java
@Override
public ExecutionResult execute(ChangeContext context) {
    return executeTemplate(context);
}
```

四个 concrete executor 同时 override `validate/apply`。必须为以下边分别建 truth：

- interface call site -> 各 concrete `execute` possible target。
- concrete `execute` -> `AbstractChangeExecutor.executeTemplate` direct call。
- template method -> abstract `validate/apply` static target。
- template method -> concrete overrides possible targets。

### 11.4 Default method

`RollbackHandler`：

```java
default RollbackResult rollback(ChangeContext context) {
    return validateRollback(context) ? doRollback(context) : RollbackResult.skipped();
}
```

至少一个实现只继承 default method，另一个 override `rollback`，用于测试 default/override 选择。

### 11.5 callback、lambda、method reference

必须同时存在：

```java
validators.forEach(v -> v.validate(context));
steps.stream().map(stepExecutor::executeStep).toList();
Optional.ofNullable(handler).ifPresent(h -> h.handle(event));
executorService.submit(plan::markRunning);
callbacks.register(ChangeStatus.COMPLETED, auditService::onCompleted);
```

测试必须等待异步任务结束或使用 deterministic direct executor，避免 flaky。

Ground truth 需要区分：

- lambda/method reference 对目标 symbol 的 reference。
- callback registration edge。
- callback invocation edge。
- 运行时实际 callback target。

### 11.6 反射与 ServiceLoader

新增 `ChangePluginLoader`：

```java
Class<?> type = Class.forName(pluginClassName);
Object plugin = type.getDeclaredConstructor().newInstance();
Method method = type.getMethod("execute", ChangeContext.class);
return (ExecutionResult) method.invoke(plugin, context);
```

另有：

```java
ServiceLoader.load(ChangeValidationPlugin.class)
```

反射插件类名保存在 `application-benchmark.yml`，并由 JUnit runtime oracle 验证。

这一场景用于确认工具是否诚实暴露 coverage gap。不能因为搜索到字符串中的类名，就判定已恢复 Java call edge。

## 12. Spring Event、AOP 和代理设计

### 12.1 Spring Event

```text
ChangePlanService.approve
  -> ApplicationEventPublisher.publishEvent(ChangeApprovedEvent)
  -> ChangeApprovedListener.onApproved (@EventListener)

ChangeExecutionService.complete
  -> publishEvent(ChangeCompletedEvent)
  -> ChangeCompletedListener.afterCommit (@TransactionalEventListener(AFTER_COMMIT))
  -> ChangeNotificationListener.notifyAsync (@Async @EventListener)
```

运行时测试必须记录 listener 调用计数。

静态 ground truth 中把这些边标记为：

```text
edge_kind: FRAMEWORK_EVENT_DISPATCH
```

不要把 `publishEvent -> listener` 伪装成普通 Java direct call。

### 12.2 AOP

`AuditOperationAspect`：

```java
@Aspect
@Component
public class AuditOperationAspect {
    @Around("@annotation(auditOperation)")
    public Object around(ProceedingJoinPoint joinPoint,
                         AuditOperation auditOperation) throws Throwable {
        auditSink.before(auditOperation.action(), joinPoint.getSignature().toShortString());
        try {
            Object result = joinPoint.proceed();
            auditSink.after(auditOperation.action(), true);
            return result;
        } catch (Throwable error) {
            auditSink.after(auditOperation.action(), false);
            throw error;
        }
    }
}
```

AOP truth：

- annotated method -> `AuditOperation` annotation application。
- pointcut -> annotation type reference。
- runtime proxy -> aspect advice -> target method，是 `FRAMEWORK_AOP`。
- `ProceedingJoinPoint.proceed` 不是对业务方法的普通静态 call target。

## 13. 噪音与负例设计

新增真实业务噪音：

| 名称 | 噪音来源 |
| --- | --- |
| `execute` | executor、step executor、plugin、test command |
| `validate` | request validator、change validator、rollback validator、JPA callback |
| `handle` | event handler、exception handler、callback handler |
| `process` | audit processor、window processor、notification processor |
| `dispatch` | command bus、event dispatcher、work scheduler |
| `save` | JPA repository、in-memory snapshot store、audit sink |
| `@Transactional` | service method、test fixture annotation string、文档常量 |
| `/api/network-changes` | mapping、OpenAPI description、日志文本、测试数据 |

负例要求：

- `UnrelatedExecuteService.execute` 不实现 `ChangeExecutor`。
- `ChangeDocumentation.getMappingExamples` 返回 mapping 文本，但不是 Controller。
- `FakeTransactionalMarker` 名称包含 Transactional，但不是 Spring annotation。
- `ChangeRecordDto` 有 `tableName` 字段，但不是 JPA entity。
- `PluginDescriptor.executeMethodName = "execute"` 只是反射配置。

## 14. Benchmark Case H～O

v2 Telecom 当前使用 D～F 和 U～Z；H～O 是连续空档。本专项使用标准 Telecom ID，从 H 开始连续编号，不与现有 v2 case 冲突。

### 14.1 Case H：Spring MVC Route Matrix

```text
ID: telecom-case-h-spring-route-matrix
类型: structure_extraction
```

任务：

```text
列出 network-change-service 的全部 HTTP route、HTTP method、完整路径和 handler，
并说明 class-level prefix、legacy RequestMapping、数组路径、组合注解和常量路径的处理结果。
```

Must include：R01～R12 的全部 ground-truth route。

Must exclude：日志、fixture 字符串和 documentation 中的假路径。

评分：route precision/recall、method accuracy、handler linkage。

### 14.2 Case I：Java Annotation Binding

```text
ID: telecom-case-i-java-annotation-binding
类型: symbol_navigation
```

任务：

```text
分析 ChangePlanService.approve 上的直接注解、注解元素、repeatable 注解和 meta-annotation，
给出每个注解类型及 action/category 等元素的定义位置。
```

必须区分：文本命中、symbol reference、annotation application edge、meta-annotation inference。

### 14.3 Case J：Spring DI Selection

```text
ID: telecom-case-j-spring-di-selection
类型: framework_dispatch
```

任务：

```text
分析 ChangeExecutionService 中 safeExecutor、executors、executorBeans 和 rollbackHandlerProvider
在 benchmark 与 dry-run profile 下的候选 bean 和确定目标。
```

Must include：qualifier、primary、profile、conditional property、集合注入。

### 14.4 Case K：Transaction Boundary

```text
ID: telecom-case-k-transaction-boundary
类型: framework_semantics
```

任务：

```text
列出创建、查询、执行、审计流程的 transaction boundary、readOnly、propagation，
并解释 approveAndRecordInternally 的 self-invocation 是否触发 REQUIRES_NEW。
```

扣分：只列出 `@Transactional` 文本位置，却声称已证明代理行为。

### 14.5 Case L：JPA Mapping and Repository Flow

```text
ID: telecom-case-l-jpa-mapping
类型: framework_structure
```

任务：

```text
从 NetworkChangeEntity 出发，列出 table/column/embedded/relationship/version 映射，
并追踪 ChangePlanService 到 repository save/find/query 的调用与代理边界。
```

### 14.6 Case M：Interface and Template Dispatch

```text
ID: telecom-case-m-dynamic-dispatch
类型: call_graph
```

任务：

```text
分析 ChangeExecutionService.execute 中 ChangeExecutor.execute 的 static target、possible targets，
以及 ROUTER/TRANSMISSION/RADIO 三组固定输入的 runtime target；继续展开模板方法 validate/apply。
```

这是动态调用专项主 case。

### 14.7 Case N：Overload, Lambda and Method Reference

```text
ID: telecom-case-n-overload-callback
类型: call_graph
```

任务：

```text
分别解析三个 ChangeCommandBus.dispatch 调用点的准确重载，
并追踪 lambda、method reference、callback registration 与 invocation target。
```

扣分：按方法名把三个 `dispatch` 合并为同一目标。

### 14.8 Case O：Event, AOP and Reflection Boundary

```text
ID: telecom-case-o-framework-reflection-boundary
类型: coverage_boundary
```

任务：

```text
分析 ChangeCompletedEvent listener、AuditOperationAspect 和 ChangePluginLoader 的调用关系，
分别标明普通 Java direct call、Spring framework dispatch、AOP proxy 和反射不可静态确定的边。
```

本 case 不以“找出越多边越好”为目标，而以边类型正确、不过度宣称为目标。

## 15. Ground-truth 文件设计

新增：

```text
docs/benchmark/v2/telecom/
  cases/
    telecom-case-h-spring-route-matrix.yaml
    telecom-case-i-java-annotation-binding.yaml
    telecom-case-j-spring-di-selection.yaml
    telecom-case-k-transaction-boundary.yaml
    telecom-case-l-jpa-mapping.yaml
    telecom-case-m-dynamic-dispatch.yaml
    telecom-case-n-overload-callback.yaml
    telecom-case-o-framework-reflection-boundary.yaml
  ground-truth/
    telecom-case-h-ground-truth.yaml
    telecom-case-i-ground-truth.yaml
    telecom-case-j-ground-truth.yaml
    telecom-case-k-ground-truth.yaml
    telecom-case-l-ground-truth.yaml
    telecom-case-m-ground-truth.yaml
    telecom-case-n-ground-truth.yaml
    telecom-case-o-ground-truth.yaml
  plan.yaml
```

调用类 ground truth 最小 schema：

```yaml
case: telecom-case-m-dynamic-dispatch
truth_version: "1.0"
source_commit: "<telecom project commit>"

call_sites:
  - id: execute-router
    caller: ChangeExecutionService.execute
    location: network-change-service/src/main/java/.../ChangeExecutionService.java
    static_target: ChangeExecutor.execute(ChangeContext)
    possible_targets:
      - RouterChangeExecutor.execute(ChangeContext)
      - TransmissionChangeExecutor.execute(ChangeContext)
      - RadioChangeExecutor.execute(ChangeContext)
      - DryRunChangeExecutor.execute(ChangeContext)
    runtime_cases:
      - profile: benchmark
        input: ROUTER
        target: RouterChangeExecutor.execute(ChangeContext)
    excluded_targets:
      - SafeChangeExecutor.execute(ChangeContext)
      - UnrelatedExecuteService.execute(ChangeContext)
    edge_kind: JAVA_INTERFACE_DISPATCH
```

注解类 ground truth 最小 schema：

```yaml
applications:
  - target: ChangePlanService.approve(String, OperatorContext)
    annotation: AuditOperation
    annotation_symbol: com.example.telecom.change.annotation.AuditOperation
    elements:
      action:
        symbol: AuditOperation.action()
        value: approve-change
      category:
        symbol: AuditOperation.category()
        value: CHANGE
    meta_annotations:
      - CriticalChange -> AuditOperation
      - CriticalChange -> ChangeGuard
```

Route ground truth 必须把一条数组 mapping 展开为两条 route，不得只保存原始 annotation 文本。

## 16. 结果采集与评分表

每次运行生成：

```text
runs/telecom-java-spring-semantics/<run-id>/
  environment.yaml
  index-summary.yaml
  routes.yaml
  annotation-bindings.yaml
  direct-calls.yaml
  dynamic-targets.yaml
  framework-edges.yaml
  unsupported.yaml
  score.yaml
```

`environment.yaml` 至少记录：

```yaml
project_commit: "..."
tool: aka | gitnexus
tool_commit: "..."
mode: tier0 | scip-java | default
jdk: "..."
maven: "..."
scip_java: "..."
index_command: "..."
rules_enabled: true | false
started_at: "..."
```

### 16.1 评分维度

| 维度 | 权重 | 口径 |
| --- | ---: | --- |
| Java symbol binding | 15 | annotation、overload、constructor、override target accuracy |
| Spring routes | 15 | route/method/path/handler precision & recall |
| Annotation semantics | 10 | application、element、repeatable、meta annotation |
| Direct call graph | 15 | 跨文件和重载 direct call precision & recall |
| Dynamic dispatch | 15 | interface/template/default possible-target precision & recall |
| Spring DI | 10 | qualifier/primary/collection/profile candidate accuracy |
| Transaction/JPA | 10 | mapping、boundary、propagation、repository proxy boundary |
| Event/AOP/reflection honesty | 10 | framework edge 分类和 unsupported 标注 |

### 16.2 禁止的评分捷径

- 不用“回答看起来合理”替代结构化 truth 对比。
- 不把源码文本搜索命中计为 symbol binding。
- 不把 `REFERENCES` 计为 `CALLS`。
- 不把 interface -> implementation 关系自动计为 call-site -> implementation。
- 不把所有 Spring bean 候选计为当前 profile runtime target。
- 不因工具明确标记 unsupported 而额外扣“幻觉边”之外的分；诚实暴露边界优于伪造精确边。

## 17. 测试与 runtime oracle

必须新增以下测试：

```text
NetworkChangeRouteMatrixTest
CustomAnnotationReflectionTest
RepeatableAnnotationTest
ComposedAnnotationTest
ChangeExecutorRegistryTest
ChangeExecutionDispatchTest
ChangeExecutionSpringSelectionTest
ChangeCommandBusOverloadTest
TemplateMethodDispatchTest
RollbackDefaultMethodTest
ChangePlanTransactionTest
TransactionSelfInvocationDocumentationTest
NetworkChangeJpaRepositoryTest
ChangeEventListenerTest
AuditOperationAspectTest
ChangePluginLoaderTest
CallbackRegistryTest
```

Runtime oracle 不能只写断言“非 null”，必须断言：

- route 数量、HTTP method 和完整路径。
- annotation type、element value、repeatable 展开和 meta annotation。
- profile/property 下实际注入的 bean class。
- ROUTER/TRANSMISSION/RADIO 对应实际 executor class。
- 每个 overload 对应唯一结果 marker。
- template method 调用了哪个 override。
- event listener 和 aspect 调用计数。
- JPA table/column/relationship 可写入并查询。
- 反射 plugin 的实际 class 和 method。

## 18. 实现顺序

### Goal 1：模块骨架与 JPA domain

```text
新增 network-change-service module、pom、application、domain/entity/repository/mapper。
加入 H2 test 配置，先让 repository test 和 mvn test 通过。
```

### Goal 2：自定义注解与 Spring MVC 矩阵

```text
实现 8 个注解、3 个 Controller、R01～R12 route 和对应负例。
完成 Case H/I YAML 与 ground truth，并登记到 v2 Telecom `plan.yaml`。
```

### Goal 3：DI 与 executor 动态分派

```text
实现 ChangeExecutor、AbstractChangeExecutor、五个 bean、registry、qualifier/profile/property。
完成 Case J/M ground truth 和 deterministic runtime tests，并登记到 v2 Telecom `plan.yaml`。
```

### Goal 4：transaction、event 与 AOP

```text
实现 transaction boundary、self-invocation 对照、Spring Event listeners、AuditOperationAspect。
完成 Case K/L/O ground truth，并登记到 v2 Telecom `plan.yaml`。
```

### Goal 5：重载、callback 与反射

```text
实现 ChangeCommandBus overload、lambda/method reference/callback、plugin reflection。
完成 Case N/O ground truth 和 runtime oracle，并登记到 v2 Telecom `plan.yaml`。
```

### Goal 6：双产品基线

```text
固定 telecom 项目 commit，依次运行 aka-tier0、aka-scip-java、gitnexus-default。
导出结构化结果并生成 score.yaml；人工复核 false positive/negative。
```

## 19. 生成约束

实现模型必须遵守：

1. 不得把 Spring annotations 只写在注释或 fixture 中。
2. 每个正例必须在生产源码中真实使用，并有测试或 ground truth。
3. 每个负例必须被 ground truth 明确列入 excluded。
4. 不得手工 `new RouterChangeExecutor()` 代替核心 Spring DI case。
5. 允许在纯 Java unit test 中直接构造对象，但必须另有 Spring selection test。
6. 不得用单个巨大类承载全部 probe。
7. 不得用反射实现普通 direct call；反射只限 Case O。
8. 不得让异步测试依赖 sleep；使用 latch、future 或 synchronous test executor。
9. 不得把所有实现类都标 `@Primary`。
10. 不得为了让静态工具容易识别而手工直接调用 event listener 或 aspect advice。
11. 不得在 ground truth 中把框架边标成普通 `CALLS`。
12. 所有 Java 文件必须编译，所有测试必须稳定重复通过。

## 20. 验收命令

PowerShell：

```powershell
$root='F:\develop\codes\Gitnexus-case-project\telecom-ops-platform'
Set-Location $root

mvn -pl network-change-service -am test
mvn test

$module=Join-Path $root 'network-change-service'
$main=Get-ChildItem -LiteralPath (Join-Path $module 'src\main\java') -Recurse -Filter *.java
$test=Get-ChildItem -LiteralPath (Join-Path $module 'src\test\java') -Recurse -Filter *.java
$all=@($main)+@($test)
$lines=0
foreach($file in $all){
  $lines += (Get-Content -LiteralPath $file.FullName | Measure-Object -Line).Lines
}
[pscustomobject]@{
  MainJava=$main.Count
  TestJava=$test.Count
  JavaLines=$lines
}

Get-ChildItem -LiteralPath $module -Recurse -Filter *.java |
  Select-String -Pattern '@Transactional|@Qualifier|@Primary|@Entity|@EventListener|@Aspect|@AuditOperation'
```

静态结构 sanity check：

```powershell
Get-ChildItem -LiteralPath $module -Recurse -Filter *.java |
  Select-String -Pattern 'interface ChangeExecutor|class AbstractChangeExecutor|executor.execute\(|joinPoint.proceed\(|method.invoke\('

$benchmarkRoot='F:\develop\codes\GitNexus_1.6.8-patch\GitNexus\docs\benchmark\v2\telecom'
Get-ChildItem -LiteralPath (Join-Path $benchmarkRoot 'cases') -Filter 'telecom-case-[h-o]-*.yaml'
Get-ChildItem -LiteralPath (Join-Path $benchmarkRoot 'ground-truth') -Filter 'telecom-case-[h-o]-ground-truth.yaml'
Select-String -LiteralPath (Join-Path $benchmarkRoot 'plan.yaml') -Pattern 'telecom-case-[h-o]-'
```

## 21. 完成标准

蓝图实现完成必须同时满足：

- Root Maven 聚合 7 个 module。
- `network-change-service` main Java >= 45、test Java >= 15、有效 Java 行数 >= 3200。
- `mvn test` 稳定通过。
- R01～R12 route 全部有 runtime/ground-truth 断言。
- 自定义注解定义、应用、元素、repeatable 和 meta annotation 全部存在。
- DI、transaction、JPA、event、AOP、reflection 场景均有正例和负例。
- direct/static/possible/runtime target 分层 ground truth 完整。
- Case H～O 各有 case YAML 和 ground-truth YAML，并全部登记到 v2 Telecom `plan.yaml`。
- AKA Tier-0、AKA + scip-java、GitNexus 三种结果分别记录，不能覆盖保存。
- 评分不把 reference 当 call，不把 implementation 当 call-site dispatch，不把 framework edge 当 direct call。

达到这些条件后，该模块才能用于验证报告中关于 Java 注解、Spring 注解和动态调用的结论；否则它只是增加了更多 Spring 风格代码，不能形成有审计价值的产品对比实验。
