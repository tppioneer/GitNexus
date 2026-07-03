#!/usr/bin/env node
/** Compatibility entrypoint for version-scoped benchmark reports. */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
let version = null;
const forwarded = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--version' && index + 1 < args.length) {
    version = args[index + 1];
    index += 1;
  } else if (args[index].startsWith('--version=')) {
    version = args[index].slice('--version='.length);
  } else {
    forwarded.push(args[index]);
  }
}

if (!version || !/^v[1-9][0-9]*$/.test(version)) {
  console.error('Missing or invalid --version (for example: --version v1).');
  process.exit(2);
}

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const bundledPython = path.join(repoRoot, 'eval', '.venv', 'Scripts', 'python.exe');
const python = fs.existsSync(bundledPython) ? bundledPython : 'python';
const admin = path.join(repoRoot, 'eval', 'benchmark', 'version_admin.py');
const preflight = spawnSync(python, [admin, 'preflight', '--version', version], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (preflight.status !== 0) {
  process.exit(preflight.status === null ? 1 : preflight.status);
}
const target = path.join(repoRoot, 'docs', 'benchmark', version, 'report-viz', 'generate-report.js');
const result = spawnSync(process.execPath, [target, ...forwarded], { cwd: repoRoot, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
