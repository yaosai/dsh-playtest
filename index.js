import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PlaytestOperations } from './host.js';

export const name = 'dsh-playtest';
export const inject = ['tools', 'skills', 'commands', 'workingDirectory', 'sandboxPolicy'];

const text = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
const description = text.match(/^description:\s*(.+)$/m)?.[1] || 'Business tests with explicit expectations and observable execution.';
const content = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
const repo = { type: 'string', description: '仓库根目录；省略使用当前会话目录。' };
const play = { type: 'string', description: '`.test-plays` 下剧本目录名，或仓库内剧本路径。' };
const scenario = { type: 'string', description: '剧本目录内场景文件；省略使用 scenario.json。' };
const target = { type: 'string', description: '.test-plays/config.json 中的目标名称；省略使用场景或剧本目标。' };

function compact(value) {
  if (!value.ok) return `❌ ${value.error || '操作失败'}\n${JSON.stringify(value.issues || [], null, 2)}`;
  if (value.runId && value.status === 'running' && !Array.isArray(value.steps)) return `▶ 测试已开始：${value.runId}\n仓库：${value.repoRoot}\n使用 playtest(action="read", runId="${value.runId}") 查看步骤与结果；cancel 可停止。`;
  if (Array.isArray(value.steps)) {
    const summary = [`运行 ${value.runId}：${value.status}`, `断言：${value.verdict}；执行：${value.execution}；清理：${value.cleanup}`];
    for (const s of value.steps.slice(-50)) summary.push(`${s.status === 'passed' ? '✅' : s.status === 'failed' ? '❌' : '◦'} [${s.phase || 'play'}] ${s.stepNo} ${s.name} — ${s.status}${s.error ? ': ' + s.error : ''}`);
    const details = JSON.stringify({ events: value.events, result: value.result }, null, 2);
    summary.push(details.length > 18000 ? details.slice(0,18000) + '\n[已截断；分段 read 或查看运行资产]' : details);
    return summary.join('\n');
  }
  const output = JSON.stringify(value, null, 2);
  return output.length > 22000 ? output.slice(0,22000) + '\n[输出已截断]' : output;
}

export function apply(ctx, config = {}) {
  if (config.pythonPath !== undefined && typeof config.pythonPath !== 'string') throw new Error('pythonPath must be a string.');
  if (config.repoRoot !== undefined && typeof config.repoRoot !== 'string') throw new Error('repoRoot must be a string.');
  const ops = new PlaytestOperations(ctx, config);
  ctx.effect(() => () => ops.dispose(), 'Playtest managed test processes');
  ctx.effect(() => ctx.provide('playtest', ops), 'Playtest shared operations');
  ctx.skills.register({ name: 'playtest', description, content, source: 'runtime',
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('.', import.meta.url)) } });

  const define = (toolName, toolDescription, properties, required, convert) => ctx.tools.register({
    name: toolName, description: toolDescription,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: compact(value) }] },
    timeoutMs: 120000,
    async execute(args, exec) {
      if (!exec.agent) return { ok: false, error: 'Playtest requires a session.' };
      return ops.perform(exec.agent, convert(args), { caller: 'agent', signal: exec.signal, callId: exec.callId });
    },
  });

  define('playtest', '发现或预览业务测试资产，查看本次会话的运行、步骤与证据，或取消运行。预览不调用被测系统。',
    { action: { type: 'string', enum: ['repos','catalog','inspect','runs','read','cancel'], description: 'repos 列出 Git 仓库；catalog 列剧本；inspect 预览；runs 历史；read 读运行；cancel 停止。' },
      repoRoot: repo, play, scenario, target,
      runId: { type: 'string', description: 'read/cancel 的运行标识。' },
      after: { type: 'integer', description: 'read 的事件游标，默认 0；返回 nextOffset。' } }, ['action'], args => args);

  define('playtest_run_play', '启动一个剧本，返回 runId；用 playtest read 观测步骤、断言与清理。真实系统调用或数据库写入按需请求用户授权，插件不自动启动应用。',
    { repoRoot: repo, play, scenario, target,
      expectedDigest: { type: 'string', description: '可选的预览摘要；资产改变则拒绝播放。' },
      skipCleanup: { type: 'boolean', description: '保留场景终态；mock 仍关闭。默认 false。' } }, ['play'], args => ({ ...args, action: 'start' }));

  define('playtest_run_suite', '顺序播放选定剧本并收集一个运行的步骤与结果；返回 runId。共享仓库不并发造数。',
    { repoRoot: repo,
      only: { type: 'string', description: '逗号分隔剧本目录名；省略播放全部。' },
      target, skipRestore: { type: 'boolean', description: '保留场景终态，等价 skipCleanup；默认 false。' } }, [],
    args => ({ action: 'start', repoRoot: args.repoRoot, plays: args.only ? args.only.split(',').map(s=>s.trim()).filter(Boolean) : [], target: args.target, skipCleanup: args.skipRestore === true }));

  define('playtest_lint', '校验剧本、场景、变量、目标与断言结构；不执行测试。不代表业务规则已被确认。',
    { repoRoot: repo, only: { type: 'string', description: '逗号分隔剧本目录名；省略检查全部。' } }, [],
    args => ({ action: 'lint', repoRoot: args.repoRoot, plays: args.only ? args.only.split(',').map(s=>s.trim()).filter(Boolean) : undefined }));

  define('playtest_new_play', '在仓库 `.test-plays/` 下新建剧本；已存在则拒绝，绝不覆盖资产。',
    { repoRoot: repo, name: { type: 'string', description: '新剧本目录名，kebab-case。' },
      title: { type: 'string', description: '剧本标题：一句能读懂的业务目标（界面显示它）。省略时用 name；真实验证应写清楚。' },
      target: { type: 'string', description: '`.test-plays/config.json` 里已声明的目标名；省略则不绑定目标，不能调用真实服务。' },
      description: { type: 'string', description: '要验证什么，以及依据（需求/契约/已确认案例）；不填则留空待补。' },
      example: { type: 'boolean', description: 'true=生成自带本地 HTTP mock 的可播放示例（不碰外部系统）；默认 false，生成不含步骤的业务骨架，由你按当前系统补齐。' } },
    ['name'], args => ({ ...args, action: args.example === true ? 'scaffold' : 'create' }));

  define('playtest_save_play', '把一次已记录的播放沉淀成新剧本：步骤复制，未断言的字段写入观察到的值并标注来源；不覆盖已有剧本。',
    { repoRoot: repo, runId: { type: 'string', description: '要沉淀的运行标识。' },
      name: { type: 'string', description: '新剧本目录名，kebab-case。' },
      play: { type: 'string', description: '该运行包含多个剧本时，指定沉淀哪一个。' },
      title: { type: 'string', description: '新剧本标题；省略沿用原剧本名。' } }, ['runId', 'name'],
    args => ({ ...args, action: 'draft' }));

  ctx.commands.register({ name: 'playtest', description: '业务测试：查看资产、播放与观察结果。',
    input: { hint: 'JSON operation, e.g. {"action":"catalog"}' }, recordInput: false,
    async handler(invocation) {
      try {
        const raw = invocation.rawInput.trim().replace(/^\/?playtest\s+/, '');
        const args = JSON.parse(raw || '{"action":"catalog"}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Operation must be a JSON object.');
        const result = await ops.perform(invocation.agent, args, { caller: 'user', signal: invocation.signal });
        return result.ok || Array.isArray(result.issues)
          ? { kind: 'success', text: JSON.stringify(result) }
          : { kind: 'error', text: result.error || 'Playtest operation failed.' };
      } catch (e) { return { kind: 'error', text: e.message }; }
    },
  });
}
