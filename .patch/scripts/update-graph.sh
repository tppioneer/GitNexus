#!/bin/bash
# =============================================================================
# GitNexus 代码图谱增量更新脚本
#
# 按顺序执行:
#   1. 从 registry.json 读取所有已索引仓库路径
#   2. 增量拉取代码  (git pull --ff-only)
#   3. 增量构建索引  (gitnexus analyze --embeddings)
#   4. 更新 Group 合约 (gitnexus group sync)
#   5. 重启 MCP/Serve 服务
#
# 用法: ./update-graph.sh [选项]
#       ./update-graph.sh --help  查看完整说明
# =============================================================================
set -euo pipefail

# =============================================================================
# 配置 —— 可通过环境变量覆盖
# =============================================================================
GITNEXUS_HOME="${GITNEXUS_HOME:-$HOME/.gitnexus}"
REGISTRY_FILE="$GITNEXUS_HOME/registry.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"

# =============================================================================
# 默认选项
# =============================================================================
GROUP_NAME=""
SKIP_PULL=false
SKIP_ANALYZE=false
SKIP_GROUP_SYNC=false
SKIP_RESTART=false
DAEMON_INTERVAL=0
QUIET=false

# =============================================================================
# 使用说明
# =============================================================================
usage() {
    cat << 'HELP'
用法: update-graph.sh [选项]

代码图谱增量更新脚本
    拉取代码 → 增量构建 → 更新 Group → 重启服务

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
选项:
  --group <name>       只更新指定的 group
                       （默认: 自动检测 ~/.gitnexus/groups/ 下所有 group）
  --skip-pull          跳过 git pull，仅做分析和同步
  --skip-analyze       跳过增量构建，仅拉代码和同步
  --skip-group-sync    跳过 group 合约同步
  --skip-restart       跳过服务重启
  --quiet              减少输出，仅打印关键信息
  --daemon <秒>        持续循环模式，每隔指定秒数执行一次
                       Ctrl+C 可优雅退出
  --help               显示此帮助信息

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
环境变量:
  GITNEXUS_HOME        GitNexus 数据目录 （默认 ~/.gitnexus）
  LOG_DIR              日志输出目录 （默认 scripts/logs/）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
使用示例:

  # 完整增量更新流程
  ./update-graph.sh

  # 只更新指定 group
  ./update-graph.sh --group my-group

  # 只拉代码 + 构建索引，不更新 group
  ./update-graph.sh --skip-group-sync

  # 只构建索引（跳过拉代码、group sync 和重启）
  ./update-graph.sh --skip-pull --skip-group-sync --skip-restart

  # 持续循环，每 30 分钟执行一次
  ./update-graph.sh --daemon 1800

  # 后台运行持续循环
  nohup ./update-graph.sh --daemon 1800 >> /var/log/gitnexus/daemon.log 2>&1 &

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
定时任务 (crontab):
  # 每 2 小时执行一次
  0 */2 * * * /path/to/scripts/update-graph.sh >> /var/log/gitnexus/cron.log 2>&1

  # 每天早上 6 点执行
  0 6 * * * /path/to/scripts/update-graph.sh --group my-group >> /var/log/gitnexus/cron.log 2>&1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HELP
}

# =============================================================================
# 参数解析
# =============================================================================
while [[ $# -gt 0 ]]; do
    case "$1" in
        --group)
            GROUP_NAME="$2"
            shift 2
            ;;
        --skip-pull)
            SKIP_PULL=true
            shift
            ;;
        --skip-analyze)
            SKIP_ANALYZE=true
            shift
            ;;
        --skip-group-sync)
            SKIP_GROUP_SYNC=true
            shift
            ;;
        --skip-restart)
            SKIP_RESTART=true
            shift
            ;;
        --quiet)
            QUIET=true
            shift
            ;;
        --daemon)
            DAEMON_INTERVAL="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "未知选项: $1" >&2
            echo "使用 --help 查看帮助" >&2
            exit 1
            ;;
    esac
done

# =============================================================================
# 工具函数
# =============================================================================
# 全局日志文件，在 run_once() 中初始化
LOG_FILE=""

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg"
    [ -n "$LOG_FILE" ] && echo "$msg" >> "$LOG_FILE" || true
}

success() { log "  ✓ $*"; }
skip()    { log "  - $*"; }
warn()    { log "  ⚠ $*"; }
fail()    { log "  ✗ $*"; }

# 仅在非 quiet 模式下输出
info() {
    [ "$QUIET" = false ] && log "$@" || true
}

# =============================================================================
# 步骤 1: 从 registry.json 读取仓库路径列表
# =============================================================================
read_registry() {
    if [ ! -f "$REGISTRY_FILE" ]; then
        fail "registry.json 不存在: $REGISTRY_FILE"
        fail "请先执行 gitnexus analyze 初始化至少一个仓库"
        return 1
    fi

    # 用 node 解析 JSON 提取所有 path 字段
    node -e "
        var data = JSON.parse(require('fs').readFileSync('$REGISTRY_FILE', 'utf8'));
        if (!Array.isArray(data) || data.length === 0) {
            process.exit(1);
        }
        data.forEach(function(e) { console.log(e.path); });
    " 2>/dev/null
}

# =============================================================================
# 步骤 2: 增量拉取代码
# =============================================================================
git_pull_repo() {
    local repo_path="$1"

    if [ ! -d "$repo_path" ]; then
        fail "目录不存在，跳过"
        return 3  # skip
    fi

    if [ ! -d "$repo_path/.git" ]; then
        fail "不是 git 仓库，跳过"
        return 3  # skip
    fi

    cd "$repo_path" || { fail "无法进入目录"; return 3; }

    # 获取当前 HEAD
    local before
    before=$(git rev-parse HEAD 2>/dev/null) || { fail "无法获取 HEAD"; return 1; }

    # 执行 pull
    local pull_output
    if pull_output=$(git pull --ff-only 2>&1); then
        local after
        after=$(git rev-parse HEAD 2>/dev/null)

        if [ "$before" != "$after" ]; then
            # 有实际更新：显示变更信息
            local count
            count=$(git rev-list --count "${before}..${after}" 2>/dev/null || echo "?")
            success "已更新 ($count 个新提交: ${before:0:7} → ${after:0:7})"
            return 0  # 有更新
        else
            skip "已是最新 (${before:0:7})"
            return 2  # 无变化
        fi
    else
        # pull 失败
        fail "pull 失败"
        echo "$pull_output" >> "$LOG_FILE" 2>/dev/null || true
        return 1  # 失败
    fi
}

# =============================================================================
# 步骤 3: 增量构建索引
# =============================================================================
analyze_repo() {
    local repo_path="$1"

    if [ ! -d "$repo_path" ]; then
        fail "目录不存在，跳过"
        return 3
    fi

    cd "$repo_path" || { fail "无法进入目录"; return 3; }

    # 检查是否已索引（有无 .gitnexus/meta.json）
    if [ ! -f "$repo_path/.gitnexus/meta.json" ]; then
        warn "尚未索引，将执行首次完整构建..."
    fi

    local result
    # 执行增量分析（runFullAnalysis 内部自动判断是否需要重建）
    if result=$(gitnexus analyze --embeddings 2>&1); then
        echo "$result" >> "$LOG_FILE"

        if echo "$result" | grep -qi "already up to date"; then
            skip "索引已是最新"
            return 2  # 无变化
        fi

        # 提取统计信息
        local stats
        stats=$(echo "$result" | grep -oP '(?<=nodes: )\d+|(?<=edges: )\d+|(?<=files: )\d+' | tr '\n' ' ' || true)
        success "增量构建完成 (nodes/edges/files: ${stats:-见日志})"
        return 0  # 有更新
    else
        echo "$result" >> "$LOG_FILE"

        if echo "$result" | grep -qi "already up to date"; then
            skip "索引已是最新"
            return 2
        fi

        fail "构建失败，详见日志"
        return 1  # 失败
    fi
}

# =============================================================================
# 步骤 4: 自动检测 Group
# =============================================================================
detect_groups() {
    local groups_dir="$GITNEXUS_HOME/groups"

    if [ ! -d "$groups_dir" ]; then
        return 0  # 目录不存在，无 group
    fi

    local dir
    for dir in "$groups_dir"/*/; do
        [ -d "$dir" ] || continue
        [ -f "${dir}group.yaml" ] || continue
        basename "$dir"
    done
}

sync_group() {
    local name="$1"
    info "[sync] $name"

    # 先检查各 repo 状态
    if [ "$QUIET" = false ]; then
        gitnexus group status "$name" 2>&1 | tee -a "$LOG_FILE" || true
    else
        gitnexus group status "$name" >> "$LOG_FILE" 2>&1 || true
    fi

    # 执行合约同步
    local sync_output
    if sync_output=$(gitnexus group sync "$name" 2>&1); then
        echo "$sync_output" >> "$LOG_FILE"

        # 提取关键统计
        local contracts cross_links
        contracts=$(echo "$sync_output" | grep -oP '\d+(?= contracts)' || echo "?")
        cross_links=$(echo "$sync_output" | grep -oP '\d+(?= cross-links)' || echo "?")

        if [ "$QUIET" = false ]; then
            echo "$sync_output"
        fi
        success "Group '$name' 合约更新完成 ($contracts 合约, $cross_links 跨仓链接)"
        return 0
    else
        echo "$sync_output" >> "$LOG_FILE"
        fail "Group '$name' 同步失败"
        return 1
    fi
}

# =============================================================================
# 步骤 5: 重启服务
# =============================================================================
restart_service() {
    local start_script="$SCRIPT_DIR/start.sh"

    if [ ! -f "$start_script" ]; then
        fail "找不到服务管理脚本: $start_script"
        fail "请确保 scripts/start.sh 存在且支持 restart 命令"
        return 1
    fi

    if ! grep -q "restart" "$start_script" 2>/dev/null; then
        fail "$start_script 不支持 restart 命令"
        return 1
    fi

    info "[restart] 正在重启服务..."
    if bash "$start_script" restart >> "$LOG_FILE" 2>&1; then
        success "服务已重启"
        return 0
    else
        fail "服务重启失败，详见日志"
        return 1
    fi
}

# =============================================================================
# 清理旧日志（保留最近 30 天的日志文件）
# =============================================================================
cleanup_old_logs() {
    local max_days="${LOG_RETENTION_DAYS:-30}"
    if [ -d "$LOG_DIR" ]; then
        find "$LOG_DIR" -name "update-graph-*.log" -type f -mtime "+$max_days" -delete 2>/dev/null || true
    fi
}

# =============================================================================
# 主流程 —— 单次执行
# =============================================================================
run_once() {
    local start_time
    start_time=$(date +%s)

    # 初始化日志文件
    LOG_FILE="$LOG_DIR/update-graph-$(date +%Y%m%d-%H%M%S).log"
    mkdir -p "$LOG_DIR"

    {
        log "============================================"
        log "  代码图谱增量更新"
        log "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
        log "============================================"
    } >> "$LOG_FILE"

    echo ""
    log "======== 代码图谱增量更新 ========"

    # ── 读取仓库列表 ──
    local repos
    if ! repos=$(read_registry); then
        echo "$repos" >> "$LOG_FILE"  # read_registry 内部已经调用了 fail
        return 1
    fi

    local repo_count
    repo_count=$(echo "$repos" | wc -l)
    log "发现 $repo_count 个已索引仓库"

    # ── 计数器 ──
    local pulled=0 pull_failed=0 pull_skipped=0
    local analyzed=0 analyze_failed=0 analyze_skipped=0

    # ── 步骤 1: 增量拉取 ──
    if [ "$SKIP_PULL" = true ]; then
        info ">>> 步骤 1/4: 增量拉取 — 已跳过 (--skip-pull)"
    else
        echo ""
        info ">>> 步骤 1/4: 增量拉取代码"
        while IFS= read -r repo_path; do
            [ -z "$repo_path" ] && continue
            info "[pull] $repo_path"

            git_pull_repo "$repo_path"
            case $? in
                0) pulled=$((pulled + 1)) ;;
                1) pull_failed=$((pull_failed + 1)) ;;
                3) pull_skipped=$((pull_skipped + 1)) ;;
            esac
        done <<< "$repos"
        info "拉取完成: $pulled 已更新, $((repo_count - pulled - pull_failed - pull_skipped)) 已最新, $pull_failed 失败, $pull_skipped 跳过"
    fi

    # ── 步骤 2: 增量构建 ──
    if [ "$SKIP_ANALYZE" = true ]; then
        info ">>> 步骤 2/4: 增量构建 — 已跳过 (--skip-analyze)"
    else
        echo ""
        info ">>> 步骤 2/4: 增量构建索引"
        while IFS= read -r repo_path; do
            [ -z "$repo_path" ] && continue
            info "[analyze] $repo_path"

            analyze_repo "$repo_path"
            case $? in
                0) analyzed=$((analyzed + 1)) ;;
                1) analyze_failed=$((analyze_failed + 1)) ;;
                3) analyze_skipped=$((analyze_skipped + 1)) ;;
            esac
        done <<< "$repos"
        info "构建完成: $analyzed 已更新, $((repo_count - analyzed - analyze_failed - analyze_skipped)) 已最新, $analyze_failed 失败, $analyze_skipped 跳过"
    fi

    # ── 步骤 3: 更新 Group ──
    if [ "$SKIP_GROUP_SYNC" = true ]; then
        info ">>> 步骤 3/4: 更新 Group — 已跳过 (--skip-group-sync)"
    else
        echo ""
        info ">>> 步骤 3/4: 更新 Group 合约"

        local groups
        if [ -n "$GROUP_NAME" ]; then
            groups="$GROUP_NAME"
        else
            groups=$(detect_groups)
        fi

        if [ -z "$groups" ]; then
            skip "没有配置 group（$GITNEXUS_HOME/groups/ 下未找到 group.yaml）"
            skip "提示: 使用 gitnexus group create <name> 创建 group"
        else
            local group_count
            group_count=$(echo "$groups" | wc -l)
            info "检测到 $group_count 个 group"

            local group_failed=0
            for g in $groups; do
                echo ""
                sync_group "$g" || group_failed=$((group_failed + 1))
            done
        fi
    fi

    # ── 步骤 4: 重启服务 ──
    if [ "$SKIP_RESTART" = true ]; then
        info ">>> 步骤 4/4: 重启服务 — 已跳过 (--skip-restart)"
    else
        echo ""
        info ">>> 步骤 4/4: 重启服务"
        restart_service || true
    fi

    # ── 汇总 ──
    local elapsed
    elapsed=$(($(date +%s) - start_time))
    echo ""
    log "============================================"
    log "  汇总"
    log "  耗时: ${elapsed}s"
    log "  拉取: $pulled 更新, $pull_failed 失败, $pull_skipped 跳过"
    log "  构建: $analyzed 更新, $analyze_failed 失败, $analyze_skipped 跳过"
    log "  日志: $LOG_FILE"
    log "============================================"

    # 清理旧日志
    cleanup_old_logs
}

# =============================================================================
# 优雅退出（daemon 模式）
# =============================================================================
cleanup_on_exit() {
    echo ""
    log "收到退出信号，正在停止..."
    exit 0
}

# =============================================================================
# 入口
# =============================================================================
if [ "$DAEMON_INTERVAL" -gt 0 ]; then
    # ── Daemon 持续循环模式 ──
    trap cleanup_on_exit SIGINT SIGTERM

    echo "持续循环模式已启动，间隔 ${DAEMON_INTERVAL} 秒"
    echo "按 Ctrl+C 退出"
    echo ""

    local round=0
    while true; do
        round=$((round + 1))
        log "======== 第 $round 轮 ========"
        run_once || true
        echo ""
        log "下一轮: 约 ${DAEMON_INTERVAL} 秒后..."
        sleep "$DAEMON_INTERVAL" &
        wait $! 2>/dev/null || {
            # sleep 被信号中断
            cleanup_on_exit
        }
    done
else
    # ── 单次执行 ──
    run_once
fi
