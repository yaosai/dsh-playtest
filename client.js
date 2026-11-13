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
      repo: 'Repository',
      refresh: 'Refresh', demo: 'Open isolated examples', resolvedRepo: 'Current repository',
      search: 'Search tests', searchHint: 'Name, description or slug', catalog: 'Test catalog',
      noTests: 'No tests found. This repository has no .test-plays directory yet.',
      noRepos: 'No Git repositories found in this workspace.',
      noMatches: 'No tests match this search.', selected: '{count} selected', selectAll: 'Select visible tests',
      clearSelection: 'Clear selection', preview: 'Preview again', previewing: 'Previewing…', validate: 'Validate selected',
      validation: 'Validation results', target: 'Target', scenario: 'Scenario',
      scenarioAuto: "Play's default scenario", scenarioIsDefault: ' (default)', targetAuto: "Play's own target",
      scenarioLockedHint: 'Several plays selected: only scenario files they all carry are honoured, otherwise each play uses its own default.',
      targetHint: 'Configured target or the play’s default', scenarioHint: 'Leave blank to use each play’s default',
      readyHint: 'Select a test and its preview appears automatically.', digest: 'Reviewed snapshot',
      previewTitle: 'Execution preview', previewOnly: 'Preview does not call APIs or prepare data.',
      workflow: 'Workflow steps', setup: 'Data preparation', cleanup: 'Cleanup', mocks: 'Mock dependencies',
      prepare: 'Scenario preparation',
      newPlay: 'New play', saveAsPlay: 'Save this run as a play',
      createTitle: 'What do you want to verify?', createExample: 'e.g. after a station goes offline it must stop accepting bills',
      createHelp: 'The directory name and target are worked out from this repository; a new agent session writes the steps and assertions from what the code actually does.',
      analyzeRun: 'Let an agent analyse this failure', noStepFailed: 'no step reported a failure, yet the verdict is not passed',
      analyzing: 'Handed this failure to a new session ({sessionId}) — it is in the same workspace list.',
      agentAnalyze: 'Use the Playtest plugin to analyse this failed run and improve the play.\n'
        + 'Repository: {repo}\nRun: {runId} (play {play}; verdict {verdict}, execution {execution}, cleanup {cleanup})\n'
        + 'Evidence directory: {runDir}\nSteps that did not pass: {failures}\n\n'
        + 'Read the evidence before concluding: use the playtest tool to read this runId, and the events.jsonl / '
        + 'result.json in the evidence directory when the summary is not enough. Never diagnose from step names.\n'
        + 'Assign exactly one cause and say what in the evidence makes you pick it: (1) the play or its assertions are '
        + 'wrong (path, field, data, timing), (2) the environment or fixtures do not meet a precondition, '
        + '(3) a real business defect.\n'
        + 'Forbidden: loosening or deleting assertions to make it pass, rewriting an expectation to the observed value, '
        + 'downgrading a failing step to "record only". If it is a business defect, do not touch the play — report the '
        + 'evidence and what you recommend.\n'
        + 'After editing, run playtest_lint and inspect, then ask the user to press play again; do not start a run that '
        + 'hits the real system yourself.',
      agentGoal: 'Use the Playtest plugin to turn the play {repo}/{path} into a playable test.\n'
        + 'What to verify: {intent}\n'
        + 'Constraints: read the code and contracts first to confirm real paths, parameters and fields — do not guess. '
        + 'Assert only what you can justify, and record the basis in claims[].basis or NOTES.md. Where the intended behaviour is not '
        + 'confirmed, keep mode: explore and write down the gap. Finish with playtest_lint and inspect; do not start a run that '
        + 'hits the real system yourself — that click belongs to the user.',
      createSubmit: 'Create', cancelForm: 'Cancel', formRequired: 'Describe what to verify first.',
      created: 'Created {slug} (target: {target}) and selected it. Ask the agent to fill in steps and assertions.',
      saved: 'Saved as {slug}: {drafted} steps carry expectations from that run. Confirm them before calling it a baseline.',
      tabWork: 'Tests & preview', tabRun: 'Run', phasePrepare: '1 · Scenario preparation (project-provided)',
      phaseSetup: '2 · Data preparation', phasePlay: '3 · Step execution', phaseCleanup: '4 · Cleanup',
      runEmpty: 'No run selected. Start a test or pick one from the run history.',
      effects: 'Expected effects', noEffects: 'No external effects were reported.',
      basis: 'Claims and basis', noClaims: 'No claims recorded. Observations alone do not prove business acceptance.',
      inspectDetails: 'Full preview', assertions: 'Assertions', mode: 'Test purpose',
      'mode.explore': 'Explore', 'mode.baseline': 'Behavior baseline', 'mode.acceptance': 'Acceptance',
      start: 'Start test', stale: 'This preview is out of date and is being refreshed.',
      activeHint: 'A test is active in this repository. Wait for it or cancel it before starting another.',
      runs: 'Run history', noRuns: 'No runs recorded for this session and repository.',
      run: 'Run', cancel: 'Cancel test', cancelling: 'Cancellation requested; cleanup may still be running.',
      reloadRun: 'Refresh run', verdict: 'Assertion verdict', execution: 'Execution', cleanupResult: 'Cleanup',
      timeline: 'Timeline and evidence', noEvents: 'No test events received yet.',
      omitted: 'Earlier events are not shown. The run artifacts retain the complete recorded timeline.',
      evidence: 'Evidence / details', outcome: 'Recorded result', artifacts: 'Run artifacts',
      phase: 'Phase', step: 'Step', type: 'Action', expected: 'Expected', actual: 'Actual',
      checks: 'Verifications', description: 'Scene notes', noDescription: 'This play has no written description.',
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
      repo: '仓库', refresh: '刷新',
      demo: '打开隔离示例', resolvedRepo: '当前仓库', search: '搜索剧本', searchHint: '名称、描述或目录名',
      catalog: '剧本目录', noTests: '该仓库下还没有 .test-plays 目录。',
      noRepos: '当前工作区未发现 Git 仓库。',
      noMatches: '没有匹配的剧本。', selected: '已选 {count} 个', selectAll: '选中当前搜索结果',
      clearSelection: '清空选择', preview: '重新预览', previewing: '正在预览…', validate: '校验所选', validation: '结构校验结果',
      target: '目标', scenario: '场景', scenarioAuto: '用剧本自己的默认场景', scenarioIsDefault: '（默认）',
      targetAuto: '用剧本自己的目标',
      scenarioLockedHint: '选了多个剧本：只有它们都有的场景文件才有效，否则各剧本用自己的默认场景。', targetHint: '使用配置中的目标或剧本默认值',
      scenarioHint: '留空使用各剧本的默认场景', readyHint: '选择剧本后会自动预览。',
      digest: '已审阅快照', previewTitle: '执行预览', previewOnly: '预览不会调用接口或执行造数。',
      workflow: '流程步骤', setup: '数据准备', cleanup: '清理步骤', mocks: 'Mock 依赖',
      prepare: '场景准备',
      newPlay: '新建剧本', saveAsPlay: '把这次运行存为剧本',
      createTitle: '你要验证什么？', createExample: '例：工作站下线后不应继续接单',
      createHelp: '目录名和目标由本仓库推出来；创建后会自动另起一个 agent 会话，由它读代码写步骤与断言——不会替你猜业务规则。',
      analyzeRun: '让 agent 分析这次失败', noStepFailed: '步骤里没有失败项，但整体结论不是通过',
      analyzing: '已把这次失败交给新会话分析（会话 {sessionId}），在同一工作区列表里可以看到。',
      agentAnalyze: '用 Playtest 分析这次失败的播放，并把剧本改对。\n'
        + '仓库：{repo}\n运行：{runId}（剧本 {play}；结论 {verdict}／执行 {execution}／清理 {cleanup}）\n'
        + '证据目录：{runDir}\n未通过的步骤：{failures}\n\n'
        + '先读证据再下结论：用 playtest 工具 read 这个 runId；摘要不够就读证据目录里的 events.jsonl 与 result.json。'
        + '不要凭步骤名猜原因。\n'
        + '只归到一类，并说明证据里是什么让你这么判：①剧本或断言写错了（路径、字段、数据、时机）②环境或夹具不满足前置条件'
        + '③真实业务缺陷。\n'
        + '禁止：为了变绿而放宽或删除断言、把预期改成实际值、把失败步骤降级成“只记录”。若是业务缺陷，不要动剧本，'
        + '报告证据与建议即可。\n'
        + '改完跑 playtest_lint 与 inspect 自查，然后请用户重新点播放——不要自己发起会打到真实系统的播放。',
      agentGoal: '用 Playtest 插件把 {repo}/{path} 补成可播放的测试。\n'
        + '要验证：{intent}\n'
        + '约束：先读代码与接口契约确认真实路径、参数和字段，不要猜；只写你能证明的断言，依据写进 claims[].basis 或 NOTES.md；'
        + '业务口径未确认时保持 mode: explore 并记下缺口；写完用 playtest_lint 与 inspect 自查；'
        + '不要自行发起会打到真实系统的播放，那一下归用户点。',
      handedOff: '已创建 {slug}，并另起会话把目标交给了 agent；新会话在同一工作区列表里。',
      handedOffFailed: '{slug} 的骨架已建好，但没能自动交给 agent（骨架没有丢）：',
      handoffUnavailable: '让 agent 说一句「把这个剧本补成可播放的测试」即可继续。',
      createSubmit: '创建', cancelForm: '取消', formRequired: '先说一句要验证什么。',
      created: '已创建 {slug}（目标：{target}）并选中。让 agent 把步骤和断言补上。',
      saved: '已沉淀为 {slug}：{drafted} 步的预期取自那次运行的实际值，确认后才能当基线。',
      tabWork: '剧本与预览', tabRun: '运行', phasePrepare: '① 场景准备（由项目提供）',
      phaseSetup: '② 数据准备', phasePlay: '③ 步骤执行', phaseCleanup: '④ 收尾清理',
      runEmpty: '尚未选择运行。开始一次播放，或在运行历史里选一条。',
      effects: '预期影响', noEffects: '未报告外部影响。', basis: '验证主张与依据',
      noClaims: '未记录验证主张。仅观察到行为，不代表已通过业务验收。', inspectDetails: '完整预览',
      assertions: '断言', mode: '测试目的', 'mode.explore': '探索', 'mode.baseline': '行为基线',
      'mode.acceptance': '验收',
      start: '开始播放',
      stale: '预览已过期，正在自动刷新。',
      activeHint: '当前仓库有测试正在运行，请等待完成或取消后再开始另一轮。',
      runs: '运行历史', noRuns: '当前会话与仓库尚无运行记录。', run: '运行', cancel: '取消测试',
      cancelling: '已请求取消，清理可能仍在进行。', reloadRun: '刷新运行', verdict: '断言结论',
      execution: '执行情况', cleanupResult: '清理情况', timeline: '时间线与证据', noEvents: '尚未收到测试事件。',
      omitted: '部分较早事件未显示；运行资产保留完整的已记录时间线。', evidence: '证据／详情',
      outcome: '记录结果', artifacts: '运行资产', phase: '阶段', step: '步骤', type: '动作',
      expected: '预期', actual: '实际', checks: '校验项', description: '场景说明',
      noDescription: '该剧本没有写说明。',
      'type.http': 'HTTP 调用', 'type.dbQuery': '数据库查询', 'type.dbWait': '等待数据库条件',
      'type.wait': '固定等待', 'type.mockVerify': '校验 Mock 交互',
      'phase.prepare': '场景准备', 'phase.setup': '数据准备', 'phase.play': '步骤执行', 'phase.cleanup': '收尾清理',
      'effect.http.external': '调用非本插件启动的服务', 'effect.database.command': '执行项目侧数据库适配器（含只读）',
      'effect.database.write': '写入 SQLite 或影响未知的 SQL',
      noSteps: '此阶段没有步骤。', noAssertions: '暂无断言记录。',
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
.pt-toolbar,.pt-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pt-actionbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);position:sticky;top:0;z-index:1}.pt-tabs{display:flex;gap:6px;margin:0 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pt-tab{font:inherit;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-bottom:2px solid transparent;padding:8px 10px;cursor:pointer;display:flex;align-items:center;gap:6px}
.pt-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.pt-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.pt-view[data-tab=run] .pt-only-work,.pt-view:not([data-tab=run]) .pt-only-run{display:none}
.pt-phase{margin-bottom:14px}
.pt-form{border-color:var(--dsw-alias-brand-primary)}
.pt-effects{list-style:none;margin:8px 0;padding:0;display:flex;flex-direction:column;gap:6px}
.pt-effects li{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:12px}
.pt-tip{position:fixed;z-index:5;max-height:min(60vh,420px);overflow:auto;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);pointer-events:none}
.pt-desc{margin:6px 0}
.pt-desc>p{margin:6px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.pt-tip strong{display:block;font-size:13px;margin-bottom:2px}
.pt-tip p{margin:6px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}.pt-toolbar{margin:12px 0}.pt-field{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}.pt-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.pt-input,.pt-button{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-height:36px;background:transparent;padding:7px 10px}.pt-input{min-width:0;width:100%}select.pt-input{background:var(--dsw-alias-bg-layer-1);cursor:pointer}.pt-button{cursor:pointer;white-space:nowrap}
.pt-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.pt-button:disabled{opacity:.45;cursor:default}.pt-button.pt-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.pt-view :is(button,input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.pt-button.pt-small{min-height:30px;padding:3px 8px;font-size:12px}
.pt-grid{display:grid;grid-template-columns:minmax(200px,270px) minmax(0,1fr);gap:16px;align-items:start}.pt-column{min-width:0}.pt-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;min-width:0;margin-bottom:12px}
.pt-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.pt-list{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto}.pt-choice{display:flex;align-items:flex-start;gap:8px;border:1px solid transparent;border-radius:8px;padding:8px;min-width:0}.pt-choice[data-selected=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.pt-choice input{margin:5px 0 0;accent-color:var(--dsw-alias-brand-primary)}.pt-choice-body{flex:1;min-width:0}.pt-choice-name{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left;padding:0;width:100%;font-weight:500;overflow-wrap:anywhere}.pt-choice-name:hover{text-decoration:underline}.pt-choice p{margin:3px 0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.pt-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;font-size:11px;overflow-wrap:anywhere}.pt-badge[data-tone=good]{color:var(--dsw-alias-state-success-primary)}.pt-badge[data-tone=bad]{color:var(--dsw-alias-state-error-primary);font-weight:600}
.pt-empty{margin:10px 0;color:var(--dsw-alias-label-secondary);font-size:13px}.pt-notice{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;padding:10px 12px;margin:10px 0;overflow-wrap:anywhere}.pt-notice p{margin:0}.pt-notice strong{margin-right:6px}
.pt-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}.pt-preview-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.pt-checks{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px}.pt-checks li{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}.pt-checks li[data-tone=bad] .pt-badge{color:var(--dsw-alias-state-error-primary)}.pt-step-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:2px}
.pt-table-wrap{overflow:auto;margin:8px 0}.pt-table{border-collapse:collapse;width:100%;font-size:12px;text-align:left}.pt-table th{color:var(--dsw-alias-label-secondary);font-weight:500}.pt-table td,.pt-table th{padding:7px 6px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top;overflow-wrap:anywhere}.pt-table td:first-child{white-space:nowrap;width:48px}
.pt-code{margin:8px 0;padding:10px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.pt-view details{margin:8px 0}.pt-view summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}

.pt-status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.pt-status-grid dt{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}.pt-status-grid dd{margin:0;overflow-wrap:anywhere}
.pt-run-list{max-height:240px;overflow:auto}.pt-run-button{display:block;width:100%;border:1px solid transparent;border-radius:8px;background:transparent;text-align:left;color:inherit;font:inherit;padding:8px;cursor:pointer}.pt-run-button:hover,.pt-run-button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2)}.pt-run-button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary)}.pt-run-button>span{display:block;font-size:12px;overflow-wrap:anywhere}
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
    // A missing dictionary entry must not leak "playtest-ui.type.foo" into the view.
    // `t` is passed in, not captured: these helpers live at module scope where the
    // bound translator does not exist yet, and a bare reference white-screens the view.
    function named(t, prefix, value, fallback) {
      const text = value == null ? '' : String(value);
      const translated = t(prefix + text);
      return translated === prefix + text ? (fallback != null ? fallback : text) : translated;
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
    function checksOf(step) {
      return step && Array.isArray(step.checks) ? step.checks : [];
    }
    function StepTable({ steps, t, results }) {
      if (!Array.isArray(steps) || !steps.length) return h('p', { className: 'pt-empty' }, t('noSteps'));
      return h('div', { className: 'pt-table-wrap' }, h('table', { className: 'pt-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('step')),
          h('th', { scope: 'col' }, t('workflow')), h('th', { scope: 'col' }, t('type')),
          results ? h('th', { scope: 'col' }, t('status')) : null)),
        h('tbody', null, steps.map((step, index) => h('tr', { key: [step.phase, step.play, step.stepNo, index].join(':') },
          h('td', null, step.stepNo == null ? index + 1 : step.stepNo),
          h('td', null, step.name || step.description || t('unknown'),
            step.phase ? h('div', { className: 'pt-muted' }, named(t, 'phase.', step.phase, asText(step.phase))) : null,
            // The engine's mismatch text belongs on the row: buried in the evidence blob it
            // reads as a bare "failed" and the reader cannot tell 401 from a wrong field.
            results && step.error ? h('div', { className: 'pt-step-error' }, step.error) : null,
            checksOf(step).length ? h('ul', { className: 'pt-checks', 'aria-label': t('checks') },
              checksOf(step).map((check, position) => h('li', { key: position, 'data-tone': results ? toneOf(check.status) : 'neutral' },
                results ? h(Badge, { value: check.status || 'observed', t }) : h('span', { className: 'pt-muted', 'aria-hidden': true }, '·'),
                h('span', null, check.name || check.type || t('checks')),
                check.error ? h('div', { className: 'pt-muted' }, check.error) : null))) : null,
            results ? h(JsonDetails, { title: t('evidence'), value: step }) : null),
          h('td', null, named(t, 'type.', step.type || 'http')),
          results ? h('td', null, h(Badge, { value: step.status || step.verdict || (step.ok === true ? 'passed' : step.ok === false ? 'failed' : 'observed'), t })) : null)))));
    }
    const RUN_PHASES = [['prepare', 'phasePrepare'], ['setup', 'phaseSetup'], ['play', 'phasePlay'], ['cleanup', 'phaseCleanup']];
    function RunSteps({ steps, t }) {
      const list = Array.isArray(steps) ? steps : [];
      const groups = RUN_PHASES.map(([phase, label]) => [phase, label, list.filter(step => (step.phase || 'play') === phase)])
        .filter(entry => entry[2].length);
      if (!groups.length) return h('p', { className: 'pt-empty' }, t('noSteps'));
      return h(React.Fragment, null, groups.map(([phase, label, items]) => h('section', { key: phase, className: 'pt-phase' },
        h('h3', null, t(label)), h(StepTable, { steps: items, results: true, t }))));
    }
    function mergeEvents(old, incoming) {
      const map = new Map(old.map((event, index) => [event.seq == null ? 'old:' + index : event.seq, event]));
      incoming.forEach((event, index) => map.set(event.seq == null ? 'new:' + old.length + ':' + index : event.seq, event));
      return [...map.values()].slice(-EVENT_LIMIT);
    }

    // Captures the root Remote face. A session-scoped Remote face intentionally
    // omits the explicit session argument; mixing those two faces causes arity errors.
    // One sentence in, a fresh agent session out: this is the same Remote pair the GUI's
    // New Session uses (`session.create` by directory, then `session.prompt`). A build
    // without that namespace degrades to a notice, never to a dead button.
    // Reading an undeclared or unmounted Remote namespace throws, and a throw during the
    // view's own setup blanks the whole panel. Never let the probe escape.
    function remoteNamespace(remote, name) {
      try {
        return remote ? remote[name] : null;
      } catch (_) {
        return null;
      }
    }
    const ARITY_FAILURE = /expected (\d+) argument\(s\), got (\d+)/;
    // Generated Remote faces carry the Host signature's parameter count, but which trailing
    // parameters (the AbortSignal) survive into the Client face is the gateway's choice —
    // `session.create` takes one argument while `session.prompt` takes two. Calling with the
    // declared count, plus one corrective retry driven by the gateway's own message, keeps a
    // signature difference from becoming a broken button. It never loops.
    async function callRemote(face, method, request, signal) {
      const declared = typeof face[method].length === 'number' ? face[method].length : 1;
      let withSignal = declared >= 2;
      const invoke = () => (withSignal ? face[method](request, signal) : face[method](request));
      try {
        return await invoke();
      } catch (error) {
        const mismatch = ARITY_FAILURE.exec(String((error && error.message) || error));
        if (!mismatch) throw error;
        const expected = Number(mismatch[1]);
        if (expected === (withSignal ? 2 : 1)) throw error;
        withSignal = expected >= 2;
        return invoke();
      }
    }
    function createHandoff(session) {
      if (!session || typeof session.create !== 'function' || typeof session.prompt !== 'function') return null;
      return async function handoff(goal, signal) {
        const created = await callRemote(session, 'create', { cwd: goal.repoRoot }, signal);
        if (created && created.ok === false) throw new Error(created.error && (created.error.message || String(created.error)) || 'session create failed');
        const target = (created && created.value) || created || {};
        if (!target.sessionId) throw new Error('session create returned no sessionId');
        const accepted = await callRemote(session, 'prompt', {
          requestId: 'playtest-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          sessionId: target.sessionId, mode: 'queue',
          content: [{ type: 'text', text: goal.text }]
        }, signal);
        if (accepted && accepted.ok === false) throw new Error(accepted.error && (accepted.error.message || String(accepted.error)) || 'prompt failed');
        return target.sessionId;
      };
    }

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

    function Workbench({ sessionId, request, handoff, t }) {
      const [repos, setRepos] = React.useState([]);
      const [repo, setRepo] = React.useState('');
      const [catalog, setCatalog] = React.useState(null);
      const [search, setSearch] = React.useState('');
      const [selected, setSelected] = React.useState([]);
      const [scenario, setScenario] = React.useState('');
      const [target, setTarget] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [validation, setValidation] = React.useState(null);
      const [runs, setRuns] = React.useState([]);
      const [runId, setRunId] = React.useState('');
      const [runData, setRunData] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [previewBusy, setPreviewBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [tab, setTab] = React.useState('work');
      const [tip, setTip] = React.useState(null);
      const [form, setForm] = React.useState(null);
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
      const repoOptions = React.useMemo(() => {
        const list = (Array.isArray(repos) ? repos : []).map(item => ({
          path: item.path,
          label: item.relative === '.' ? item.name : item.relative
        }));
        if (catalog && catalog.demoRepo && !list.some(item => item.path === catalog.demoRepo)) {
          list.push({ path: catalog.demoRepo, label: t('demo') });
        }
        return list;
      }, [repos, catalog, t]);
      // Long scene notes must not stretch the catalog column: they open on hover,
      // pinned to the row and clamped inside the viewport.
      const showTip = event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const width = Math.min(380, Math.max(220, Math.round(window.innerWidth * 0.3)));
        const left = Math.max(12, Math.min(rect.right + 10, window.innerWidth - width - 12));
        const top = Math.max(12, Math.min(rect.top - 6, window.innerHeight - 180));
        setTip({ play: event.currentTarget.dataset.play, name: event.currentTarget.dataset.name,
                 text: event.currentTarget.dataset.text, left, top, width });
      };
      const hideTip = () => setTip(null);
      React.useEffect(() => { const dismiss = () => setTip(null);
        window.addEventListener('blur', dismiss);
        return () => window.removeEventListener('blur', dismiss); }, []);

      const filtered = plays.filter(play => [play.slug, play.name, play.description].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
      const activeRuns = runs.filter(run => ACTIVE.has(stateOf(run.status)));
      const activeSelected = runData && ACTIVE.has(stateOf(runData.status));
      const validPreview = preview && preview.key === selectionKey && preview.data.ok && typeof preview.data.digest === 'string';
      const hasIssues = validPreview && (preview.data.issues || []).some(issue => ['error', 'ERROR'].includes(issue.level || issue.severity));
      const canStart = validPreview && !hasIssues && !busy && !previewBusy && !activeRuns.length;

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
        setPreview(null); setValidation(null);
        const opts = options(overrideRepo);
        const data = await call('catalog', opts);
        if (!mounted.current || version !== epoch.current) return;
        setCatalog(data);
        setSelected(old => old.filter(slug => (data.plays || []).some(play => play.slug === slug)));
        await refreshRuns(opts);
      };
      const inspect = async (chosen, { auto = false } = {}) => {
        const list = Array.isArray(chosen) ? chosen : selected;
        if (!list.length) return;
        const version = ++epoch.current;
        const key = JSON.stringify([repo.trim(), list, scenario.trim(), target.trim()]);
        setPreview(null); setValidation(null);
        if (auto) setPreviewBusy(true);
        try {
          const data = await call('inspect', { ...options(), plays: list });
          if (mounted.current && version === epoch.current) setPreview({ key, data });
        } catch (error) {
          if (mounted.current && version === epoch.current) setMessage({ error: true, text: error.message || String(error) });
        } finally {
          if (auto && mounted.current) setPreviewBusy(false);
        }
      };
      const selectRepo = value => {
        setRepo(value); invalidate(); setCatalog(null); setSelected([]); setRuns([]); setValidation(null);
        currentRun.current = ''; setRunId(''); setRunData(null);
        perform('catalog', () => loadCatalog(value));
      };
      const loadRepos = async () => {
        const data = await call('repos', {});
        if (!mounted.current) return;
        const list = Array.isArray(data.repositories) ? data.repositories : [];
        setRepos(list);
        const preferred = list.find(item => item.plays > 0) || list[0];
        if (preferred) {
          setRepo(preferred.path);
          await loadCatalog(preferred.path);
        } else {
          setRepo('');
          await loadCatalog();
        }
      };
      // Creating assets is a file write: the Host blocks it when the session is read-only
      // or the repository escapes the workspace, and that error surfaces as a notice.
      const draftPlay = () => perform('draft', async () => {
        // Nothing to type: the played slug and title already describe this run.
        const data = await call('draft', { ...options(), runId });
        if (!mounted.current || data.ok !== true) return;
        setTab('work');
        await loadCatalog();
        setSelected([data.slug]);
        setMessage({ error: false, text: t('saved', { slug: data.slug, drafted: data.draftedSteps }) });
      });
      const failedSteps = (steps) => (steps || []).filter(step => step.status
        && ['passed', 'observed', 'skipped'].indexOf(step.status) < 0);
      const analyzeRun = () => perform('analyze', async () => {
        // The point of handing a failure over is diagnosis, not making the badge green.
        const detail = runData || {};
        const broken = failedSteps(detail.steps);
        const text = t('agentAnalyze', {
          repo: options().repoRoot, runId, play: detail.name || detail.scenarioName || '',
          verdict: detail.verdict || 'unknown', execution: detail.execution || 'unknown',
          cleanup: detail.cleanup || 'unknown',
          runDir: (detail.artifacts && detail.artifacts.runDir) || '',
          failures: broken.length
            ? broken.map(step => '[' + (step.phase || '') + '] #' + step.stepNo + ' ' + step.name
              + ' → ' + step.status + (step.error ? '：' + step.error : '')).join(';')
            : t('noStepFailed')
        });
        const sessionId = await handoff({ repoRoot: options().repoRoot, text });
        if (mounted.current) setMessage({ error: false, text: t('analyzing', { sessionId }) });
      });
      const createForm = () => setForm({ mode: 'create', title: '' });
      const patchForm = updates => setForm(old => (old ? { ...old, ...updates } : old));
      const submitForm = () => perform('create', async () => {
        const title = form.title.trim();
        if (!title) { setMessage({ error: true, text: t('formRequired') }); return; }
        const data = await call('create', { ...options(), title });
        if (!mounted.current || data.ok !== true) return;
        setForm(null);
        setTab('work');
        await loadCatalog();
        setSelected([data.slug]);
        if (!handoff) {
          // Same capability gap the tool surface has: say the word and the agent continues.
          setMessage({ error: false, text: t('created', { slug: data.slug, target: data.target || t('empty') }) + ' ' + t('handoffUnavailable') });
          return;
        }
        try {
          await handoff({ repoRoot: options().repoRoot, text: t('agentGoal', { repo: options().repoRoot, path: data.path, intent: title }) });
          setMessage({ error: false, text: t('handedOff', { slug: data.slug }) });
        } catch (error) {
          // The skeleton is already on disk: report the half-step instead of losing it.
          setMessage({ error: true, text: t('handedOffFailed', { slug: data.slug }) + ' ' + (error.message || String(error)) });
        }
      });

      const chooseRun = async id => {
        setTab('run');
        currentRun.current = id; cursor.current = 0;
        setRunId(id); setRunData(null);
        await readRun(id, 0, options(), undefined, true);
      };
      // A scenario file belongs to one play: for a single play offer everything it holds;
      // for several plays only the names every one of them carries can be honoured.
      const picked = ((catalog && catalog.plays) || []).filter(play => selected.indexOf(play.slug) >= 0);
      const scenarioLists = picked.map(play => play.scenarios || []);
      const scenarioNames = !scenarioLists.length ? []
        : scenarioLists.length === 1 ? scenarioLists[0]
          : scenarioLists[0].filter(name => scenarioLists.every(list => list.indexOf(name) >= 0));
      const scenarioLocked = picked.length > 1 && !scenarioNames.length;
      const defaultFiles = picked.map(play => play.defaultScenario || 'scenario.json');
      const scenarioLabel = name => {
        const stem = name.replace(/^scenario[._-]?/, '').replace(/\.json$/, '');
        const single = picked.length === 1 && defaultFiles.indexOf(name) >= 0;
        return (stem || name) + (single ? t('scenarioIsDefault') : '');
      };
      const targets = (catalog && Array.isArray(catalog.targets)) ? catalog.targets : [];
      const start = async () => {
        if (!canStart) return;
        // Authority is sourced only from this checkbox's human onChange handler
        // and this button's human click, never from a catalog result or an agent tool.
        const digest = preview.data.digest;
        const data = await call('start', {
          ...options(), plays: selected, expectedDigest: digest
        });
        if (!mounted.current) return;
        setRuns(old => [{ runId: data.runId, status: data.status || 'running', artifacts: data.artifacts }, ...old.filter(run => run.runId !== data.runId)]);
        await chooseRun(data.runId);
      };
      React.useEffect(() => {
        if (scenario && scenarioNames.indexOf(scenario) < 0) setScenario('');
      }, [scenarioNames.join(','), picked.length]);
      const invalidate = () => {
        epoch.current += 1; setPreview(null); setValidation(null);
      };

      // Choosing a test (or changing repository/scenario/target) previews it
      // automatically, so starting a run never needs a separate preview click.
      React.useEffect(() => {
        if (!selected.length) return undefined;
        const timer = setTimeout(() => { inspect(selected, { auto: true }); }, 260);
        return () => clearTimeout(timer);
      }, [selectionKey]);

      React.useEffect(() => {
        mounted.current = true;
        perform('repos', loadRepos);
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

      return h('section', { className: 'pt-view', 'data-tab': tab, 'aria-label': t('title'), 'aria-busy': !!busy },
        h('style', null, css),
        h('header', { className: 'pt-header' }, h('h2', null, t('title')), h('p', { className: 'pt-muted' }, t('subtitle'))),
        h('div', { className: 'pt-toolbar' },
          h('label', { className: 'pt-field' }, h('span', null, t('repo')),
            h('select', {
              className: 'pt-input pt-select', value: repo, disabled: !!busy || !repoOptions.length,
              'aria-label': t('repo'), onChange: event => { if (event.target.value !== repo) selectRepo(event.target.value); }
            },
              !repoOptions.length ? h('option', { value: '' }, t('noRepos')) : null,
              repoOptions.map(item => h('option', { key: item.path, value: item.path }, item.label)))),
          button(t('refresh'), () => perform('repos', loadRepos), !!busy, 'pt-small'),
          tab === 'work' ? button(t('newPlay'), createForm, !repo || !!busy, 'pt-small') : null),
        form ? h('section', { className: 'pt-card pt-form' },
          h('div', { className: 'pt-card-title' }, h('h3', null, t('newPlay')), h('span', { className: 'pt-muted' }, repo)),
          h('label', { className: 'pt-field' }, h('span', null, t('createTitle')),
            h('input', { className: 'pt-input', value: form.title, disabled: !!busy, autoFocus: true,
              'aria-label': t('createTitle'), placeholder: t('createExample'),
              onChange: event => patchForm({ title: event.target.value }),
              onKeyDown: event => { if (event.key === 'Enter' && !busy) submitForm(); } })),
          h('p', { className: 'pt-muted' }, t('createHelp')),
          h('div', { className: 'pt-actions' },
            button(t('createSubmit'), submitForm, !!busy || !form.title.trim(), 'pt-primary'),
            button(t('cancelForm'), () => setForm(null), !!busy, 'pt-small'))) : null,
        catalog && catalog.repoRoot ? h('p', { className: 'pt-muted' }, t('resolvedRepo') + ': ', catalog.repoRoot) : null,
        message ? h('div', { className: 'pt-notice', role: message.error ? 'alert' : 'status' },
          h('div', { className: 'pt-card-title' }, h('p', null, message.text),
            button(t('dismiss'), () => setMessage(null), false, 'pt-small'))) : null,
        h('div', { className: 'pt-tabs', role: 'tablist' },
          [['work', 'tabWork'], ['run', 'tabRun']].map(pair => h('button', {
            key: pair[0], type: 'button', role: 'tab', className: 'pt-tab', 'aria-selected': tab === pair[0],
            onClick: () => setTab(pair[0])
          }, t(pair[1]), pair[0] === 'run' && activeRuns.length ? h('span', { className: 'pt-dot', 'aria-hidden': true }) : null))),
        tab === 'work' && tip ? h('aside', { className: 'pt-tip', role: 'tooltip',
          style: { left: tip.left, top: tip.top, width: tip.width + 'px' } },
          h('strong', null, tip.name || tip.play),
          tip.name && tip.name !== tip.play ? h('span', { className: 'pt-muted' }, tip.play) : null,
          h('p', null, tip.text || t('noDescription'))) : null,
        h('div', { className: 'pt-grid' },
          h('aside', { className: 'pt-column' },
            h('section', { className: 'pt-card pt-only-work', 'aria-label': t('catalog') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('catalog')), h('span', { className: 'pt-muted' }, t('selected', { count: selected.length }))),
              h('input', { type: 'search', className: 'pt-input', value: search, 'aria-label': t('search'), placeholder: t('searchHint'), onChange: event => setSearch(event.target.value) }),
              h('div', { className: 'pt-toolbar' },
                button(t('selectAll'), () => { setSelected(filtered.map(play => play.slug)); invalidate(); }, !filtered.length || !!busy, 'pt-small'),
                button(t('clearSelection'), () => { setSelected([]); invalidate(); }, !selected.length || !!busy, 'pt-small')),
              h('div', { className: 'pt-list', onScroll: hideTip }, filtered.length ? filtered.map(play => h('div', {
                key: play.slug, className: 'pt-choice', 'data-selected': selected.includes(play.slug),
              'data-play': play.slug, 'data-name': play.name || play.slug, 'data-text': play.description || '',
              onMouseEnter: showTip, onMouseLeave: hideTip, onFocus: showTip, onBlur: hideTip
              }, h('input', { type: 'checkbox', checked: selected.includes(play.slug), disabled: !!busy,
                'aria-label': play.name || play.slug, onChange: event => {
                  setSelected(old => event.target.checked ? [...old, play.slug] : old.filter(slug => slug !== play.slug)); invalidate();
                } }), h('div', { className: 'pt-choice-body' },
                h('button', { type: 'button', className: 'pt-choice-name', disabled: !!busy, onClick: () => {
                  // Selection alone triggers the automatic preview above.
                  setSelected([play.slug]); invalidate();
                } }, play.name || play.slug),
                h('div', { className: 'pt-actions' }, h('span', { className: 'pt-badge' }, t('mode.' + (play.mode || 'explore'))),
                  h('span', { className: 'pt-muted' }, t('step') + ': ' + (Array.isArray(play.steps) ? play.steps.length : play.steps || 0))))))
                : h('p', { className: 'pt-empty' }, t(plays.length ? 'noMatches' : 'noTests')))),
            h('section', { className: 'pt-card pt-only-run', 'aria-label': t('runs') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('runs')),
                button(t('refresh'), () => perform('runs', () => refreshRuns(options())), !!busy, 'pt-small')),
              h('div', { className: 'pt-run-list' }, runs.length ? runs.map(run => h('button', {
                type: 'button', key: run.runId, className: 'pt-run-button', 'aria-pressed': run.runId === runId,
                disabled: !!busy, onClick: () => perform('read', () => chooseRun(run.runId))
              }, h('span', null, run.name || run.scenarioName || run.runId),
              h('span', { className: 'pt-muted' }, run.startedAt || run.createdAt || ''), h(Badge, { value: run.status, t })))
                : h('p', { className: 'pt-empty' }, t('noRuns'))))),
          h('div', { className: 'pt-column' },
            h('section', { className: 'pt-card pt-only-work', 'aria-label': t('previewTitle') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('previewTitle')), h('span', { className: 'pt-muted' }, previewBusy ? t('previewing') : busy ? t('busy') : t('previewOnly'))),
              h('div', { className: 'pt-options' },
                h('label', { className: 'pt-field' }, h('span', null, t('target')),
                  targets.length ? h('select', { className: 'pt-input', value: target, disabled: !!busy,
                    'aria-label': t('target'), onChange: event => { setTarget(event.target.value); invalidate(); } },
                    h('option', { value: '' }, t('targetAuto')),
                    targets.map(name => h('option', { key: name, value: name }, name)))
                    : h('input', { className: 'pt-input', value: target, disabled: !!busy, placeholder: t('targetHint'), onChange: event => { setTarget(event.target.value); invalidate(); } })),
                h('label', { className: 'pt-field' }, h('span', null, t('scenario')),
                  picked.length ? h('select', { className: 'pt-input', value: scenario, disabled: !!busy || scenarioLocked,
                    'aria-label': t('scenario'), onChange: event => { setScenario(event.target.value); invalidate(); } },
                    h('option', { value: '' }, t('scenarioAuto')),
                    scenarioNames.map(name => h('option', { key: name, value: name }, scenarioLabel(name))))
                    : h('input', { className: 'pt-input', value: scenario, disabled: !!busy, placeholder: t('scenarioHint'), onChange: event => { setScenario(event.target.value); invalidate(); } }))),
              scenarioLocked ? h('p', { className: 'pt-muted' }, t('scenarioLockedHint')) : null,
              h('div', { className: 'pt-actionbar' },
                button(t('start'), () => perform('start', start), !canStart, 'pt-primary'),
                button(t('validate'), () => perform('lint', async () => { const data = await call('lint', { ...options(), plays: selected }); if (mounted.current) setValidation(data); }), !selected.length || !!busy, 'pt-small'),
                !validPreview && selected.length ? button(t('preview'), () => perform('inspect', () => inspect(selected)), !!busy, 'pt-small') : null),
              activeRuns.length ? h('p', { className: 'pt-muted' }, t('activeHint')) : null,
              validation ? h(JsonDetails, { title: t('validation'), value: validation, open: true }) : null,
              !selected.length ? h('p', { className: 'pt-empty' }, t('readyHint')) : null,
              preview && !validPreview ? h('p', { className: 'pt-notice' }, t('stale')) : null,
              preview ? h(React.Fragment, null,
                h('p', { className: 'pt-muted' }, t('digest') + ': ', preview.data.digest || t('unknown')),
                (preview.data.issues || []).length ? h(JsonDetails, { title: t('validation'), value: preview.data.issues, open: true }) : null,
                previewPlays.map(play => h('section', { key: play.slug, className: 'pt-card' },
                  h('div', { className: 'pt-preview-head' }, h('h3', null, play.name || play.slug), h('span', { className: 'pt-badge' }, t('mode.' + (play.mode || 'explore')))),
                  play.description ? h('details', { className: 'pt-desc' }, h('summary', null, t('description')),
                    h('p', { className: 'pt-muted' }, play.description)) : null,
                  h('p', { className: 'pt-muted' }, t('target') + ': ' + (play.baseUrl || play.target || t('empty')) + ' · ' + t('scenario') + ': ' + (play.scenario || t('empty'))),
                  (preview.data.prepare || []).length ? h(React.Fragment, null,
                    h('h3', null, t('phasePrepare')),
                    h(StepTable, { steps: (preview.data.prepare || []).map(item => ({ ...item, phase: 'prepare' })), t })) : null,
                  h('h3', null, t('workflow')), h(StepTable, { steps: play.steps, t }),
                  h('details', null, h('summary', null, t('setup')), h(StepTable, { steps: play.setup, t })),
                  h('details', null, h('summary', null, t('cleanup')), h(StepTable, { steps: play.cleanup, t })),
                  h(JsonDetails, { title: t('mocks'), value: play.mocks || [] }),
                  h('details', null, h('summary', null, t('basis')), (play.claims || []).length ? play.claims.map((claim, index) => h('div', { key: claim.id || index, className: 'pt-claim' },
                    h('p', null, claim.description || claim.id), h('pre', { className: 'pt-code' }, bounded(claim.basis))))
                    : h('p', { className: 'pt-empty' }, t('noClaims'))))),
                h('h3', null, t('effects')),
                effects.length ? h('ul', { className: 'pt-effects' }, (Array.isArray(effects) ? effects : []).map((item, index) => h('li', { key: index },
                  h('span', { className: 'pt-badge' }, named(t, 'effect.', item.code, item.kind || 'effect')),
                  h('span', { className: 'pt-muted' }, [named(t, 'phase.', item.phase, item.phase),
                    item.stepNo != null ? t('step') + ' ' + item.stepNo : '',
                    item.play || (item.target && typeof item.target === 'object'
                      ? Object.entries(item.target).map(([k, v]) => k + '=' + v).join(' ') : item.target)]
                    .filter(Boolean).join(' · '))))) : h('p', { className: 'pt-empty' }, t('noEffects')),
                h(JsonDetails, { title: t('inspectDetails'), value: preview.data.preview || preview.data.snapshot })) : null),
            runId ? h('section', { className: 'pt-card pt-only-run', 'aria-label': t('run') },
              h('div', { className: 'pt-card-title' }, h('h3', null, t('run') + ' ' + runId),
                h('div', { className: 'pt-actions' },
                  button(t('saveAsPlay'), draftPlay, !!busy || !runId, 'pt-small'),
                  handoff && runData && (runData.verdict !== 'passed' || runData.execution !== 'completed'
                    || runData.cleanup === 'failed' || failedSteps(runData.steps).length)
                    ? button(t('analyzeRun'), analyzeRun, !!busy, 'pt-small') : null,
                  button(t('reloadRun'), () => perform('read', () => readRun(runId, cursor.current, options(), undefined, false)), !!busy, 'pt-small'),
                  activeSelected ? button(t('cancel'), () => perform('cancel', async () => {
                    await call('cancel', { ...options(), runId });
                    if (mounted.current) setMessage({ error: false, text: t('cancelling') });
                    await readRun(runId, cursor.current, options(), undefined, false);
                  }), !!busy, 'pt-small') : null)),
              runData ? h(React.Fragment, null,
                h('dl', { className: 'pt-status-grid' }, [['verdict', runData.verdict], ['execution', runData.execution], ['cleanupResult', runData.cleanup]].map(([key, value]) => h('div', { key },
                  h('dt', null, t(key)), h('dd', null, h(Badge, { value, t }))))),
                h(RunSteps, { steps, t }),
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
                h(JsonDetails, { title: t('artifacts'), value: runData.artifacts || recorded.artifacts })) : h('p', { role: 'status', className: 'pt-empty' }, t('busy')))
 : h('section', { className: 'pt-card pt-only-run' }, h('p', { className: 'pt-empty' }, t('runEmpty'))))))
    }

    function PlaytestView(props) {
      // Explicit key guarantees local state, cursors, confirmation and pending
      // requests never transfer when the conversation switches to another session.
      return h(Workbench, { ...props, key: props.sessionId });
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'playtest: client dictionaries');
        const t = ctx.locale.bind(NS);
        const request = createRequest(ctx.remote, t);
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'playtest', order: 20,
          label: () => t('title'), locale: NS,
          inject: sessionId => ({
            handoff: createHandoff(remoteNamespace(ctx.remote, 'session')),
            request: (_sessionId, payload, signal) => request(sessionId, payload, signal), sessionId
          })
        }, PlaytestView));
      }
    };
  }
});
