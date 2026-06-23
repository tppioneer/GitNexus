---
name: gitnexus-cli-zh
description: "当用户需要了解 GitNexus CLI 命令（分析/索引仓库、检查状态、清理索引、生成 Wiki、列出已索引仓库）时使用。注意：远程部署模式下 CLI 由服务端管理员执行，开发者通常不需要运行这些命令。"
---

# GitNexus CLI 命令

> **远程部署模式：** 以下命令在 GitNexus **服务器**上执行，而非本地开发机。开发者通过 MCP HTTP 连接访问索引结果，不需要本地安装 gitnexus。

## 服务端命令

以下命令由服务端管理员或 CI pipeline 在 GitNexus 服务器上运行。

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
| `--drop-embeddings` | 重建时丢弃已有嵌入向量。默认情况下，不带 `--embeddings` 的 `analyze` 会保留它们。 |

**何时运行：** 第一次在项目中使用、代码有重大变更后、或 `gitnexus://repo/{name}/context` 提示索引过期时。

### status —— 检查索引新鲜度

```bash
node .gitnexus/run.cjs status
```

显示当前仓库是否有 GitNexus 索引、上次更新时间、符号/关系数量。用于判断是否需要重新索引。

### clean —— 删除索引

```bash
node .gitnexus/run.cjs clean
```

删除 `.gitnexus/` 目录并从全局注册表中取消注册。索引损坏或从项目中移除 GitNexus 时使用。

| Flag | 作用 |
|------|------|
| `--force` | 跳过确认 |
| `--all` | 清理全部已索引仓库，不只是当前仓库 |

### wiki —— 从图谱生成文档

```bash
node .gitnexus/run.cjs wiki
```

使用 LLM 从知识图谱生成仓库文档。首次使用需要 API Key（保存到 `~/.gitnexus/config.json`）。

| Flag | 作用 |
|------|------|
| `--force` | 强制全量重新生成 |
| `--model <model>` | LLM 模型（默认：minimax/minimax-m2.5） |
| `--base-url <url>` | LLM API 基础 URL |
| `--api-key <key>` | LLM API Key |
| `--concurrency <n>` | 并发 LLM 调用数（默认：3） |
| `--gist` | 将 Wiki 发布为公开 GitHub Gist |
| `--timeout <seconds>` | LLM 请求超时（秒，默认：不限制） |
| `--retries <n>` | 每个请求最多重试次数（默认：3） |
| `--lang <lang>` | 生成文档的语言（如 english, chinese, spanish, japanese） |

### list —— 列出所有已索引仓库

```bash
node .gitnexus/run.cjs list
```

列出 `~/.gitnexus/registry.json` 中注册的所有仓库。MCP 的 `list_repos` 工具提供同样信息。

## 索引之后的步骤

1. **读取 `gitnexus://repo/{name}/context`** 确认索引已加载
2. 为你的任务使用对应的 GitNexus skill（`exploring`、`debugging`、`impact-analysis`、`refactoring`）

## 故障排除

- **"Not inside a git repository"**：在 git 仓库目录内运行
- **重新分析后索引仍提示过期**：重启 Claude Code 重新加载 MCP 服务器
- **Embeddings 太慢**：不加 `--embeddings`（默认关闭），或设置 `OPENAI_API_KEY` 走更快的 API embedding
