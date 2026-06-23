---
name: gitnexus-cli
description: "当用户需要了解 GitNexus CLI 命令时使用。远程模式下 CLI 由服务端管理员执行，开发者通常不需要运行这些命令。"
---

# GitNexus CLI 命令（远程模式）

> **远程部署模式：** 以下命令在 GitNexus **服务器**上由管理员或 CI pipeline 执行，而非本地开发机。

## 服务端命令

### analyze —— 构建或刷新索引

```bash
gitnexus analyze                          # 自动增量
gitnexus analyze --force                  # 强制全量
gitnexus analyze --embeddings             # 含嵌入向量
gitnexus analyze --pdg                    # 含程序依赖图（污点分析）
gitnexus analyze --default-branch develop # 指定基准分支
```

### status —— 检查索引新鲜度

```bash
gitnexus status
```

### clean —— 删除索引

```bash
gitnexus clean --force
gitnexus clean --all --force
```

### wiki —— 从图谱生成文档

```bash
gitnexus wiki --force --lang chinese
```

### list —— 列出所有已索引仓库

```bash
gitnexus list
```

### serve —— 启动远程 HTTP MCP 服务

```bash
gitnexus serve --host 0.0.0.0 --port 4747
# 开发者端通过 MCP HTTP 连接: npx -y gitnexus.tgz --url http://<server>:4747/mcp
```

### mcp —— stdio 模式（本地调试用）

```bash
gitnexus mcp
```

## CI 集成示例

```yaml
# GitHub Actions 定时索引
schedule-index:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm install -g gitnexus
    - run: gitnexus analyze --embeddings --default-branch develop
```
