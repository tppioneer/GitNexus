---
name: gitnexus-cli-local-zh
description: "当用户需要运行 GitNexus CLI 命令（分析/索引仓库、检查状态、清理索引、生成 Wiki、列出已索引仓库）时使用。本地模式下 CLI 在开发者的机器上直接执行。"
---

# GitNexus CLI 命令（本地模式）

以下命令在本机执行。GitNexus 已本地安装，索引由你自己维护。

## 命令

### analyze —— 构建或刷新索引

```bash
node .gitnexus/run.cjs analyze
```

在项目根目录运行。解析所有源文件，构建知识图谱，写入 `.gitnexus/`，并生成 CLAUDE.md / AGENTS.md 上下文文件。

| Flag | 作用 |
|------|------|
| `--force` | 强制全量重建索引，即使已是最新 |
| `--embeddings` | 启用 Embedding 生成以支持语义搜索（默认关闭） |
| `--drop-embeddings` | 重建时丢弃已有嵌入向量 |
| `--pdg` | 启用程序依赖图（污点分析、控制/数据依赖查询） |

**何时运行：** 第一次在项目中使用、代码有重大变更后、或 `gitnexus://repo/{name}/context` 提示索引过期时。

### status —— 检查索引新鲜度

```bash
node .gitnexus/run.cjs status
```

### clean —— 删除索引

```bash
node .gitnexus/run.cjs clean           # 当前仓库
node .gitnexus/run.cjs clean --all     # 所有仓库
```

`--force` 跳过确认。

### wiki —— 从图谱生成文档

```bash
node .gitnexus/run.cjs wiki
```

使用 LLM 从知识图谱生成仓库文档。

| Flag | 作用 |
|------|------|
| `--force` | 强制全量重新生成 |
| `--model <model>` | LLM 模型 |
| `--lang <lang>` | 生成文档的语言（如 english, chinese） |

### list —— 列出所有已索引仓库

```bash
node .gitnexus/run.cjs list
```

### mcp —— 启动 MCP 服务器（本地 stdio）

```bash
# 通常通过 skill 的 mcp.json 自动启动，无需手动运行
npx -y gitnexus.tgz
```

## 索引之后的步骤

1. **读取 `gitnexus://repo/{name}/context`** 确认索引已加载
2. 使用对应的 GitNexus local skill

## 故障排除

- **"Not inside a git repository"**：在 git 仓库目录内运行
- **重新分析后索引仍提示过期**：重启 Claude Code 重新加载 MCP 服务器
- **Embeddings 太慢**：不加 `--embeddings`（默认关闭），或设置 `OPENAI_API_KEY` 走更快的 API embedding
