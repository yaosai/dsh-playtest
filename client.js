/* Native Playtest conversation view. No LLM calls, private RPC routes, or embedded pages.
 * Commands bridge verified against dsh-commands/lib/typert.remote-client.js and
 * dsh-api-gateway/README.md: root commands.execute(sessionId, line, [], signal)
 * returns RemoteResult<CommandExecution>, whose result.text contains our JSON.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-playtest',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'playtest-ui';
    const ACTIVE = new Set(['running', 'starting', 'preparing', 'queued', 'cancelling', 'cleaning', 'cleanup']);
    const EVENT_LIMIT = 400;
    const en = {
      title: 'Business tests', subtitle: 'Preview the workflow and effects, then follow the actual test results.',
      repo: 'Repository', repoHint: 'Leave blank to use this session’s working directory.',
      load: 'Load tests', refresh: 'Refresh', demo: 'Open isolated examples', resolvedRepo: 'Current repository',
      search: 'Search tests', searchHint: 'Name, description or slug', catalog: 'Test catalog',
      noTests: 'No tests found. Choose a repository containing test-plays, or open the isolated examples.',
      noMatches: 'No tests match this search.', selected: '{count} selected', selectAll: 'Select visible tests',
      clearSelection: 'Clear selection', preview: 'Preview selected', validate: 'Validate selected',
      validation: 'Validation results', target: 'Target name (optional)', scenario: 'Scenario file (optional)',
      targetHint: 'Configured target or the play’s default', scenarioHint: 'Leave blank to use each play’s default',
      readyHint: 'Select tests and preview them before starting a run.', digest: 'Reviewed snapshot',
      previewTitle: 'Execution preview', previewOnly: 'Preview does not call APIs or prepare data.',
      workflow: 'Workflow steps', setup: 'Scenario preparation', cleanup: 'Cleanup', mocks: 'Mock dependencies',
      effects: 'Expected effects', noEffects: 'No external effects requiring confirmation were reported.',
      basis: 'Claims and basis', noClaims: 'No claims recorded. Observations alone do not prove business acceptance.',
      inspectDetails: 'Full preview', assertions: 'Assertions', mode: 'Test purpose',
      'mode.explore': 'Explore', 'mode.baseline': 'Behavior baseline', 'mode.acceptance': 'Acceptance',
      confirm: 'I have reviewed and confirm the effects listed in this snapshot.',
      confirmHint: 'Confirmation is for this test only; it does not increase session permissions.',
      start: 'Start test', stale: 'Selection or environment changed. Preview again before running.',
      activeHint: 'A test is active in this repository. Wait for it or cancel it before starting another.',
      runs: 'Run history', noRuns: 'No runs recorded for this session and repository.',
      run: 'Run', cancel: 'Cancel test', cancelling: 'Cancellation requested; cleanup may still be running.',
      reloadRun: 'Refresh run', verdict: 'Assertion verdict', execution: 'Execution', cleanupResult: 'Cleanup',
      timeline: 'Timeline and evidence', noEvents: 'No test events received yet.',
      omitted: 'Earlier events are not shown. The run artifacts retain the complete recorded timeline.',
      evidence: 'Evidence / details', outcome: 'Recorded result', artifacts: 'Run artifacts',
      phase: 'Phase', step: 'Step', type: 'Action', expected: 'Expected', actual: 'Actual',
      noSteps: 'No steps in this phase.', noAssertions: 'No assertion records available yet.',
      status: 'Status', unknown: 'Unknown', empty: 'None', busy: 'Working…',
      unavailable: 'This view needs an active session.', commandMissing: 'The /playtest command is not available.',
      remoteUnavailable: 'The commands bridge is unavailable. Reconnect the Harness page and retry.',
      invalidResponse: 'The Playtest command returned an invalid response.',
      error: 'Operation failed', dismiss: 'Dismiss message', skipped: 'Skipped',
      'state.running': 'Running', 'state.starting': 'Starting', 'state.preparing': 'Preparing',
      'state.queued': 'Queued', 'state.cancelling': 'Cancelling', 'state.cleaning': 'Cleaning up',
      'state.cleanup': 'Cleaning up', 'state.passed': 'Passed', 'state.pass': 'Passed',
      'state.failed': 'Failed', 'state.fail': 'Failed', 'state.completed': 'Completed',
      'state.finished': 'Finished', 'state.cancelled': 'Cancelled', 'state.canceled': 'Cancelled',
      'state.interrupted': 'Interrupted', 'state.observed': 'Observed', 'state.inconclusive': 'Inconclusive',
      'state.unknown': 'Unknown', 'state.skipped': 'Skipped', 'state.not_required': 'Not required',
      'state.not_needed': 'Not needed', 'state.ok': 'Completed', 'state.error': 'Error',
      'state.pending': 'Pending', 'state.blocked': 'Blocked',
      'event.run_started': 'Run started', 'event.run_finished': 'Run finished',
      'event.step_started': 'Step started', 'event.step_finished': 'Step finished',
      'event.assertion': 'Assertion', 'event.assertion_result': 'Assertion result',
      'event.mock_started': 'Mock started', 'event.mock_stopped': 'Mock stopped',
      'event.mock_request': 'Mock request', 'event.cleanup_started': 'Cleanup started',
      'event.cleanup_finished': 'Cleanup finished', 'event.evidence': 'Evidence',
      'event.setup_started': 'Setup started', 'event.setup_finished': 'Setup finished'
    };
    const zh = {
      title: '业务测试', subtitle: '先预览流程与影响，再观察真实的逐步测试结果。',
      repo: '仓库', repoHint: '留空使用当前会话的工作目录。', load: '加载剧本', refresh: '刷新',
      demo: '打开隔离示例', resolvedRepo: '当前仓库', search: '搜索剧本', searchHint: '名称、描述或目录名',
      catalog: '剧本目录', noTests: '未发现剧本。请选择包含 test-plays 的仓库，或打开隔离示例。',
      noMatches: '没有匹配的剧本。', selected: '已选 {count} 个', selectAll: '选中当前搜索结果',
      clearSelection: '清空选择', preview: '预览所选', validate: '校验所选', validation: '结构校验结果',
      target: '目标名称（可选）', scenario: '场景文件（可选）', targetHint: '使用配置中的目标或剧本默认值',
      scenarioHint: '留空使用各剧本的默认场景', readyHint: '选择剧本并预览后，才能开始播放。',
      digest: '已审阅快照', previewTitle: '执行预览', previewOnly: '预览不会调用接口或执行造数。',
      workflow: '流程步骤', setup: '场景准备', cleanup: '清理步骤', mocks: 'Mock 依赖',
      effects: '预期影响', noEffects: '未报告需要确认的外部影响。', basis: '验证主张与依据',
      noClaims: '未记录验证主张。仅观察到行为，不代表已通过业务验收。', inspectDetails: '完整预览',
      assertions: '断言', mode: '测试目的', 'mode.explore': '探索', 'mode.baseline': '行为基线',
      'mode.acceptance': '验收', confirm: '我已审阅并确认当前快照列出的影响。',
      confirmHint: '确认只用于本次测试，不会扩大当前会话权限。', start: '开始播放',
      stale: '选择或环境已变化，请重新预览再播放。',
      activeHint: '当前仓库有测试正在运行，请等待完成或取消后再开始另一轮。',
      runs: '运行历史', noRuns: '当前会话与仓库尚无运行记录。', run: '运行', cancel: '取消测试',
      cancelling: '已请求取消，清理可能仍在进行。', reloadRun: '刷新运行', verdict: '断言结论',
      execution: '执行情况', cleanupResult: '清理情况', timeline: '时间线与证据', noEvents: '尚未收到测试事件。',
      omitted: '部分较早事件未显示；运行资产保留完整的已记录时间线。', evidence: '证据／详情',
      outcome: '记录结果', artifacts: '运行资产', phase: '阶段', step: '步骤', type: '动作',
      expected: '预期', actual: '实际', noSteps: '此阶段没有步骤。', noAssertions: '暂无断言记录。',
      status: '状态', unknown: '未知', empty: '无', busy: '处理中…', unavailable: '此视图需要一个有效会话。',
      commandMissing: '/playtest 命令尚未注册。', remoteUnavailable: '命令桥接不可用，请重新连接 Harness 页面后重试。',
      invalidResponse: 'Playtest 命令返回了无效响应。', error: '操作失败', dismiss: '关闭提示', skipped: '已跳过',
      'state.running': '运行中', 'state.starting': '启动中', 'state.preparing': '准备中', 'state.queued': '排队中',
      'state.cancelling': '取消中', 'state.cleaning': '清理中', 'state.cleanup': '清理中',
      'state.passed': '通过', 'state.pass': '通过', 'state.failed': '失败', 'state.fail': '失败',
      'state.completed': '完成', 'state.finished': '完成', 'state.cancelled': '已取消', 'state.canceled': '已取消',
      'state.interrupted': '已中断', 'state.observed': '已观察', 'state.inconclusive': '证据不足',
      'state.unknown': '未知', 'state.skipped': '已跳过', 'state.not_required': '无需执行',
      'state.not_needed': '无需执行', 'state.ok': '完成', 'state.error': '错误', 'state.pending': '待执行',
      'state.blocked': '受阻', 'event.run_started': '运行开始', 'event.run_finished': '运行结束',
      'event.step_started': '步骤开始', 'event.step_finished': '步骤结束', 'event.assertion': '断言',
      'event.assertion_result': '断言结果', 'event.mock_started': 'Mock 启动', 'event.mock_stopped': 'Mock 关闭',
      'event.mock_request': 'Mock 请求', 'event.cleanup_started': '清理开始', 'event.cleanup_finished': '清理结束',
      'event.evidence': '证据', 'event.setup_started': '场景准备开始', 'event.setup_finished': '场景准备结束'
    };

    const css = `
.pt-view{box-sizing:border-box;min-width:0;width:100%;padding:20px 24px 32px;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.5}
.pt-view *{box-sizing:border-box}.pt-view h2,.pt-view h3{margin:0;font-weight:600}.pt-view h2{font-size:19px}.pt-view h3{font-size:14px}
.pt-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.pt-header{margin-bottom:16px}.pt-header p{margin:4px 0 0}
.pt-toolbar,.pt-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pt-toolbar{margin:12px 0}.pt-field{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}.pt-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.pt-input,.pt-button{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-height:36px;background:transparent;padding:7px 10px}.pt-input{min-width:0;width:100%}.pt-button{cursor:pointer;white-space:nowrap}
.pt-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.pt-button:disabled{opacity:.45;cursor:default}.pt-button.pt-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.pt-view :is(button,input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.pt-button.pt-small{min-height:30px;padding:3px 8px;font-size:12px}
.pt-grid{display:grid;grid-template-columns:minmax(200px,270px) minmax(0,1fr);gap:16px;align-items:start}.pt-column{min-width:0}.pt-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;min-width:0;margin-bottom:12px}
.pt-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.pt-list{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto}.pt-choice{display:flex;align-items:flex-start;gap:8px;border:1px solid transparent;border-radius:8px;padding:8px;min-width:0}.pt-choice[data-selected=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.pt-choice input{margin:5px 0 0;accent-color:var(--dsw-alias-brand-primary)}.pt-choice-body{flex:1;min-width:0}.pt-choice-name{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left;padding:0;width:100%;font-weight:500;overflow-wrap:anywhere}.pt-choice-name:hover{text-decoration:underline}.pt-choice p{margin:3px 0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.pt-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;font-size:11px;overflow-wrap:anywhere}.pt-badge[data-tone=good]{color:var(--dsw-alias-state-success-primary)}.pt-badge[data-tone=bad]{color:var(--dsw-alias-state-error-primary);font-weight:600}
.pt-empty{margin:10px 0;color:var(--dsw-alias-label-secondary);font-size:13px}.pt-notice{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;padding:10px 12px;margin:10px 0;overflow-wrap:anywhere}.pt-notice p{margin:0}.pt-notice strong{margin-right:6px}
.pt-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}.pt-preview-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.pt-table-wrap{overflow:auto;margin:8px 0}.pt-table{border-collapse:collapse;width:100%;font-size:12px;text-align:left}.pt-table th{color:var(--dsw-alias-label-secondary);font-weight:500}.pt-table td,.pt-table th{padding:7px 6px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top;overflow-wrap:anywhere}.pt-table td:first-child{white-space:nowrap;width:48px}
.pt-code{margin:8px 0;padding:10px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.pt-view details{margin:8px 0}.pt-view summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.pt-confirm{display:flex;align-items:flex-start;gap:8px;margin:12px 0;font-size:13px}.pt-confirm input{margin-top:4px;accent-color:var(--dsw-alias-brand-primary)}.pt-confirm small{display:block;margin-top:4px;color:var(--dsw-alias-label-secondary)}
.pt-status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.pt-status-grid dt{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}.pt-status-grid dd{margin:0;overflow-wrap:anywhere}.pt-run-list{max-height:240px;overflow:auto}.pt-run-button{display:block;width:100%;border:1px solid transparent;border-radius:8px;background:transparent;text-align:left;color:inherit;font:inherit;padding:8px;cursor:pointer}.pt-run-button:hover,.pt-run-button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2)}.pt-run-button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary)}.pt-run-button>span{display:block;font-size:12px;overflow-wrap:anywhere}
.pt-timeline{list-style:none;margin:10px 0;padding:0}.pt-timeline>li{border-left:2px solid var(--dsw-alias-border-l2);padding:0 0 12px 12px;margin-left:4px;min-width:0}.pt-event-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}.pt-event-head time{color:var(--dsw-alias-label-secondary)}.pt-event-name{font-size:13px;margin:3px 0;overflow-wrap:anywhere}.pt-claim{border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;margin:10px 0}.pt-claim p{margin:4px 0;overflow-wrap:anywhere}.pt-artifacts{font-size:12px;overflow-wrap:anywhere}
@media(max-width:820px){.pt-view{padding:16px}.pt-grid{grid-template-columns:1fr}.pt-list{max-height:260px}.pt-options{grid-template-columns:1fr}.pt-status-grid{grid-template-columns:1fr}.pt-toolbar>.pt-field{flex-basis:100%}}
@media(pointer:coarse){.pt-input{font-size:16px}.pt-button{min-height:40px}}
`;

    function asText(value) {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
    }
    function bounded(value) {
      const text = asText(value);
      return text.length > 20000 ? text.slice(0, 20000) + '\n…' : text;
    }
    function stateOf(value) {
      return typeof value === 'string' ? value : value && (value.status || value.verdict || value.state) || 'unknown';
    }
    function translatedState(value, t) {
      const state = stateOf(value);
      const translated = t('state.' + state);
      return translated === 'state.' + state ? state : translated;
    }
    function toneOf(value) {
      const state = stateOf(value);
      return ['passed', 'pass', 'ok', 'completed'].includes(state) ? 'good'
        : ['failed', 'fail', 'error'].includes(state) ? 'bad' : 'neutral';
    }
    function glyph(value) {
      const tone = toneOf(value);
      return tone === 'good' ? '✓' : tone === 'bad' ? '!' : ACTIVE.has(stateOf(value)) ? '◉' : '○';
    }
    function Badge({ value, t }) {
      return h('span', { className: 'pt-badge', 'data-tone': toneOf(value) },
        h('span', { 'aria-hidden': true }, glyph(value)), translatedState(value, t));
    }
    function JsonDetails({ title, value, open }) {
      if (value == null) return null;
      return h('details', { open: open || undefined }, h('summary', null, title),
        h('pre', { className: 'pt-code' }, bounded(value)));
    }
    function StepTable({ steps, t, results }) {
      if (!Array.isArray(steps) || !steps.length) return h('p', { className: 'pt-empty' }, t('noSteps'));
      return h('div', { className: 'pt-table-wrap' }, h('table', { className: 'pt-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('step')),
          h('th', { scope: 'col' }, t('workflow')), h('th', { scope: 'col' }, t('type')),
          h('th', { scope: 'col' }, t(results ? 'status' : 'assertions')))),
        h('tbody', null, steps.map((step, index) => h('tr', { key: [step.phase, step.play, step.stepNo, index].join(':') },
          h('td', null, step.stepNo == null ? index + 1 : step.stepNo),
          h('td', null, step.name || step.description || t('unknown'),
            step.phase ? h('div', { className: 'pt-muted' }, asText(step.phase)) : null,
            results ? h(JsonDetails, { title: t('evidence'), value: step }) : null),
          h('td', null, step.type || 'http'),
          h('td', null, results ? h(Badge, { value: step.status || step.verdict || (step.ok === true ? 'passed' : step.ok === false ? 'failed' : 'observed'), t })
            : Array.isArray(step.assertions) ? step.assertions.length : step.assertions || 0))))));
    }
    function mergeEvents(old, incoming) {
      const map = new Map(old.map((event, index) => [event.seq == null ? 'old:' + index : event.seq, event]));
      incoming.forEach((event, index) => map.set(event.seq == null ? 'new:' + old.length + ':' + index : event.seq, event));
      return [...map.values()].slice(-EVENT_LIMIT);
    }

    // Captures the root Remote face. A session-scoped Remote face intentionally
    // omits the explicit session argument; mixing those two faces causes arity errors.
    function createRequest(remote, t) {
      return async function request(sessionId, payload, signal) {
        if (!sessionId) throw new Error(t('unavailable'));
        if (!remote.commands || typeof remote.commands.execute !== 'function') throw new Error(t('remoteUnavailable'));
        const response = await remote.commands.execute(sessionId, '/playtest ' + JSON.stringify(payload), [], signal);
        if (!response || response.ok !== true) {
          const err = response && response.error;
          throw new Error(err && (err.message || asText(err)) || t('remoteUnavailable'));
        }
        const execution = response.value;
        if (!execution) throw new Error(t('commandMissing'));
        if (!execution.result || execution.result.kind !== 'success') {
          throw new Error(execution.result && execution.result.text || t('invalidResponse'));
        }
        let data;
        try { data = JSON.parse(execution.result.text); } catch (_) { throw new Error(t('invalidResponse')); }
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') {
          throw new Error(t('invalidResponse'));
        }
        if (!data.ok && !Array.isArray(data.issues)) throw new Error(asText(data.error || data.message) || t('error'));
        return data;
      };
    }

    function Workbench({ sessionId, request, t }) {
      const [repo, setRepo] = React.useState('');
      const [catalog, setCatalog] = React.useState(null);
      const [search, setSearch] = React.useState('');
      const [selected, setSelected] = React.useState([]);
      const [scenario, setScenario] = React.useState('');
      const [target, setTarget] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [confirmed, setConfirmed] = React.useState(false);
      const [validation, setValidation] = React.useState(null);
      const [runs, setRuns] = React.useState([]);
      const [runId, setRunId] = React.useState('');
      const [runData, setRunData] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState(null);
      const mounted = React.useRef(true);
      const pending = React.useRef(new Set());
      const epoch = React.useRef(0);
      const cursor = React.useRef(0);
      const operationGate = React.useRef(false);
      const readRevision = React.useRef(0);
      const repoRef = React.useRef(repo);
      repoRef.current = repo;
      const selectionKey = JSON.stringify([repo.trim(), selected, scenario.trim(), target.trim()]);
      const plays = catalog && Array.isArray(catalog.plays) ? catalog.plays : [];
      const filtered = plays.filter(play => [play.slug, play.name, play.description].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
      const activeRuns = runs.filter(run => ACTIVE.has(stateOf(run.status)));
      const activeSelected = runData && ACTIVE.has(stateOf(runData.status));
      const validPreview = preview && preview.key === selectionKey && preview.data.ok && typeof preview.data.digest === 'string';
      const needsConfirmation = validPreview && preview.data.requiresConfirmation === true;
      const hasIssues = validPreview && (preview.data.issues || []).some(issue => ['error', 'ERROR'].includes(issue.level || issue.severity));
      const canStart = validPreview && !hasIssues && (!needsConfirmation || confirmed) && !busy && !activeRuns.length;

      const call = React.useCallback(async (action, payload, externalController) => {
        const controller = externalController || new AbortController();
        pending.current.add(controller);
        try { return await request(sessionId, { ...payload, action }, controller.signal); }
        finally { pending.current.delete(controller); }
      }, [request, sessionId]);
      const options = (overrideRepo) => {
        const value = overrideRepo === undefined ? repo.trim() : overrideRepo.trim();
        return {
          ...(value ? { repoRoot: value } : {}),
          ...(scenario.trim() ? { scenario: scenario.trim() } : {}),
          ...(target.trim() ? { target: target.trim() } : {})
        };
      };
      const perform = async (kind, operation) => {
        if (!mounted.current || operationGate.current) return;
        operationGate.current = true;
        setBusy(kind);
        setMessage(null);
        try { await operation(); }
        catch (error) { if (mounted.current) setMessage({ error: true, text: error.message || String(error) }); }
        finally { operationGate.current = false; if (mounted.current) setBusy(''); }
      };
      const refreshRuns = async (opts, controller) => {
        const data = await call('runs', opts, controller);
        if (mounted.current && !controller?.signal.aborted && (opts.repoRoot || '') === repoRef.current.trim()) {
          setRuns(Array.isArray(data.runs) ? data.runs : []);
        }
        return data;
      };
      const readRun = async (id, after, opts, controller, reset) => {
        const revision = ++readRevision.current;
        const data = await call('read', { ...opts, runId: id, after, limit: 100 }, controller);
        if (!mounted.current || controller?.signal.aborted || id !== currentRun.current || revision !== readRevision.current) return data;
        cursor.current = Number.isFinite(data.nextOffset) ? data.nextOffset : after;
        setRunData(old => ({
          ...data,
          events: mergeEvents(reset ? [] : old && old.events || [], Array.isArray(data.events) ? data.events : []),
          truncated: data.truncated === true || (!reset && old && old.truncated === true)
            || ((old && old.events || []).length + (data.events || []).length > EVENT_LIMIT)
        }));
        setRuns(old => old.map(run => run.runId === id ? { ...run, status: data.status, verdict: data.verdict, execution: data.execution, cleanup: data.cleanup } : run));
        return data;
      };
      const currentRun = React.useRef('');
      const loadCatalog = async (overrideRepo) => {
        const version = ++epoch.current;
        setPreview(null); setConfirmed(false); setValidation(null);
        const opts = options(overrideRepo);
        const data = await call('catalog', opts);
        if (!mounted.current || version !== epoch.current) return;
        setCatalog(data);
        setSelected(old => old.filter(slug => (data.plays || []).some(play => play.slug === slug)));
        await refreshRuns(opts);
      };
      const inspect = async (chosen) => {
        const list = chosen || selected;
        if (!list.length) return;
        const version = ++epoch.current;
        const key = JSON.stringify([repo.trim(), list, scenario.trim(), target.trim()]);
        setPreview(null); setConfirmed(false); setValidation(null);
        const data = await call('inspect', { ...options(), plays: list });
        if (mounted.current && version === epoch.current) setPreview({ key, data });
      };
      const chooseRun = async id => {
        currentRun.current = id; cursor.current = 0;
        setRunId(id); setRunData(null);
        await readRun(id, 0, options(), undefined, true);
      };
      const start = async () => {
        if (!canStart) return;
        // Authority is sourced only from this checkbox's human onChange handler
        // and this button's human click, never from a catalog result or an agent tool.
        const digest = preview.data.digest;
        const data = await call('start', {
          ...options(), plays: selected, expectedDigest: digest,
          userConfirmedEffects: needsConfirmation === true && confirmed === true
        });
        setConfirmed(false);
        if (!mounted.current) return;
        setRuns(old => [{ runId: data.runId, status: data.status || 'running', artifacts: data.artifacts }, ...old.filter(run => run.runId !== data.runId)]);
        await chooseRun(data.runId);
      };
      const invalidate = () => {
        epoch.current += 1; setPreview(null); setConfirmed(false); setValidation(null);
      };

      React.useEffect(() => {
        mounted.current = true;
        perform('catalog', () => loadCatalog());
        return () => {
          mounted.current = false; epoch.current += 1;
          for (const controller of pending.current) controller.abort();
          pending.current.clear();
        };
      }, [call]);

      const activeKey = activeRuns.map(run => run.runId).join('|') + (activeSelected ? '|' + runId : '');
      React.useEffect(() => {
        // Poll test runs only. Never poll the model/agent status or replay an action.
        if (!activeKey) return undefined;
        const controller = new AbortController();
        let timer;
        const poll = async () => {
          try {
            if (currentRun.current && (activeSelected || activeRuns.some(run => run.runId === currentRun.current))) {
              await readRun(currentRun.current, cursor.current, options(), controller, false);
            }
            if (!controller.signal.aborted) await refreshRuns(options(), controller);
          } catch (error) {
            if (!controller.signal.aborted && mounted.current) setMessage({ error: true, text: error.message || String(error) });
          }
          if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
        };
        timer = setTimeout(poll, 2000);
        return () => { clearTimeout(timer); controller.abort(); };
      }, [activeKey, runId, repo, call]);

      const previewData = validPreview ? preview.data.preview || {} : preview && preview.data.preview || {};
      const previewPlays = Array.isArray(previewData.plays) ? previewData.plays : [];
      const effects = preview && (preview.data.effects || previewData.effects) || [];
      const recorded = runData && runData.result || {};
      const steps = runData && runData.steps || recorded.steps || [];
      const assertions = runData && runData.assertions || recorded.assertions
        || steps.flatMap(step => Array.isArray(step.assertions) ? step.assertions : []);
      const eventName = event => {
        const key = 'event.' + event.type;
        const label = t(key);
        return label === key ? event.type || t('unknown') : label;
      };
      const eventTime = event => {
        const value = event.time || event.timestamp || event.at;
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? asText(value) : date.toLocaleTimeString();
      };
      const button = (label, action, disabled, className) => h('button', {
        type: 'button', className: 'pt-button ' + (className || ''), onClick: action, disabled
      }, label);

      return h('section', { className: 'pt-view', 'aria-label': t('title'), 'aria-busy': !!busy },
        h('style', null, css),
        h('header', { className: 'pt-header' }, h('h2', null, t('title')), h('p', { className: 'pt-muted' }, t('subtitle'))),
        h('form', { className: 'pt-toolbar', onSubmit: event => { event.preventDefault(); perform('catalog', () => loadCatalog()); } },
          h('label', { className: 'pt-field' }, h('span', null, t('repo')),
            h('input', { className: 'pt-input', value: repo, disabled: !!busy, placeholder: t('repoHint'), onChange: event => {
              setRepo(event.target.value); invalidate(); setCatalog(null); setSelected([]); setRuns([]);
              currentRun.current = ''; setRunId(''); setRunData(null);
            } })),
          h('button', { className: 'pt-button', type: 'submit', disabled: !!busy }, t('load')),
          catalog && catalog.demoRepo ? button(t('demo'), () => {
            const next = catalog.demoRepo; setRepo(next); setSelected([]); setRunId(''); setRunData(null); currentRun.current = '';
            perform('catalog', () => loadCatalog(next));
          }, !!busy) : null),
        catalog && catalog.repoRoot ? h('p', { className: 'pt-muted' }, t('resolvedRepo') + ': ', catalog.repoRoot) : null,
        message ? h('div', { className: 'pt-notice', role: message.error ? 'alert' : 'status' },
          h('div', { className: 'pt-card-title' }, h('p', null, message.text),
            button(t('dismiss'), () => setMessage(null), false, 'pt-small'))) : null,
        h('div', { className: 'pt-grid' },
          h('aside', { className: 'pt-column' },
            h('section', { className: 'pt-card', 'aria-label': t('catalog') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('catalog')), h('span', { className: 'pt-muted' }, t('selected', { count: selected.length }))),
              h('input', { type: 'search', className: 'pt-input', value: search, 'aria-label': t('search'), placeholder: t('searchHint'), onChange: event => setSearch(event.target.value) }),
              h('div', { className: 'pt-toolbar' },
                button(t('selectAll'), () => { setSelected(filtered.map(play => play.slug)); invalidate(); }, !filtered.length || !!busy, 'pt-small'),
                button(t('clearSelection'), () => { setSelected([]); invalidate(); }, !selected.length || !!busy, 'pt-small')),
              h('div', { className: 'pt-list' }, filtered.length ? filtered.map(play => h('div', {
                key: play.slug, className: 'pt-choice', 'data-selected': selected.includes(play.slug)
              }, h('input', { type: 'checkbox', checked: selected.includes(play.slug), disabled: !!busy,
                'aria-label': play.name || play.slug, onChange: event => {
                  setSelected(old => event.target.checked ? [...old, play.slug] : old.filter(slug => slug !== play.slug)); invalidate();
                } }), h('div', { className: 'pt-choice-body' },
                h('button', { type: 'button', className: 'pt-choice-name', disabled: !!busy, onClick: () => {
                  setSelected([play.slug]); perform('inspect', () => inspect([play.slug]));
                } }, play.name || play.slug), h('p', null, play.description || play.slug),
                h('div', { className: 'pt-actions' }, h('span', { className: 'pt-badge' }, t('mode.' + (play.mode || 'explore'))),
                  h('span', { className: 'pt-muted' }, t('step') + ': ' + (Array.isArray(play.steps) ? play.steps.length : play.steps || 0))))))
                : h('p', { className: 'pt-empty' }, t(plays.length ? 'noMatches' : 'noTests')))),
            h('section', { className: 'pt-card', 'aria-label': t('runs') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('runs')),
                button(t('refresh'), () => perform('runs', () => refreshRuns(options())), !!busy, 'pt-small')),
              h('div', { className: 'pt-run-list' }, runs.length ? runs.map(run => h('button', {
                type: 'button', key: run.runId, className: 'pt-run-button', 'aria-pressed': run.runId === runId,
                disabled: !!busy, onClick: () => perform('read', () => chooseRun(run.runId))
              }, h('span', null, run.name || run.scenarioName || run.runId),
              h('span', { className: 'pt-muted' }, run.startedAt || run.createdAt || ''), h(Badge, { value: run.status, t })))
                : h('p', { className: 'pt-empty' }, t('noRuns'))))),
          h('div', { className: 'pt-column' },
            h('section', { className: 'pt-card', 'aria-label': t('previewTitle') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('previewTitle')), h('span', { className: 'pt-muted' }, busy ? t('busy') : t('previewOnly'))),
              h('div', { className: 'pt-options' },
                h('label', { className: 'pt-field' }, h('span', null, t('target')), h('input', { className: 'pt-input', value: target, disabled: !!busy, placeholder: t('targetHint'), onChange: event => { setTarget(event.target.value); invalidate(); } })),
                h('label', { className: 'pt-field' }, h('span', null, t('scenario')), h('input', { className: 'pt-input', value: scenario, disabled: !!busy, placeholder: t('scenarioHint'), onChange: event => { setScenario(event.target.value); invalidate(); } }))),
              h('div', { className: 'pt-actions' },
                button(t('preview'), () => perform('inspect', () => inspect()), !selected.length || !!busy),
                button(t('validate'), () => perform('lint', async () => { const data = await call('lint', { ...options(), plays: selected }); if (mounted.current) setValidation(data); }), !selected.length || !!busy)),
              validation ? h(JsonDetails, { title: t('validation'), value: validation, open: true }) : null,
              !preview ? h('p', { className: 'pt-empty' }, t('readyHint')) : null,
              preview && !validPreview ? h('p', { className: 'pt-notice' }, t('stale')) : null,
              preview ? h(React.Fragment, null,
                h('p', { className: 'pt-muted' }, t('digest') + ': ', preview.data.digest || t('unknown')),
                (preview.data.issues || []).length ? h(JsonDetails, { title: t('validation'), value: preview.data.issues, open: true }) : null,
                previewPlays.map(play => h('section', { key: play.slug, className: 'pt-card' },
                  h('div', { className: 'pt-preview-head' }, h('h3', null, play.name || play.slug), h('span', { className: 'pt-badge' }, t('mode.' + (play.mode || 'explore')))),
                  play.description ? h('p', { className: 'pt-muted' }, play.description) : null,
                  h('p', { className: 'pt-muted' }, t('target') + ': ' + (play.baseUrl || play.target || t('empty')) + ' · ' + t('scenario') + ': ' + (play.scenario || t('empty'))),
                  h('h3', null, t('workflow')), h(StepTable, { steps: play.steps, t }),
                  h('details', null, h('summary', null, t('setup')), h(StepTable, { steps: play.setup, t })),
                  h('details', null, h('summary', null, t('cleanup')), h(StepTable, { steps: play.cleanup, t })),
                  h(JsonDetails, { title: t('mocks'), value: play.mocks || [] }),
                  h('details', null, h('summary', null, t('basis')), (play.claims || []).length ? play.claims.map((claim, index) => h('div', { key: claim.id || index, className: 'pt-claim' },
                    h('p', null, claim.description || claim.id), h('pre', { className: 'pt-code' }, bounded(claim.basis))))
                    : h('p', { className: 'pt-empty' }, t('noClaims'))))),
                h('h3', null, t('effects')),
                effects.length ? h('pre', { className: 'pt-code' }, bounded(effects)) : h('p', { className: 'pt-empty' }, t('noEffects')),
                h(JsonDetails, { title: t('inspectDetails'), value: preview.data.preview || preview.data.snapshot }),
                needsConfirmation ? h('label', { className: 'pt-confirm' }, h('input', { type: 'checkbox', checked: confirmed, disabled: !!busy, onChange: event => setConfirmed(event.target.checked) }),
                  h('span', null, t('confirm'), h('small', null, t('confirmHint')))) : null,
                activeRuns.length ? h('p', { className: 'pt-muted' }, t('activeHint')) : null,
                button(t('start'), () => perform('start', start), !canStart, 'pt-primary')) : null),
            runId ? h('section', { className: 'pt-card', 'aria-label': t('run') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('run') + ' ' + runId),
                h('div', { className: 'pt-actions' },
                  button(t('reloadRun'), () => perform('read', () => readRun(runId, cursor.current, options(), undefined, false)), !!busy, 'pt-small'),
                  activeSelected ? button(t('cancel'), () => perform('cancel', async () => {
                    await call('cancel', { ...options(), runId });
                    if (mounted.current) setMessage({ error: false, text: t('cancelling') });
                    await readRun(runId, cursor.current, options(), undefined, false);
                  }), !!busy, 'pt-small') : null)),
              runData ? h(React.Fragment, null,
                h('dl', { className: 'pt-status-grid' }, [['verdict', runData.verdict], ['execution', runData.execution], ['cleanupResult', runData.cleanup]].map(([key, value]) => h('div', { key },
                  h('dt', null, t(key)), h('dd', null, h(Badge, { value, t }))))),
                h(StepTable, { steps, results: true, t }),
                h('details', null, h('summary', null, t('assertions')), assertions.length ? assertions.map((assertion, index) => h('div', { key: assertion.id || index, className: 'pt-claim' },
                  h(Badge, { value: assertion.verdict || assertion.status || (assertion.ok === true ? 'passed' : assertion.ok === false ? 'failed' : 'unknown'), t }),
                  h('pre', { className: 'pt-code' }, bounded(assertion)))) : h('p', { className: 'pt-empty' }, t('noAssertions'))),
                h('h3', null, t('timeline')),
                runData.truncated ? h('p', { className: 'pt-muted' }, t('omitted')) : null,
                (runData.events || []).length ? h('ol', { className: 'pt-timeline' }, runData.events.map((event, index) => h('li', { key: event.seq == null ? index : event.seq },
                  h('div', { className: 'pt-event-head' }, h('span', null, event.seq == null ? '' : '#' + event.seq), h('strong', null, eventName(event)), h('time', null, eventTime(event)),
                    event.status || event.verdict ? h(Badge, { value: event.status || event.verdict, t }) : null),
                  event.name || event.phase || event.stepNo != null ? h('p', { className: 'pt-event-name' }, [event.phase, event.stepNo != null ? t('step') + ' ' + event.stepNo : '', event.name].filter(Boolean).join(' · ')) : null,
                  h(JsonDetails, { title: t('evidence'), value: event })))) : h('p', { className: 'pt-empty' }, t('noEvents')),
                h(JsonDetails, { title: t('outcome'), value: runData.result }),
                h(JsonDetails, { title: t('artifacts'), value: runData.artifacts || recorded.artifacts })) : h('p', { role: 'status', className: 'pt-empty' }, t('busy'))) : null)));
    }

    function PlaytestView(props) {
      // Explicit key guarantees local state, cursors, confirmation and pending
      // requests never transfer when the conversation switches to another session.
      return h(Workbench, { ...props, key: props.sessionId });
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'playtest: client dictionaries');
        const t = ctx.locale.bind(NS);
        const request = createRequest(ctx.remote, t);
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'playtest', order: 20,
          label: () => t('title'), locale: NS,
          inject: sessionId => ({
            request: (_sessionId, payload, signal) => request(sessionId, payload, signal), sessionId
          })
        }, PlaytestView));
      }
    };
  }
});
