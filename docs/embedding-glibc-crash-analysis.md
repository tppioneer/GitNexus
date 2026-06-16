# `gitnexus analyze --embeddings` glibc 版本相关崩溃分析

## 问题演进

| 阶段 | 现象 | 根因 |
|------|------|------|
| 第一阶段 | 磁盘空间暴涨至 30GB+ | `maxDBSize=16GiB` + glibc ≥2.28 `fallocate` 物理预分配 |
| 第二阶段 | 设置 `maxDBSize=8GiB` 后磁盘受控但进程被杀 | 磁盘问题解决后暴露内存/崩溃问题 |
| 第三阶段 | glibc 2.34 正常完成，2.38 崩溃 | glibc 2.38 `malloc` 破坏性变更触发 SIGSEGV |

## 完整技术链路

```
gitnexus analyze --embeddings (60,000 节点项目)
│
├─ Phase 1-2: 图数据写入 DuckDB (maxDBSize 预分配)
│   ├─ glibc ≥2.28: posix_fallocate → fallocate() → 物理块分配 → 17GB+
│   └─ glibc ≤2.24: ftruncate() → 稀疏文件 → ~200MB
│
├─ Phase 3: 嵌入生成 + INSERT (WAL 增长)
│   └─ ~75,000-100,000 行 CodeEmbedding → WAL 10-15GB
│
└─ Phase 4: CALL CREATE_VECTOR_INDEX (HNSW 构建) ← 崩溃点
    └─ DuckDB VECTOR 扩展 → usearch HNSW → SIMD 对齐内存分配
        ├─ glibc 2.34: aligned_alloc 容忍 size 不对齐 → 正常
        └─ glibc 2.38: aligned_alloc 严格检查 + memalign 新分配路径 → SIGSEGV
```

## glibc 版本差异对照

| 组件/行为 | glibc ≤2.24 | glibc 2.34 | glibc ≥2.38 |
|-----------|-------------|------------|-------------|
| `posix_fallocate` 实现 | 用户态写零 → 超时 → `ftruncate` | `fallocate` syscall | `fallocate` syscall |
| 磁盘预分配 | 稀疏文件 | 物理块 | 物理块 |
| `aligned_alloc` 容错 | 宽松 | 宽松 | 严格 (C17) |
| `memalign` 分配路径 | 老路径 (bin scanning) | 老路径 | 新路径 (移除 bin scan) |
| 磁盘问题 | 无 | **存在** | **存在** |
| 崩溃问题 | 无 | **无** | **存在 (SIGSEGV)** |

### glibc 2.38 的三个关键 malloc 变更

**① `aligned_alloc` 严格化**

```c
// C17 标准要求: size 必须是 alignment 的整数倍
void *aligned_alloc(size_t alignment, size_t size);

// glibc 2.34: 容忍 size % alignment != 0 → 返回有效内存
// glibc 2.38: 严格检查 → 返回 NULL
```

usearch HNSW 构建中使用 SIMD 加速向量距离计算（AVX2/AVX-512），需要对齐内存分配。如果内部有 `aligned_alloc(32, n)` 调用且 `n` 不是 32 的倍数 → 2.38 返回 NULL → 未检查直接写入 → SIGSEGV。

**② `memalign` bin scanning 被移除（bug 30723）**

glibc 2.38 重构了 `memalign` 实现：
- 移除从 free bin 中扫描对齐块的逻辑
- 启用 remainder merging
- 内存布局和复用模式完全改变

**③ `posix_memalign` 性能回归（已知 bug，有上游修复 patch）**

2.38.0 初版存在 `posix_memalign` 性能回归，侧面证实该版本的 malloc 实现质量不稳定。

## 崩溃位置精确定位

```
用户最后看到的输出:  "Embedding 33000/33000"

代码对应位置:
  embedding-pipeline.ts:522-531    ← Phase 3 嵌入批次循环完成
  embedding-pipeline.ts:536-540    ← onProgress({ phase: 'indexing', ... })
  embedding-pipeline.ts:543        ← if (isDev) logger.info('Creating vector index...')
  embedding-pipeline.ts:547        ← await createVectorIndex(executeQuery)
                                       ↓
  embedding-pipeline.ts:230        ← await executeQuery(CREATE_VECTOR_INDEX_QUERY)
                                       ↓
  lbug-adapter.ts:1351-1356       ← conn.prepare → conn.execute
                                       ↓
  DuckDB native C++ 层               CALL CREATE_VECTOR_INDEX(...)
                                       ↓
  VECTOR 扩展 → usearch              HNSW 多层近邻图构建
                                       ↓
  glibc 2.38 malloc                  aligned_alloc → NULL → SIGSEGV → 进程消失
```

> 用户看不到 "Creating vector index..." 因为 `run-analyze.ts:880` 对所有非 loading-model 阶段统一显示 `"Embedding X/Y"` 标签，该日志在 `isDev` 条件下才输出。

## 磁盘与内存消耗模型

### 60,000 节点项目

| 组件 | 数据量 | 说明 |
|------|--------|------|
| 总节点数 | 60,000 | |
| 可嵌入节点 (~55%) | ~33,000 | Function/Method/Class/Interface... |
| 平均 chunks/节点 | 2-3 | chunkSize=1200 字符, overlap=120 |
| CodeEmbedding 总行数 | ~75,000-100,000 | |
| 每行向量大小 | FLOAT[384] = 1536 字节 | |
| 纯向量数据 | ~115-150 MB | |
| HNSW 索引 (序列化后) | ~1.5-3.5 GB | 原始数据的 10-25× |
| 图数据 (节点+关系) | ~300-800 MB | |
| DuckDB 块对齐开销 | ~1.5× | 256KB/块 |
| **实际总数据** | **~2.5-5 GB** | |
| `maxDBSize=8GiB` 预分配 | ~8.6 GB | fallocate |
| WAL 峰值 | ~8-12 GB | 嵌入 INSERT + HNSW |
| **磁盘峰值 (glibc ≥2.28)** | **~17-22 GB** | |

### 内存消耗 (glibc 2.34 正常完成)

| 组件 | 内存 |
|------|------|
| DuckDB buffer pool (80% RAM capped by maxDBSize) | ~8 GB |
| usearch HNSW 构建工作内存 | ~2-3 GB |
| ONNX Runtime 推理 | ~500 MB |
| Node.js JS heap | ~1-2 GB |
| **总峰值** | **~12-14 GB** |

实测稳定在 6GB 左右（RSS），说明大部分内存是 mmap 映射或可回收的。

## 解决方案

### 磁盘控制

```bash
# 60,000 节点推荐值
export GITNEXUS_LBUG_MAX_DB_SIZE=8589934592   # 8 GiB
```

| 项目规模 | 推荐 maxDBSize |
|---------|---------------|
| < 5,000 节点 | 512 MiB (`536870912`) |
| 5,000-20,000 节点 | 1-2 GiB (`1073741824`-`2147483648`) |
| 20,000-60,000 节点 | 6-8 GiB (`6442450944`-`8589934592`) |
| > 60,000 节点 | 8-12 GiB |

### 崩溃绕过（glibc 2.38）

优先级从高到低：

**1. 替换 allocator（最可能有效）**

`LD_PRELOAD` 是 Linux 动态链接器 (`ld.so`) 的标准环境变量，在程序加载时优先注入指定的共享库，从而用 jemalloc 的实现替换 glibc 的 `malloc`/`free`/`aligned_alloc`/`posix_memalign` 等符号。**必须传 `.so` 文件的完整路径，不能只写库名。**

```bash
# 安装 jemalloc
sudo apt install libjemalloc2        # Ubuntu/Debian
sudo dnf install jemalloc            # RHEL/Fedora

# 确认 .so 路径
find /usr/lib* -name "libjemalloc*" 2>/dev/null
# 常见输出:
#   /usr/lib/x86_64-linux-gnu/libjemalloc.so.2    (Debian/Ubuntu)
#   /usr/lib64/libjemalloc.so.2                    (RHEL/Fedora)
#   /usr/lib/libjemalloc.so.2                      (Arch)

# 运行时替换（以 Ubuntu 路径为例，按实际 find 结果调整）
LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 \
GITNEXUS_LBUG_MAX_DB_SIZE=8589934592 \
npx gitnexus analyze --embeddings
```

**2. glibc malloc 调优**

```bash
# 限制 arena 数量，让分配模式回退到接近 2.34 的行为
MALLOC_ARENA_MAX=2 \
GITNEXUS_LBUG_MAX_DB_SIZE=8589934592 \
npx gitnexus analyze --embeddings
```

**3. 缩小数据集**

```bash
# 限制嵌入节点数，减小 HNSW 构建压力
npx gitnexus analyze --embeddings 10000
```

### 多磁盘环境部署

```bash
# 将所有临时/缓存目录迁移到大盘
HF_HOME=/data/hf_cache \
GITNEXUS_HOME=/data/gitnexus_home \
GITNEXUS_LBUG_MAX_DB_SIZE=8589934592 \
TMPDIR=/data/tmp \
mkdir -p /data/tmp /data/hf_cache /data/gitnexus_home
```

## 诊断命令速查

```bash
# glibc 版本
ldd --version | head -1

# 确认崩溃类型
dmesg | grep -i "segfault\|SIGSEGV" | tail -10
echo $?  # 137=SIGKILL, 139=SIGSEGV, 143=SIGTERM

# 实时监控磁盘
bash scripts/monitor-disk.sh 5

# strace 系统调用
strace -e fallocate,ftruncate -f npx gitnexus analyze --embeddings 2>&1 | tee /tmp/strace.log

# 查看 WAL 状态
ls -lh .gitnexus/lbug.wal .gitnexus/lbug.wal.checkpoint 2>/dev/null
```

## 上游修复建议

向 [LadybugDB](https://github.com/LadybugDB/ladybug) 提 issue，包含：

1. glibc 版本：`ldd --version`
2. 嵌入行数：`MATCH (e:CodeEmbedding) RETURN count(e)` 
3. dmesg segfault 日志
4. `MALLOC_ARENA_MAX=2` / `LD_PRELOAD=<完整路径>/libjemalloc.so.2` 能否绕过

根因预期在 DuckDB VECTOR 扩展的 usearch 中 `aligned_alloc` / `memalign` 的调用不兼容 glibc 2.38 的 C17 严格化要求。

## 相关文件

| 文件 | 内容 |
|------|------|
| `docs/embedding-disk-analysis.md` | 磁盘膨胀根因详细分析 |
| `scripts/monitor-disk.sh` | 磁盘实时监控脚本 |

## 变更历史

| 日期 | 变更 |
|------|------|
| 2026-06-16 | 初始版本 |
