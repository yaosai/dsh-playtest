import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIMIT = 1024 * 1024;
const RUN_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const ACTIVE = new Set(['running', 'starting', 'cancelling']);
const errorText = e => e instanceof Error ? e.message : String(e);
const fail = error => ({ ok: false, error });

/** Keep only exit facts; piped handles, providers and target identity are live objects. */
export function exitFacts(outcome) {
  return { exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null };
}

/** Keep tool output JSON-safe: numbers stay finite, big ints/long strings are stringified. */
function lossless(value, limit = 64 * 1024) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) return String(item);
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'string' && item.length > limit) return item.slice(0, limit) + '…[host truncated]';
      return item;
    }));
  } catch {
    return { ok: false, error: 'Run output is not JSON-safe; inspect the run artifacts directly.',
      runId: value && value.runId, truncated: true };
  }
}

/** Shared test operations for tools and human UI commands. No LLM or agent loop. */
export class PlaytestOperations {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.runs = new Map();
    this.pending = new Set();
    this.closed = false;
  }

  async environment(agent, args = {}, signal) {
    if (!agent?.session || !agent?.ctx) throw new Error('Playtest requires a receiving DSH session.');
    const get = key => agent.ctx.get(key) ?? this.ctx.get(key);
    const fs = get('fs');
    const subprocess = get('subprocess');
    const sandboxPolicy = get('sandboxPolicy');
    const workingDirectory = get('workingDirectory');
    if (!fs || !subprocess || !sandboxPolicy || !workingDirectory) throw new Error('This preset lacks filesystem, subprocess or sandbox policy capabilities.');
    const cwd = await workingDirectory.ensure(agent, signal);
    const target = await fs.resolve(args.repoRoot || this.config.repoRoot || cwd, { cwd, signal });
    const info = await fs.stat(target, signal);
    if (info?.type !== 'directory') throw new Error('repoRoot must be an existing directory.');
    const policy = sandboxPolicy.resolve({ session: agent.session });
    const rootTarget = await fs.resolve(policy.workspaceRoot, { signal });
    return { agent, fs, subprocess, sandbox: get('sandbox'), approval: get('approval'),
      repoRoot: fs.processPath(target), target, rootTarget, policy, signal };
  }

  checkWrite(env) {
    if (env.policy.mode === 'read-only') throw new Error('Current session is read-only. Runs write evidence; change session permission before running.');
    if (env.policy.mode !== 'danger-full-access' && !env.fs.contains(env.rootTarget, env.target)) {
      throw new Error('Test repository is outside this session workspace. No permission was expanded.');
    }
  }

  async spawn(env, request, onEvent, signal = env.signal) {
    const cli = env.fs.processPathFromHostPath(join(HERE, 'engine', 'cli.py'));
    if (!cli) throw new Error('This execution backend cannot access the installed Python engine.');
    const python = await env.subprocess.resolveExecutable(this.config.pythonPath || 'python3', undefined, signal);
    let argv = [python, cli];
    let enforcement = 'unconfined-full-access';
    if (env.policy.mode !== 'danger-full-access') {
      if (!env.sandbox) throw new Error('No process sandbox is available; refusing unconfined execution.');
      const confined = await env.sandbox.confine(argv, env.policy, signal);
      argv = confined.argv;
      enforcement = confined.enforcement;
    }
    const input = JSON.stringify({ ...request, repoRoot: env.repoRoot });
    if (Buffer.byteLength(input) > LIMIT) throw new Error('Test request exceeds 1 MiB.');
    const handle = env.subprocess.spawn({ argv, cwd: env.repoRoot,
      stdio: { stdin: { data: input }, stdout: 'pipe', stderr: 'pipe' },
      graceMs: 40000, signal,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'en_US.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' } });
    let buffer = '', stdout = '', stderr = '', terminal = null, parseError = null;
    const line = raw => {
      if (!raw.trim()) return;
      try {
        const value = JSON.parse(raw);
        if (onEvent) {
          onEvent(value);
          if (value.type === 'run_finished') terminal = value.result;
          else if (value.ok === false && !value.type) terminal = { ...value, status: 'error',
            verdict: 'inconclusive', execution: 'error', cleanup: 'unknown' };
        } else terminal = value;
      } catch (e) { parseError = `Invalid engine JSON: ${errorText(e)}`; }
    };
    handle.stdout?.setEncoding('utf8');
    handle.stderr?.setEncoding('utf8');
    handle.stdout?.on('data', chunk => {
      if (!onEvent) stdout = (stdout + chunk).slice(0, LIMIT);
      buffer += chunk;
      if (buffer.length > LIMIT) { parseError = 'Engine event exceeds 1 MiB.'; handle.terminate(); buffer = ''; return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    handle.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const done = handle.done.then(outcome => {
      if (buffer.trim()) line(buffer);
      if (!onEvent && !terminal && stdout.trim()) {
        try { terminal = JSON.parse(stdout); } catch { /* reported below */ }
      }
      const exit = exitFacts(outcome);
      if (terminal) return { ...terminal, process: exit, sandboxEnforcement: enforcement };
      return { ok: false, error: parseError || stderr.trim() || 'Engine ended without a result.',
        execution: 'error', cleanup: 'unknown', verdict: 'inconclusive', status: 'error', process: exit };
    });
    return { handle, done, enforcement };
  }

  async invoke(env, request) {
    const child = await this.spawn(env, request);
    const timer = setTimeout(() => child.handle.terminate(), 30000);
    try { return await child.done; } finally { clearTimeout(timer); }
  }

  async preview(env, args) {
    return this.invoke(env, { action: 'inspect', play: args.play, plays: args.plays,
      scenario: args.scenario, target: args.target });
  }

  async authorize(env, args, preview, caller, callId) {
    if (!preview.requiresConfirmation) return true;
    if (caller === 'user') {
      if (args.userConfirmedEffects !== true || !args.expectedDigest) {
        throw new Error('Review the current preview and explicitly confirm real-system/database effects before starting.');
      }
      return true;
    }
    if (!env.approval) throw new Error('Effects require user approval, but no approval service is available.');
    const reason = `Playtest: ${env.repoRoot}; test=${args.play || (args.plays || []).join(',')}; digest=${preview.digest}; effects=${JSON.stringify(preview.effects || []).slice(0, 3000)}. This does not expand file permissions.`;
    const outcome = await env.approval.request({ agent: env.agent, toolName: 'playtest_run_play', callId,
      reason, displayReason: { en: reason, zh: `即将执行测试并产生真实系统或数据库效果：${reason}` }, signal: env.signal });
    if (outcome !== 'allowed-once') throw new Error(`Test effects were not approved (${outcome}).`);
    return true;
  }

  recordEvent(record, event) {
    record.count += 1;
    record.events.push({ ...event, offset: record.count });
    if (record.events.length > 300) record.events.shift();
    const data = event.step || event.result || event;
    const identity = { phase: data.phase || event.phase, play: data.play || event.play || event.suite,
      stepNo: data.stepNo ?? event.stepNo, name: data.name || event.name };
    if (event.type === 'step_started') {
      record.steps.push({ ...identity, status: 'running', startedAt: event.time });
    }
    if (event.type === 'step_finished') {
      const index = record.steps.findIndex(s => s.phase === identity.phase && s.play === identity.play && s.stepNo === identity.stepNo);
      const step = { ...identity, ...data, status: data.status || (data.ok ? 'passed' : 'failed') };
      if (index >= 0) record.steps[index] = { ...record.steps[index], ...step };
      else record.steps.push(step);
    }
    if (event.type === 'run_finished' && event.result) {
      record.result = event.result;
      record.status = event.result.status || (event.result.ok ? 'completed' : 'failed');
    }
  }

  async start(env, args, caller, callId) {
    this.checkWrite(env);
    if (this.closed) throw new Error('Playtest is unloading.');
    const concurrent = [...this.runs.values()].find(r => r.repoRoot === env.repoRoot && ACTIVE.has(r.status));
    if (concurrent) throw new Error(`A test is already active in this repository: ${concurrent.runId}`);
    // Reserve the repository before awaiting preview/approval to avoid concurrent setup races.
    if (this.pending.has(env.repoRoot)) throw new Error('A start request is already pending in this repository.');
    this.pending.add(env.repoRoot);
    try {
      const preview = await this.preview(env, args);
      if (!preview.ok) return preview;
      if (args.expectedDigest && args.expectedDigest !== preview.digest) throw new Error('Test assets changed after preview; inspect again.');
      await this.authorize(env, args, preview, caller, callId);
      env.signal?.throwIfAborted();
      if (this.closed) throw new Error('Playtest was unloaded while this request was pending.');
      // Approval may outlive a permission switch. Resolve the session policy again without escalating it.
      env = await this.environment(env.agent, { repoRoot: env.repoRoot }, env.signal);
      this.checkWrite(env);
      const runId = randomUUID().replaceAll('-', '');
      const controller = new AbortController();
      const record = { runId, repoRoot: env.repoRoot, ownerSessionId: env.agent.id, status: 'starting',
        startedAt: new Date().toISOString(), count: 0, events: [], steps: [], result: null, controller };
      const request = { action: 'run', play: args.play, plays: args.plays, scenario: args.scenario, target: args.target,
        expectedDigest: preview.digest, runId, ownerSessionId: env.agent.id,
        allowEffects: preview.requiresConfirmation === true, skipCleanup: args.skipCleanup === true };
      const child = await this.spawn(env, request, event => this.recordEvent(record, event), controller.signal);
      record.handle = child.handle;
      record.status = 'running';
      record.sandboxEnforcement = child.enforcement;
      this.runs.set(runId, record);
      const timeout = setTimeout(() => { record.status = 'cancelling'; child.handle.terminate(); }, 15 * 60 * 1000);
      record.done = child.done.then(result => {
        record.result = { ...result, ownerSessionId: env.agent.id };
        record.status = result.status || (result.ok ? 'completed' : 'failed');
      }).catch(e => {
        record.result = { ok: false, error: errorText(e), verdict: 'inconclusive', execution: 'error', cleanup: 'unknown' };
        record.status = 'error';
      }).finally(() => { clearTimeout(timeout); record.finishedAt = new Date().toISOString(); });
      return { ok: true, runId, status: 'running', repoRoot: env.repoRoot, digest: preview.digest,
        artifacts: join(env.repoRoot, '.playtest', 'runs', runId), sandboxEnforcement: child.enforcement,
        hint: 'Read this run with playtest action=read; cancellation stops the run and attempts cleanup.' };
    } finally { this.pending.delete(env.repoRoot); }
  }

  summary(r) {
    const value = r.result || {};
    return { runId: r.runId, repoRoot: r.repoRoot, status: r.status,
      startedAt: r.startedAt, finishedAt: r.finishedAt, verdict: value.verdict || 'pending',
      execution: value.execution || (ACTIVE.has(r.status) ? 'running' : 'unknown'), cleanup: value.cleanup || 'pending',
      sandboxEnforcement: r.sandboxEnforcement };
  }

  async historical(env, runId) {
    if (!RUN_ID.test(runId || '')) throw new Error('Invalid runId.');
    const root = await env.fs.resolve(join(env.repoRoot, '.playtest', 'runs'));
    const file = await env.fs.resolve(join(env.repoRoot, '.playtest', 'runs', runId, 'result.json'));
    if (!env.fs.contains(env.target, root) || !env.fs.contains(root, file)) throw new Error('Run artifact escapes repository.');
    const info = await env.fs.stat(file);
    if (!info) {
      const events = await env.fs.resolve(join(env.repoRoot, '.playtest', 'runs', runId, 'events.jsonl'));
      if (!env.fs.contains(root, events)) throw new Error('Run events escape repository.');
      const bytes = await env.fs.readByteRange(events, { offset: 0, length: 8192 });
      const first = JSON.parse(Buffer.from(bytes).toString('utf8').split('\n')[0]);
      if (first.ownerSessionId !== env.agent.id) throw new Error('This incomplete run is not owned by this session.');
      return { ok: false, runId, ownerSessionId: first.ownerSessionId, status: 'interrupted',
        startedAt: first.time, verdict: 'inconclusive', execution: 'interrupted', cleanup: 'unknown',
        steps: [], error: 'No final result was recorded. Cleanup cannot be assumed complete.' };
    }
    if (info.size > 2 * LIMIT) throw new Error('Run result is too large; inspect its artifact manually.');
    const result = JSON.parse(await env.fs.readText(file));
    if (result.ownerSessionId !== env.agent.id) throw new Error('This run belongs to another session or was created outside DSH.');
    return result;
  }

  async read(env, args) {
    const record = this.runs.get(args.runId);
    if (record) {
      if (record.ownerSessionId !== env.agent.id || record.repoRoot !== env.repoRoot) throw new Error('Run is not owned by this session/repository.');
      const after = Number.isInteger(args.after) && args.after >= 0 ? args.after : 0;
      const next = Math.max(after, record.count - 100);
      return { ok: true, ...this.summary(record), steps: record.result?.steps || record.steps,
        events: record.events.filter(e => e.offset > next), nextOffset: record.count,
        truncated: next > after, result: record.result, artifacts: join(env.repoRoot, '.playtest', 'runs', record.runId) };
    }
    const result = await this.historical(env, args.runId);
    return { ok: true, runId: args.runId, status: result.status, verdict: result.verdict,
      execution: result.execution, cleanup: result.cleanup, steps: result.steps || [], result,
      events: [], nextOffset: 0, historical: true, artifacts: join(env.repoRoot, '.playtest', 'runs', args.runId) };
  }

  async listRuns(env) {
    const summaries = [...this.runs.values()].filter(r => r.repoRoot === env.repoRoot && r.ownerSessionId === env.agent.id).map(r => this.summary(r));
    const root = await env.fs.resolve(join(env.repoRoot, '.playtest', 'runs'));
    if (env.fs.contains(env.target, root) && (await env.fs.stat(root))?.type === 'directory') {
      for (const entry of (await env.fs.listDir(root)).slice(-50)) {
        if (entry.type !== 'directory' || summaries.some(r => r.runId === entry.name)) continue;
        try {
          const result = await this.historical(env, entry.name);
          summaries.push({ runId: entry.name, repoRoot: env.repoRoot, status: result.status,
            verdict: result.verdict, execution: result.execution, cleanup: result.cleanup,
            startedAt: result.startedAt, finishedAt: result.finishedAt });
        } catch { /* unrelated session or incomplete records are not advertised as successful */ }
      }
    }
    return { ok: true, repoRoot: env.repoRoot, runs: summaries.sort((a,b) => (b.startedAt || '').localeCompare(a.startedAt || '')).slice(0,50) };
  }

  async cancel(env, args) {
    const record = this.runs.get(args.runId);
    if (!record || record.ownerSessionId !== env.agent.id || record.repoRoot !== env.repoRoot) throw new Error('No owned active run found.');
    if (!ACTIVE.has(record.status)) return { ok: true, ...this.summary(record) };
    record.status = 'cancelling';
    record.handle.terminate();
    return { ok: true, runId: record.runId, status: 'cancelling', hint: 'Cleanup is attempted; read the final cleanup result.' };
  }

  async perform(agent, args, { caller = 'agent', signal, callId } = {}) {
    try {
      const env = await this.environment(agent, args, signal);
      const result = await (() => { switch (args.action) {
        case 'catalog': {
          const value = this.invoke(env, { action: 'catalog' });
          return value.then(item => ({ ...item, demoRepo: env.fs.processPathFromHostPath(join(HERE, 'examples', 'demo-project')) }));
        }
        case 'inspect': return this.preview(env, args);
        case 'lint': return this.invoke(env, { action: 'lint', play: args.play, plays: args.plays });
        case 'scaffold': this.checkWrite(env); return this.invoke(env, { action: 'scaffold', name: args.name });
        case 'start': {
          let selected = args;
          return (async () => {
            if (Array.isArray(args.plays) && args.plays.length === 0) {
              const catalog = await this.invoke(env, { action: 'catalog' });
              if (!catalog.ok) return catalog;
              const plays = (catalog.plays || []).map(item => item.slug);
              if (!plays.length) throw new Error('No plays found; an empty suite is not a passing test.');
              selected = { ...args, plays };
            }
            return this.start(env, selected, caller, callId);
          })();
        }
        case 'read': return this.read(env, args);
        case 'runs': return this.listRuns(env);
        case 'cancel': return this.cancel(env, args);
        default: throw new Error('Unknown Playtest operation.');
      } })();
      return lossless(result);
    } catch (e) { return fail(errorText(e)); }
  }

  async dispose() {
    this.closed = true;
    const active = [...this.runs.values()].filter(r => ACTIVE.has(r.status));
    for (const r of active) r.handle?.terminate();
    await Promise.allSettled(active.map(r => r.done));
  }
}
