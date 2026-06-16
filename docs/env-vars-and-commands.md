# GitNexus 环境变量与启动命令

---

## 一、analyze（索引构建）

```bash
# 基础
npx gitnexus analyze

# 带 embedding（语义搜索）
npx gitnexus analyze --embeddings

# 指定节点上限（0=不限制，默认 50000）
npx gitnexus analyze --embeddings 100000

# 强制重建（清空旧数据）
npx gitnexus analyze --force --embeddings
```

### analyze 环境变量

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `GITNEXUS_LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |
| `GITNEXUS_EMBEDDING_DEVICE` | 自动探测 | `cpu` / `cuda` / `dml`（Windows） |
| `GITNEXUS_EMBEDDING_THREADS` | CPU 核心数 | ONNX 推理线程数 |
| `GITNEXUS_EMBEDDING_BATCH_SIZE` | `16` | 每批处理节点数 |
| `GITNEXUS_EMBEDDING_SUB_BATCH_SIZE` | `8` | 每批推理 chunk 数 |
| `GITNEXUS_EMBEDDING_DIMS` | `384` | 向量维度（需与模型匹配） |
| `GITNEXUS_HF_OFFLINE` | 无 | `1`=离线模式，只用本地缓存 |
| `HF_ENDPOINT` | `https://huggingface.co` | 模型下载镜像（国内可用 `https://hf-mirror.com`） |
| `GITNEXUS_LBUG_MAX_DB_SIZE` | `17179869184`（16 GiB） | 数据库文件上限（字节） |
| `GITNEXUS_WAL_CHECKPOINT_THRESHOLD` | `67108864`（64 MiB） | WAL 自动 checkpoint 阈值 |
| `GITNEXUS_LBUG_EXTENSION_INSTALL` | analyze: `auto` | 扩展安装策略：`auto` / `load-only` / `never` |
| `GITNEXUS_PARSE_TIMEOUT_MS` | 内置值 | 单文件解析超时，`0`=禁用 |

---

## 二、MCP 服务（Claude Code 等 AI 工具用）

```bash
# 直接启动（日志在 stderr）
npx gitnexus mcp

# debug 日志
GITNEXUS_LOG_LEVEL=debug npx gitnexus mcp

# 日志落盘
npx gitnexus mcp 2>/var/log/gitnexus-mcp.log
```

### MCP 环境变量

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `GITNEXUS_LOG_LEVEL` | `info` | `debug` 可看到每次查询耗时 |
| `GITNEXUS_MCP_EXCLUDE_TOOLS` | 无 | 逗号分隔，禁用指定 MCP tool |
| `GITNEXUS_LBUG_EXTENSION_INSTALL` | `load-only` | MCP 不会触发网络下载 |

---

## 三、HTTP 服务（Web UI 用）

```bash
npx gitnexus serve

# debug 日志
GITNEXUS_LOG_LEVEL=debug npx gitnexus serve
```

### serve 环境变量

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `GITNEXUS_WEB_DIST` | 内置路径 | Web UI 静态文件目录 |

---

## 四、HTTP 模式 Embedding（替代本地 ONNX）

不想装 onnxruntime-node 时，用远程 API 做嵌入：

```bash
export GITNEXUS_EMBEDDING_URL=https://api.openai.com/v1
export GITNEXUS_EMBEDDING_MODEL=text-embedding-3-small
export GITNEXUS_EMBEDDING_API_KEY=sk-xxx
export GITNEXUS_EMBEDDING_DIMS=1536

npx gitnexus analyze --embeddings
```

| 环境变量 | 说明 |
|----------|------|
| `GITNEXUS_EMBEDDING_URL` | OpenAI 兼容的 embeddings API 地址 |
| `GITNEXUS_EMBEDDING_MODEL` | 模型名 |
| `GITNEXUS_EMBEDDING_API_KEY` | API Key |
| `GITNEXUS_EMBEDDING_DIMS` | 向量维度（需与模型输出一致） |

---

## 五、通用环境变量

| 环境变量 | 说明 |
|----------|------|
| `GITNEXUS_HOME` | GitNexus 全局数据目录，默认 `~/.gitnexus` |
| `GITNEXUS_DEBUG` | `1`=开启 hooks 和部分子系统的 debug |
| `GITNEXUS_VERBOSE` | `1`=wiki 生成时的详细输出 |
| `GITNEXUS_NO_GITIGNORE` | `1`=跳过 `.gitignore` 解析 |

---

## 六、一键完整示例

### Linux

```bash
# 索引 + embedding + 日志落盘
GITNEXUS_LOG_LEVEL=debug HF_ENDPOINT=https://hf-mirror.com \
  npx gitnexus analyze --embeddings 2>&1 | tee /var/log/gitnexus-analyze.log

# 启动 MCP 服务 + 日志落盘
GITNEXUS_LOG_LEVEL=debug npx gitnexus mcp 2>/var/log/gitnexus-mcp.log
```

### Windows PowerShell

```powershell
# 索引 + embedding + 日志落盘
set GITNEXUS_LOG_LEVEL=debug
set HF_ENDPOINT=https://hf-mirror.com
npx gitnexus analyze --embeddings 2>&1 | Tee-Object -FilePath C:\Users\Administrator\gitnexus-analyze.log

# 启动 MCP 服务 + 日志落盘
npx gitnexus mcp 2>C:\Users\Administrator\gitnexus-mcp.log
```

---

## 七、判断 embedding 是否生效

analyze 时观察终端输出，正常流程应看到：

```
🧠 Loading embedding model: Snowflake/snowflake-arctic-embed-xs
🔧 Trying CUDA GPU backend...
✅ Using CUDA backend
✅ Embedding model loaded successfully
🔍 Querying embeddable nodes...
📊 Found 14075 embeddable nodes
📇 Creating vector index...
✅ Embedding pipeline complete: 14075 nodes embedded, 21543 chunks
```

MCP 首次语义搜索时：

```
GitNexus: Loading embedding model (first search may take a moment)...
GitNexus: Embedding model loaded  { device: 'cpu' }
```

如果没看到这些日志，说明 embedding 未生效。常见原因：
- 没加 `--embeddings` 参数
- 节点数超过 50,000 上限被跳过
- 模型下载失败（检查 `HF_ENDPOINT`）
- Windows 上 VECTOR 扩展不可用（向量索引无法创建，但嵌入向量仍会生成）
