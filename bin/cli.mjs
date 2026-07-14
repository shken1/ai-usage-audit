#!/usr/bin/env node
// Thin launcher so `npx ai-usage-audit` works: picks the right TypeScript
// flags for the running Node version and delegates to analyze.ts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../analyze.ts', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);

let flags;
if (major >= 24 || (major === 23 && minor >= 6)) {
  flags = []; // TypeScript runs natively
} else if ((major === 22 && minor >= 6) || major === 23) {
  flags = ['--experimental-strip-types', '--no-warnings'];
} else {
  console.error(
    `ai-usage-audit requires Node 22.6+ (found ${process.versions.node}). ` +
    'Alternatively run: npx tsx analyze.ts'
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [...flags, script, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
