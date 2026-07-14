/**
 * ai-usage-audit — where do my Claude Code tokens go?
 *
 * Read-only analyzer for ~/.claude/projects/ JSONL transcripts.
 * No dependencies. Run with either:
 *   npx tsx analyze.ts [--days N] [--json]
 *   node --experimental-strip-types analyze.ts [--days N] [--json]
 *
 * With --json, stdout carries only the JSON document; all human-readable
 * messages go to stderr.
 */

const VERSION = '0.1.0';

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------- CLI args ----------

const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
let days = 14;
const daysIdx = argv.indexOf('--days');
if (daysIdx !== -1) {
  const v = Number(argv[daysIdx + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`--days expects a positive number, got: ${argv[daysIdx + 1]}`);
    process.exit(1);
  }
  days = v;
}

const now = Date.now();
const cutoff = now - days * 24 * 60 * 60 * 1000;

// ---------- types ----------

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

interface MessageRecord extends Tokens {
  ts: number;
  project: string;
  session: string;
  model: string;
  sidechain: boolean;
  apiError: boolean;
}

interface SessionAgg extends Tokens {
  project: string;
  session: string;
  firstUserMsg: string;
  messages: number;
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const totalOf = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheCreate;
const addTo = (dst: Tokens, src: Tokens) => {
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheCreate += src.cacheCreate;
};

// ---------- discovery ----------

const root = join(homedir(), '.claude', 'projects');

function findJsonl(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir: skip
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Folder names encode the project path with '-' separators; strip the
// home-dir prefix so tables show the meaningful tail.
function projectLabel(folder: string): string {
  const stripped = folder.replace(/^-Users-[^-]+-/, '').replace(/^-/, '');
  return stripped.length > 34 ? '…' + stripped.slice(-33) : stripped;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

// ---------- parsing ----------

// Dedupe map: message.id + requestId → latest record wins (streaming
// rewrites append newer, more complete copies of the same message).
const byKey = new Map<string, MessageRecord>();
const firstUserMsgBySession = new Map<string, string>();
// Subagent transcripts have only sidechain user events; keep those as a fallback.
const firstSidechainMsgBySession = new Map<string, string>();

let malformedLines = 0;
let assistantNoUsage = 0;
let noTimestamp = 0;
let duplicates = 0;
let noStableId = 0;
let syntheticId = 0;
let filesScanned = 0;
let filesSkippedOld = 0;

function extractUserText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) return text;
      }
    }
  }
  return null;
}

async function scanFile(path: string): Promise<void> {
  const project = basename(dirname(path));
  const session = basename(path, '.jsonl');
  const sessionKey = `${project}/${session}`;

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }

    if (ev.type === 'user') {
      const map = ev.isSidechain ? firstSidechainMsgBySession : firstUserMsgBySession;
      if (!map.has(sessionKey)) {
        const text = extractUserText(ev.message);
        if (text) map.set(sessionKey, truncate(text, 60));
      }
      continue;
    }

    if (ev.type !== 'assistant') continue;

    const usage = ev.message?.usage;
    if (!usage || typeof usage !== 'object') {
      assistantNoUsage++;
      continue;
    }

    const ts = Date.parse(ev.timestamp ?? '');
    if (!Number.isFinite(ts)) {
      noTimestamp++;
      continue;
    }

    // Top-level four fields only; the nested `iterations` array repeats them.
    const rec: MessageRecord = {
      ts,
      project,
      session,
      model: typeof ev.message?.model === 'string' ? ev.message.model : '(unknown)',
      input: Number(usage.input_tokens) || 0,
      output: Number(usage.output_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheCreate: Number(usage.cache_creation_input_tokens) || 0,
      sidechain: ev.isSidechain === true,
      apiError: ev.isApiErrorMessage === true,
    };

    // Dedupe key hierarchy:
    //  1. message.id (+ requestId) — the intended key; streaming rewrites of
    //     the same message share it, so last-write-wins collapses them.
    //  2. event uuid — unique per line, so no cross-line dedupe happens, but
    //     each event is still counted exactly once.
    //  3. neither present — a synthetic unique key, so events are never
    //     silently collapsed into one shared "no-id" bucket.
    const msgId = typeof ev.message?.id === 'string' && ev.message.id ? ev.message.id : null;
    const evUuid = typeof ev.uuid === 'string' && ev.uuid ? ev.uuid : null;
    let key: string;
    if (msgId) key = `${msgId}:${typeof ev.requestId === 'string' ? ev.requestId : ''}`;
    else if (evUuid) key = `uuid:${evUuid}`;
    else { noStableId++; key = `synthetic:${++syntheticId}`; }
    if (byKey.has(key)) duplicates++;
    byKey.set(key, rec); // last write wins
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  const rootDisplay = root.replace(homedir(), '~');
  if (!existsSync(root)) {
    console.error(`${rootDisplay} does not exist — has Claude Code been run on this machine?`);
    process.exit(1);
  }
  const allFiles = findJsonl(root);
  if (allFiles.length === 0) {
    console.error(`No session transcripts (.jsonl) found under ${rootDisplay} — nothing to analyze.`);
    process.exit(1);
  }

  for (const f of allFiles) {
    // A file's mtime is its last append; if that predates the cutoff,
    // every event inside is older than the window.
    if (statSync(f).mtimeMs < cutoff) {
      filesSkippedOld++;
      continue;
    }
    filesScanned++;
    await scanFile(f);
  }

  if (filesScanned === 0) {
    console.error(`Found ${allFiles.length} session file(s), but none modified in the last ${days} day(s) — try a larger --days.`);
    process.exit(1);
  }

  // Aggregate deduped records within the window.
  const totals = zero();
  const sidechain = zero();
  const errors = zero();
  const byModel = new Map<string, Tokens & { messages: number }>();
  const bySession = new Map<string, SessionAgg>();
  let messagesInWindow = 0;

  for (const rec of byKey.values()) {
    if (rec.ts < cutoff) continue;
    messagesInWindow++;
    addTo(totals, rec);
    if (rec.sidechain) addTo(sidechain, rec);
    if (rec.apiError) addTo(errors, rec);

    let m = byModel.get(rec.model);
    if (!m) byModel.set(rec.model, (m = { ...zero(), messages: 0 }));
    addTo(m, rec);
    m.messages++;

    const sk = `${rec.project}/${rec.session}`;
    let s = bySession.get(sk);
    if (!s) {
      bySession.set(sk, (s = {
        ...zero(),
        project: rec.project,
        session: rec.session,
        firstUserMsg: firstUserMsgBySession.get(sk)
          ?? firstSidechainMsgBySession.get(sk)
          ?? '(no user message found)',
        messages: 0,
      }));
    }
    addTo(s, rec);
    s.messages++;
  }

  const grandTotal = totalOf(totals);
  const models = [...byModel.entries()].sort((a, b) => totalOf(b[1]) - totalOf(a[1]));
  const topSessions = [...bySession.values()]
    .sort((a, b) => totalOf(b) - totalOf(a))
    .slice(0, 5);

  const pct = (part: number, whole: number) =>
    whole > 0 ? ((100 * part) / whole).toFixed(1) + '%' : 'n/a';
  const cacheHitRatio = totals.input + totals.cacheRead > 0
    ? totals.cacheRead / (totals.input + totals.cacheRead)
    : null;
  const topModelShare = models.length > 0 && grandTotal > 0
    ? totalOf(models[0][1]) / grandTotal
    : null;

  // Sanity flags — surfaced instead of hidden.
  const warnings: string[] = [];
  if (messagesInWindow === 0) warnings.push(`No assistant messages found in the last ${days} days.`);
  if (messagesInWindow > 0 && totals.cacheRead === 0)
    warnings.push('cache_read is zero everywhere — either caching is off or the usage schema changed; treat cache stats as suspect.');
  if (messagesInWindow > 0 && totals.output === 0)
    warnings.push('output_tokens is zero everywhere — usage schema may have changed.');
  if (assistantNoUsage > 0)
    warnings.push(`${assistantNoUsage} assistant event(s) had no usage object (skipped).`);
  if (noTimestamp > 0)
    warnings.push(`${noTimestamp} assistant event(s) had no parsable timestamp (skipped).`);
  if (noStableId > 0)
    warnings.push(`${noStableId} assistant event(s) had neither message.id nor uuid — counted without dedupe (totals may be slightly inflated if these were streaming rewrites).`);
  if (malformedLines > 0)
    warnings.push(`${malformedLines} malformed line(s) skipped.`);

  if (jsonMode) {
    // stdout carries only the JSON document; human-readable notes go to stderr.
    for (const w of warnings) console.error('⚠ ' + w);
    console.log(JSON.stringify({
      version: VERSION,
      generatedAt: new Date(now).toISOString(),
      windowDays: days,
      files: { scanned: filesScanned, skippedOlderThanWindow: filesSkippedOld },
      lines: { malformed: malformedLines, assistantWithoutUsage: assistantNoUsage, missingTimestamp: noTimestamp },
      messages: { inWindow: messagesInWindow, duplicatesRemoved: duplicates },
      totals: { ...totals, total: grandTotal },
      sidechain: { ...sidechain, total: totalOf(sidechain) },
      apiErrors: { ...errors, total: totalOf(errors) },
      ratios: {
        cacheHitRatio,
        outputShare: grandTotal > 0 ? totals.output / grandTotal : null,
        topModelShare,
      },
      byModel: models.map(([model, t]) => ({ model, ...t, total: totalOf(t) })),
      topSessions: topSessions.map(s => ({
        project: s.project,
        session: s.session,
        firstUserMsg: s.firstUserMsg,
        messages: s.messages,
        total: totalOf(s),
        input: s.input, output: s.output, cacheRead: s.cacheRead, cacheCreate: s.cacheCreate,
      })),
      warnings,
    }, null, 2));
    return;
  }

  // ---------- report ----------

  const fmt = (n: number) => n.toLocaleString('en-US');
  const line = (label: string, value: string, extra = '') =>
    console.log('  ' + label.padEnd(24) + value.padStart(15) + (extra ? '   ' + extra : ''));

  const from = new Date(cutoff).toISOString().slice(0, 10);
  const to = new Date(now).toISOString().slice(0, 10);
  console.log(`\nClaude Code token usage — last ${days} days (${from} → ${to})`);
  console.log(
    `Scanned ${filesScanned} session file(s) (${filesSkippedOld} older files skipped) · ` +
    `${fmt(messagesInWindow)} messages · ${fmt(duplicates)} duplicate usage entries removed\n`
  );

  console.log('TOTALS');
  line('input', fmt(totals.input), pct(totals.input, grandTotal));
  line('output', fmt(totals.output), pct(totals.output, grandTotal));
  line('cache_read', fmt(totals.cacheRead), pct(totals.cacheRead, grandTotal));
  line('cache_creation', fmt(totals.cacheCreate), pct(totals.cacheCreate, grandTotal));
  line('total', fmt(grandTotal));
  line('sidechain (subagents)', fmt(totalOf(sidechain)), pct(totalOf(sidechain), grandTotal) + ' of total');
  if (totalOf(errors) > 0)
    line('wasted on errors', fmt(totalOf(errors)), pct(totalOf(errors), grandTotal) + ' of total');

  console.log('\nBY MODEL');
  const modelW = Math.max(12, ...models.map(([m]) => m.length));
  console.log(
    '  ' + 'model'.padEnd(modelW) + 'total'.padStart(15) + '%'.padStart(8) +
    'input'.padStart(13) + 'output'.padStart(12) + 'cache_read'.padStart(14) + 'cache_creat'.padStart(13)
  );
  for (const [model, t] of models) {
    console.log(
      '  ' + model.padEnd(modelW) + fmt(totalOf(t)).padStart(15) + pct(totalOf(t), grandTotal).padStart(8) +
      fmt(t.input).padStart(13) + fmt(t.output).padStart(12) + fmt(t.cacheRead).padStart(14) + fmt(t.cacheCreate).padStart(13)
    );
  }

  console.log('\nTOP 5 SESSIONS BY TOTAL TOKENS');
  for (const s of topSessions) {
    console.log(`  ${fmt(totalOf(s)).padStart(15)}   ${projectLabel(s.project).padEnd(34)} ${s.firstUserMsg}`);
  }

  console.log('\nRATIOS');
  // Two decimals near the extremes so 99.96% doesn't display as a suspicious 100.0%.
  line('cache hit ratio',
    cacheHitRatio === null ? 'n/a'
      : (100 * cacheHitRatio).toFixed(cacheHitRatio > 0.995 || cacheHitRatio < 0.005 ? 2 : 1) + '%',
    'cache_read / (input + cache_read) — low means caching opportunity');
  line('output share', grandTotal > 0 ? pct(totals.output, grandTotal) : 'n/a', 'output / total');
  if (topModelShare !== null && models.length > 0)
    line('top model share', (100 * topModelShare).toFixed(1) + '%', `share of all tokens on ${models[0][0]}`);

  if (warnings.length > 0) {
    console.log('\nWARNINGS');
    for (const w of warnings) console.log('  ⚠ ' + w);
  }
  console.log();
}

main().catch(err => {
  console.error('analyze.ts failed:', err?.message ?? err);
  process.exit(1);
});
