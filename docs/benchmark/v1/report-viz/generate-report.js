#!/usr/bin/env node
/**
 * generate-report.js — GitNexus Benchmark 可视化报告生成器
 *
 * 扫描 runs/ 目录下所有 report.json，聚合数据并注入 HTML 模板，
 * 生成一个独立的、带 Chart.js 交互图表的报告页面。
 *
 * Usage:
 *   node docs/benchmark/v1/report-viz/generate-report.js
 *   node docs/benchmark/v1/report-viz/generate-report.js --out custom-report.html
 */

const fs = require('fs');
const path = require('path');

// ── 路径配置 ──────────────────────────────────────────────────────────────────
const VERSION_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RUNS_DIR = process.argv.includes('--runs-dir')
  ? path.resolve(process.argv[process.argv.indexOf('--runs-dir') + 1])
  : path.join(REPO_ROOT, 'runs', 'v1');
const TEMPLATE_FILE = path.join(__dirname, 'template.html');
const DEFAULT_OUT = path.join(RUNS_DIR, 'benchmark-report.html');

const outFile = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : DEFAULT_OUT;

// ── 目录名解析 ────────────────────────────────────────────────────────────────
// e.g. "telecom-claude-deepseek-v4-pro" → { project: "telecom", agent: "claude-code", model: "deepseek-v4" }
function parseRunGroup(dirName) {
  const projects = ['telecom-large', 'telecom', 'qwenpaw', 'gitnexus'];
  for (const p of projects) {
    if (dirName.startsWith(p + '-') || dirName.startsWith(p + '_')) {
      const rest = dirName.slice(p.length + 1);
      const parts = rest.split('-');
      if (parts[0] === 'claude') {
        if (parts[1] === 'code') {
          return { project: p, agent: 'claude-code', model: parts.slice(2).join('-') };
        }
        return { project: p, agent: 'claude-code', model: parts.slice(1).join('-') };
      }
      if (parts[0] === 'opencode') {
        return { project: p, agent: 'opencode', model: parts.slice(1).join('-') };
      }
      return { project: p, agent: parts[0], model: parts.slice(1).join('-') };
    }
  }
  return { project: dirName, agent: 'unknown', model: 'unknown' };
}

// ── 收集所有 report.json ──────────────────────────────────────────────────────
function collectReports(runsDir) {
  const reports = [];
  if (!fs.existsSync(runsDir)) {
    console.warn('Warning: runs directory not found at ' + runsDir);
    return reports;
  }
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(runsDir, entry.name, 'report.json');
    if (!fs.existsSync(reportPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      data._meta = parseRunGroup(entry.name);
      data._dirName = entry.name;
      reports.push(data);
    } catch (e) {
      console.warn('Warning: failed to parse ' + reportPath + ': ' + e.message);
    }
  }
  return reports;
}

// ── 从 plan.yaml 读取项目概览 ─────────────────────────────────────────────────
function loadProjectOverviews() {
  const overviews = {};
  const planPaths = [
    { project: 'telecom', file: 'telecom/plan.yaml' },
    { project: 'telecom-large', file: 'telecom/large/plan.yaml' },
    { project: 'qwenpaw', file: 'qwenpaw/plan.yaml' },
    { project: 'gitnexus', file: 'gitnexus/plan.yaml' },
  ];
  for (const pp of planPaths) {
    const fullPath = path.join(VERSION_ROOT, pp.file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
      let inSection = false;
      const overview = {};
      for (const line of lines) {
        if (/^project_overview:$/.test(line)) { inSection = true; continue; }
        if (inSection && /^$/.test(line)) { break; }  // empty line ends section
        if (inSection && /^\S/.test(line)) { break; }  // top-level key ends section
        if (inSection) {
          const kv = line.match(/^\s{2}(\w+):\s*(.+)/);
          if (kv) {
            let val = kv[2].trim();
            if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
              val = val.slice(1, -1);
            }
            overview[kv[1]] = val;
          }
        }
      }
      if (overview.name) overviews[pp.project] = overview;
    } catch (e) { /* skip */ }
  }
  return overviews;
}

// ── 聚合数据 ─────────────────────────────────────────────────────────────────
function buildOverview(reports) {
  const projects = {};
  const allRows = [];

  for (const r of reports) {
    const p = r._meta.project;
    if (!projects[p]) projects[p] = { reports: [], models: new Set(), agents: new Set() };
    projects[p].reports.push(r);
    projects[p].models.add(r._meta.model);
    projects[p].agents.add(r._meta.agent);
    if (r.rows) {
      allRows.push.apply(allRows, r.rows.map(function(row) {
        row._project = p;
        row._model = r._meta.model;
        return row;
      }));
    }
  }

  const groups = [];
  for (const r of reports) {
    if (!r.by_agent_policy) continue;
    for (const g of r.by_agent_policy) {
      groups.push({
        project: r._meta.project,
        model: r._meta.model,
        agent: g.agent,
        tool_policy: g.tool_policy,
        count: g.count,
        passed_count: g.passed_count,
        avg_total: g.avg_total,
        pass_rate: g.pass_rate,
        p50_total: g.p50_total,
        p90_total: g.p90_total,
        avg_tool_call_count: g.avg_tool_call_count,
        avg_files_read_count: g.avg_files_read_count,
        avg_search_query_count: g.avg_search_query_count,
        avg_graph_query_count: g.avg_graph_query_count,
        avg_elapsed_ms: g.avg_elapsed_ms,
      });
    }
  }

  const uplifts = [];
  for (const r of reports) {
    if (!r.graph_uplift_by_agent) continue;
    for (const agent of Object.keys(r.graph_uplift_by_agent)) {
      uplifts.push({
        project: r._meta.project,
        model: r._meta.model,
        agent: agent,
        uplift_abs: Math.round(r.graph_uplift_by_agent[agent] * 100) / 100,
      });
    }
  }

  const projectList = Object.keys(projects).map(function(k) {
    return {
      name: k,
      models: Array.from(projects[k].models),
      agents: Array.from(projects[k].agents),
    };
  });

  return { projects: projectList, groups: groups, uplifts: uplifts, allRows: allRows };
}

// ── 生成 HTML ────────────────────────────────────────────────────────────────
function generateHtml(template, dataJson) {
  return template.replace('__DATA_JSON__', dataJson);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log('GitNexus Benchmark Report Generator');
  console.log('  Runs dir:  ' + RUNS_DIR);
  console.log('  Template:  ' + TEMPLATE_FILE);
  console.log('  Output:    ' + outFile);
  console.log('');

  // 读取模板
  if (!fs.existsSync(TEMPLATE_FILE)) {
    console.error('Template not found: ' + TEMPLATE_FILE);
    process.exit(1);
  }
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf-8');

  // 收集数据
  const reports = collectReports(RUNS_DIR);
  console.log('Found ' + reports.length + ' report.json files');

  if (reports.length === 0) {
    console.error('No report.json files found. Run some benchmarks first.');
    process.exit(1);
  }

  for (const r of reports) {
    console.log('  ' + r._dirName + ' -> project=' + r._meta.project + ', agent=' + r._meta.agent + ', model=' + r._meta.model + ', runs=' + r.run_count);
  }

  // 聚合
  const overview = buildOverview(reports);
  const projectOverviews = loadProjectOverviews();
  // 只保留有报告数据的 project overview
  const activeProjects = new Set(overview.allRows.map(function(r) { return r._project; }));
  for (const key of Object.keys(projectOverviews)) {
    if (!activeProjects.has(key)) delete projectOverviews[key];
  }

  // 构建前端数据
  const dataJson = JSON.stringify({
    projectOverviews: projectOverviews,
    reports: reports.map(function(r) {
      return {
        _meta: r._meta,
        score_file_count: r.score_file_count,
        run_count: r.run_count,
        valid_run_count: r.valid_run_count,
        invalid_run_count: r.invalid_run_count,
        by_agent_policy: r.by_agent_policy || [],
        graph_uplift_by_agent: r.graph_uplift_by_agent || {},
      };
    }),
    groups: overview.groups,
    uplifts: overview.uplifts,
    rows: overview.allRows,
    projects: overview.projects,
  });

  // 生成并写入
  const html = generateHtml(template, dataJson);

  // 确保输出目录存在
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(outFile, html, 'utf-8');
  console.log('');
  console.log('Report generated: ' + outFile);
  console.log('File size: ' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB');
}

main();
