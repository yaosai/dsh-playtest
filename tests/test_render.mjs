/* Render smoke test: the view must build a tree with real migrated-shaped data.
 *
 * Structural regex tests cannot catch a ReferenceError inside a render path, and one of
 * those white-screened the whole panel. Here the module is actually evaluated and rendered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SAME = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

function makeReact() {
  const state = { hooks: [], cursor: 0, scheduled: [], dirty: false };
  const react = {
    // Function components are invoked for real: a lazy tree would never run the
    // render body, which is exactly where a white-screen error would come from.
    createElement: (type, props, ...children) => (typeof type === 'function'
      ? type({ ...(props || {}) })
      : { type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = state.cursor++;
      if (!(index in state.hooks)) state.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = state.hooks[index];
      const set = value => {
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (next !== slot.value) { slot.value = next; state.dirty = true; }
      };
      return [slot.value, set];
    },
    useRef(initial) {
      const index = state.cursor++;
      if (!(index in state.hooks)) state.hooks[index] = { current: initial };
      return state.hooks[index];
    },
    // Memoized like React: without this, a callback identity changes every round and
    // mount effects re-run, clearing state the test is waiting for.
    useMemo(fn, deps) {
      const index = state.cursor++;
      const slot = state.hooks[index] || (state.hooks[index] = { deps: Symbol('none'), value: undefined });
      if (slot.deps === undefined || !SAME(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; }
      return slot.value;
    },
    // React returns the callback itself, memoized by deps; calling it would run the
    // effect body during render.
    useCallback(fn, deps) {
      const index = state.cursor++;
      const slot = state.hooks[index] || (state.hooks[index] = { deps: undefined, value: undefined });
      if (slot.deps === undefined || !SAME(slot.deps, deps)) { slot.value = fn; slot.deps = deps; }
      return slot.value;
    },
    useEffect(fn, deps) {
      const index = state.cursor++;
      const slot = state.hooks[index] || (state.hooks[index] = { deps: undefined, cleanup: undefined, fresh: true });
      const changed = slot.fresh || !SAME(slot.deps, deps) || deps === undefined;
      if (changed) {
        slot.deps = deps;
        slot.fresh = false;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        state.scheduled.push({ slot, fn });
        // Mirror the hook body now so effects that touch state in the same tick behave.
        slot.cleanup = undefined;
      }
    }
  };
  state.react = react;
  return { react, state };
}

function collect(node, out) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach(item => collect(item, out)); return out; }
  if (typeof node === 'object' && 'props' in node) {
    if (typeof node.props.onClick === 'function') out.push('[clickable]');
    Object.entries(node.props).forEach(([key, value]) => {
      if (key.startsWith('data-') || ['aria-label', 'placeholder', 'value'].includes(key)) out.push(String(value));
    });
    collect(node.children, out);
  }
  return out;
}

function loadView(source, extras = {}) {
  const { react, state } = makeReact();
  let registered = null;
  let registeredSlot = '';
  let registration = null;
  // The view debounces its automatic preview with a timer; a controllable clock keeps
  // the smoke test deterministic instead of sleeping.
  const timers = new Map();
  let sequence = 0;
  const flushTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach(entry => entry.fn());
    return due.length;
  };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: spec => { sandbox.__spec__ = spec; } },
      innerWidth: 1440, innerHeight: 900,
      addEventListener() {}, removeEventListener() {}
    },
    React: react,
    console,
    Math, JSON, Date, Set, Map, WeakMap, Number, String, Array, Object, Boolean, Error, Promise, RegExp, Symbol,
    setTimeout: (fn, ms) => { sequence += 1; timers.set(sequence, { fn, ms }); return sequence; },
    clearTimeout: id => timers.delete(id),
    Intl, AbortController, encodeURIComponent, isNaN, Infinity, NaN, undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const factory = sandbox.__spec__.factory;
  const module = factory(name => {
    assert.equal(name, 'react', 'the view only needs React');
    return react;
  });
  assert.equal(module.inject.join(','), ['slots', 'locale', 'remote', 'remote.commands', 'remote.session'].join(','),
    'the commands bridge and the session handoff must both stay injected');
  const dictionaries = {};
  const calls = [];
  const ctx = {
    effect: fn => fn(),
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts; },
      bind: ns => (key, values) => {
        const dict = dictionaries[ns] || {};
        const text = key in dict.zh ? dict.zh[key] : key in dict.en ? dict.en[key] : key;
        return values ? String(text).replace(/\{(\w+)\}/g, (_, name) => values[name]) : text;
      }
    },
    // Copy descriptors instead of spreading: a throwing getter must stay a getter until the
    // view reads it, which is exactly the case under test.
    remote: Object.defineProperties(
      { commands: { execute: async () => { throw new Error('not used in this test'); } } },
      Object.getOwnPropertyDescriptors(extras.remote || {})),
    slots: {
      // The real host asks for registrations lazily; drive it so this test proves the view mounts.
      inject: (name, provide) => { registeredSlot = name; provide(); },
      register: (options, component) => { registered = { options, component }; registration = options; }
    }
  };
  module.apply(ctx);
  assert.equal(registeredSlot, 'conversation.view', 'it must mount in the conversation view slot');
  assert.ok(registered, 'the view must register a conversation view');
  return { component: registered.component, react, state, calls, dictionaries, flushTimers,
    // Props come from the same seam the Host uses, so a view that only works when a
    // test hand-builds them cannot pass.
    injectedProps: sessionId => (registration.inject ? registration.inject(sessionId) : {}) };
}

// Data shaped like the migrated demo-biz-repo assets, through the plugin's own tool contract.
const REPO = '/work/demo-biz-repo';
const FIXTURES = {
  repos: { ok: true, root: '/work', repositories: [{ path: REPO, relative: 'demo-biz-repo', name: 'demo-biz-repo', plays: 1 }],
    demoRepo: '/work/dsh-playtest/examples/demo-project' },
  catalog: { ok: true, repoRoot: REPO, plays: [{ slug: 'station-lifecycle', name: '工作站生命周期',
    description: '停接单、恢复接单、下线、复上线、重复上线拒绝。', mode: 'baseline', steps: 5,
    scenarios: ['scenario.json', 'scenario-from-offline.json'] }] },
  runs: { ok: true, runs: [{ runId: '20261111T034212-b4fa63aa46fe', name: '工作站生命周期',
    status: 'completed', verdict: 'passed', execution: 'completed', cleanup: 'completed' }] },
  read: { ok: true, runId: '20261111T034212-b4fa63aa46fe', status: 'completed', verdict: 'passed',
    execution: 'completed', cleanup: 'completed', digest: 'abc123', nextOffset: 3, truncated: false,
    steps: [{ phase: 'play', play: 'station-lifecycle', stepNo: 1, name: '停止接单', status: 'passed' }],
    assertions: [], events: [{ seq: 1, type: 'run_finished', time: '2026-11-11T03:42:20+08:00' }],
    artifacts: { runDir: '.test-plays/runs/20261111T034212-b4fa63aa46fe' }, result: {} },
  inspect: {
    ok: true, digest: 'abc123', requiresConfirmation: true, issues: [],
    effects: [
      { kind: 'http', code: 'http.external', play: 'station-lifecycle', phase: 'prepare', stepNo: 1,
        target: 'local', description: 'HTTP request to a non-owned service', requiresConfirmation: true },
      { kind: 'database', code: 'database.command', play: 'station-lifecycle', phase: 'play', stepNo: 1,
        target: { host: '127.0.0.1', port: 1433, database: 'BY' },
        description: 'Trusted command adapter invocation', requiresConfirmation: true }
    ],
    preview: {
      repoRoot: REPO, assertions: 5, prepareAssertions: 2,
      prepare: [{ stepNo: 1, name: '业务服务在线', type: 'http', target: 'local', assertions: 1 }],
      plays: [{
        slug: 'station-lifecycle', name: '工作站生命周期', description: '停接单、恢复接单、下线。',
        mode: 'baseline', path: '..test-plays/station-lifecycle/play.json', target: 'local',
        baseUrl: 'http://localhost:8080', claims: [], mocks: [], setup: [], cleanup: [],
        steps: [
          { stepNo: 1, name: '停止接单', type: 'http', assertions: 2,
            checks: [{ name: '停止接单后仍在线且接单标志为0', type: 'dbWait', assertions: 3 }] },
          { stepNo: 2, name: '工作站下线', type: 'http', assertions: 2,
            checks: [{ name: '下线后状态符合基线', type: 'dbWait', assertions: 3 }] }
        ]
      }],
      effects: [], limits: {}
    },
    snapshot: { version: 1 }
  }
};

async function mount(component, request) {
  const props = { sessionId: 'session-1', request, t: key => key };
  const tree = await component(props);
  return tree;
}

async function renderWithEffects(view, request, rounds = 8) {
  const props = { ...view.injectedProps('session-1'), sessionId: 'session-1', request, t: view.dictionaries['playtest-ui']
    ? (key, values) => {
        const dict = view.dictionaries['playtest-ui'];
        const text = key in dict.zh ? dict.zh[key] : key in dict.en ? dict.en[key] : key;
        return values ? String(text).replace(/\{(\w+)\}/g, (_, name) => values[name]) : text;
      }
    : key => key };
  let tree = null;
  for (let round = 0; round < rounds; round += 1) {
    view.state.cursor = 0;
    view.state.scheduled = [];
    tree = view.component(props);
    const effects = view.state.scheduled.splice(0);
    effects.forEach(effect => { const cleanup = effect.fn(); if (typeof cleanup === 'function') effect.slot.cleanup = cleanup; });
    view.flushTimers();
    for (let tick = 0; tick < 8; tick += 1) await new Promise(resolve => setImmediate(resolve));
    if (!view.state.dirty) break;
    view.state.dirty = false;
  }
  return tree;
}

function walk(node, visit) {
  if (node == null || node === false) return null;
  if (Array.isArray(node)) { for (const item of node) { const hit = walk(item, visit); if (hit) return hit; } return null; }
  if (typeof node !== 'object') return null;
  if (visit(node)) return node;
  return walk(node.children, visit);
}

function findButton(tree, label) {
  return walk(tree, node => typeof node.props?.onClick === 'function' && collect(node, []).join(' ').includes(label));
}

function findInSection(tree, sectionLabel, nodeFilter) {
  const section = walk(tree, node => node.props?.['aria-label'] === sectionLabel);
  return section ? walk(section, nodeFilter) : null;
}

function findRunButton(tree) {
  // Run rows are the only clickable nodes with aria-pressed in this view.
  return walk(tree, node => typeof node.props?.onClick === 'function' && 'aria-pressed' in node.props);
}

function findInput(tree, label) {
  return walk(tree, node => node.type === 'input' && node.props?.['aria-label'] === label);
}

function clickRowSelecting(tree) {
  const queue = [tree];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { node.forEach(item => queue.push(item)); continue; }
    if (node.props && typeof node.props.onChange === 'function' && node.props.type === 'checkbox'
      && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].includes('工作站')) {
      return node;
    }
    if (node.children) queue.push(node.children);
  }
  return null;
}

function findRowCheckbox(tree, needle) {
  const queue = [tree];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { node.forEach(item => queue.push(item)); continue; }
    const props = node.props || {};
    if (props.type === 'checkbox' && typeof props.onChange === 'function'
      && typeof props['aria-label'] === 'string' && props['aria-label'].includes(needle)) return node;
    if (node.children) queue.push(node.children);
  }
  return null;
}

function findSelect(tree, label) {
  return walk(tree, node => node.type === 'select' && node.props?.['aria-label'] === label);
}

function optionsOf(select) {
  const found = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'option') found.push({ value: node.props?.value, label: collect(node, []).join('') });
    if (node.children) visit(node.children);
  })(select);
  return found;
}

test('the view renders migrated-shaped data without throwing', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const view = loadView(source);
  const asked = [];
  const sent = [];
  // The view's `request` prop is the payload-level bridge (createRequest wraps it into
  // "/playtest <json>" for the command service), so it receives an object and returns data.
  const request = async (sessionId, payload) => {
    asked.push(payload.action);
    sent.push(payload);
    const data = FIXTURES[payload.action];
    assert.ok(data, `the view asked for an unknown action: ${payload.action}`);
    return data;
  };

  const tree = await renderWithEffects(view, request);
  const text = collect(tree, []).join(' ');

  assert.ok(asked.includes('repos'), 'it must discover repositories on mount');
  assert.ok(asked.includes('catalog'), 'it must load the playbook of the chosen repository');
  assert.match(text, /工作站生命周期/, 'the Chinese play title is what the list shows');
  assert.match(text, /行为基线/, 'the play purpose renders in Chinese');
  assert.ok(!text.includes('playtest-ui.'), 'no raw dictionary key may reach the screen');

  // Selecting a play is the path that white-screened: it renders the preview table.
  const checkbox = clickRowSelecting(tree);
  assert.ok(checkbox, 'the play row must expose a checkbox');
  checkbox.props.onChange({ target: { checked: true } });
  const previewed = await renderWithEffects(view, request, 10);
  const previewText = collect(previewed, []).join(' ');
  assert.ok(asked.includes('inspect'), 'selection triggers the automatic preview');
  assert.match(previewText, /HTTP 调用/, 'action types render in Chinese, not as raw engine values');
  assert.ok(!/\|(http|dbQuery|dbWait)\s*$/.test(previewText), 'the type column is never a raw engine token');
  assert.match(previewText, /场景准备/, 'the preparation stage renders with its Chinese heading');
  assert.match(previewText, /调用非本插件启动的服务/, 'expected effects render as localized rows');
  assert.match(previewText, /停止接单后仍在线且接单标志为0/, 'embedded verifications show under their step');
  assert.ok(!previewText.includes('playtest-ui.'), 'no raw dictionary key may reach the screen');
  assert.ok(!/>\s*(prepare|setup|play|cleanup)\s*</.test(previewText), 'engine phase values stay translated');
});


test('the scenario picker offers the selected play’s files instead of asking for a name', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const view = loadView(source);
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  fixtures.catalog.targets = ['local'];
  fixtures.catalog.plays = [
    { slug: 'inbound-create-bill', name: '下发一笔入库单', description: '', mode: 'baseline', steps: 1,
      defaultScenario: 'scenario-carton.json',
      scenarios: ['scenario-pallet.json', 'scenario-crate.json', 'scenario-carton.json'] },
    { slug: 'station-lifecycle', name: '工作站生命周期', description: '', mode: 'baseline', steps: 5,
      defaultScenario: 'scenario.json', scenarios: ['scenario.json', 'scenario-from-offline.json'] }
  ];
  const sent = [];
  const request = async (sessionId, payload) => { sent.push(payload); return fixtures[payload.action]; };

  let tree = await renderWithEffects(view, request, 6);
  findRowCheckbox(tree, '入库').props.onChange({ target: { checked: true } });
  tree = await renderWithEffects(view, request, 10);

  const picker = findSelect(tree, '场景');
  assert.ok(picker, 'a dropdown replaces the file-name input');
  const choices = optionsOf(picker);
  assert.equal(choices[0].value, '', 'the first choice means "let the play decide"');
  assert.match(choices[0].label, /用剧本自己的默认场景/);
  assert.deepEqual(choices.slice(1).map(option => option.value),
    ['scenario-pallet.json', 'scenario-crate.json', 'scenario-carton.json'], 'every file the play holds, in order');
  assert.match(choices.slice(1).map(o => o.label).join(' '), /carton（默认）/, "the play's own default is marked");
  assert.equal(findSelect(tree, '目标').props.disabled, false);
  assert.deepEqual(optionsOf(findSelect(tree, '目标')).map(o => o.value), ['', 'local'], 'targets come from the config');

  picker.props.onChange({ target: { value: 'scenario-pallet.json' } });
  tree = await renderWithEffects(view, request, 12);
  const previewed = sent.filter(payload => payload.action === 'inspect').pop();
  assert.equal(previewed.scenario, 'scenario-pallet.json', 'choosing a scenario re-previews with it');

  // A second play has no file in common: the choice cannot apply to both, so the control
  // says so instead of sending a scenario that would fail for one of them.
  findRowCheckbox(tree, '工作站').props.onChange({ target: { checked: true } });
  tree = await renderWithEffects(view, request, 12);
  const locked = findSelect(tree, '场景');
  assert.equal(locked.props.disabled, true, 'no shared scenario file means the picker is locked');
  const after = sent.filter(payload => payload.action === 'inspect').pop();
  assert.ok(!after.scenario || after.plays.length === 1, 'a stale scenario is not carried into a two-play preview');
  assert.match(collect(tree, []).join(' '), /选了多个剧本/, 'and the reason is stated, not left to guesswork');
});

test('creating a play needs one sentence and derives the rest', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const view = loadView(source);
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const sent = [];
  const request = async (sessionId, payload) => {
    sent.push(payload);
    if (payload.action === 'create') {
      assert.equal(payload.name, undefined, 'the view must not ask for a directory name');
      assert.equal(payload.target, undefined, 'nor which target to bind');
      fixtures.catalog.plays.push({ slug: 'station-offline-guard', name: payload.title, description: '',
        mode: 'explore', steps: 0, scenarios: [] });
      return { ok: true, slug: 'station-offline-guard', title: payload.title, target: 'local',
        targetInferred: true, path: '.test-plays/station-offline-guard', files: [], next: '' };
    }
    return fixtures[payload.action];
  };

  let tree = await renderWithEffects(view, request);
  const entry = findButton(tree, '新建剧本');
  assert.ok(entry, 'the toolbar offers a new-play entry');
  entry.props.onClick();
  tree = await renderWithEffects(view, request);
  const title = findInput(tree, '你要验证什么？');
  assert.ok(title, 'exactly one question is asked');
  assert.ok(!findInput(tree, '目录名（kebab-case）'), 'no directory-name field any more');
  const submit = findButton(tree, '创建');
  assert.equal(submit.props.disabled, true, 'an empty sentence cannot be submitted');
  title.props.onChange({ target: { value: '工作站下线后不应继续接单' } });
  tree = await renderWithEffects(view, request);
  assert.equal(findButton(tree, '创建').props.disabled, false, 'a sentence enables it');
  findButton(tree, '创建').props.onClick();
  tree = await renderWithEffects(view, request, 12);

  const created = sent.find(payload => payload.action === 'create');
  assert.ok(created, 'submitting reached the host bridge');
  assert.equal(created.title, '工作站下线后不应继续接单');
  assert.equal(created.repoRoot, REPO, 'and it writes into the selected repository only');
  assert.ok(sent.filter(payload => payload.action === 'catalog').length >= 2, 'the catalog reloads');
  const text = collect(tree, []).join(' ');
  assert.match(text, /已创建 station-offline-guard/, 'the notice names the derived directory');
  assert.match(text, /目标：local/, 'and says which target was inferred');
  assert.match(text, /工作站下线后不应继续接单/, 'the new play appears with the sentence as its title');
});

test('saving a recorded run as a play takes one click and no typing', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const view = loadView(source);
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const sent = [];
  const request = async (sessionId, payload) => {
    sent.push(payload);
    if (payload.action === 'draft') {
      fixtures.catalog.plays.push({ slug: 'station-lifecycle-observed', name: '工作站生命周期（沉淀）',
        description: '', mode: 'explore', steps: 5, scenarios: [] });
      return { ok: true, slug: 'station-lifecycle-observed', fromPlay: 'station-lifecycle',
        runId: payload.runId, stepCount: 5, draftedSteps: 2, unadoptedSteps: 0,
        path: '.test-plays/station-lifecycle-observed', next: '' };
    }
    return fixtures[payload.action];
  };

  let tree = await renderWithEffects(view, request);
  const refresh = findInSection(tree, '运行历史',
    node => typeof node.props?.onClick === 'function' && collect(node, []).join(' ').includes('刷新'));
  refresh.props.onClick();
  tree = await renderWithEffects(view, request, 6);
  const history = findRunButton(tree);
  assert.ok(history, 'the recorded run is listed');
  history.props.onClick();
  tree = await renderWithEffects(view, request, 10);
  assert.ok(sent.some(payload => payload.action === 'read' && payload.runId), 'opening a run reads its evidence');

  findButton(tree, '把这次运行存为剧本').props.onClick();
  tree = await renderWithEffects(view, request, 12);
  const drafted = sent.find(payload => payload.action === 'draft');
  assert.ok(drafted, 'one click was enough to ask for the draft');
  assert.equal(drafted.name, undefined, 'no directory name was typed');
  assert.equal(drafted.title, undefined, 'no title was typed either');
  assert.equal(drafted.runId, '20261111T034212-b4fa63aa46fe', 'only the run it came from');
  const text = collect(tree, []).join(' ');
  assert.match(text, /已沉淀为 station-lifecycle-observed/, 'the notice reports where it went');
  assert.match(text, /2 步/, 'and how many expectations came from observation');
  assert.match(text, /工作站生命周期（沉淀）/, 'the drafted play is selected in the list');
});

test('the one sentence also opens an agent session that receives the goal', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const created = [];
  const prompted = [];
  const view = loadView(source, {
    remote: {
      session: {
        create: async (request, signal) => { created.push({ request, hasSignal: signal !== undefined }); return { ok: true, value: { sessionId: 'session-new-1' } }; },
        prompt: async (request, signal) => { prompted.push({ request, hasSignal: signal !== undefined }); return { ok: true, value: { accepted: true } }; }
      }
    }
  });
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const request = async (sessionId, payload) => {
    if (payload.action === 'create') {
      fixtures.catalog.plays.push({ slug: 'guard-play', name: payload.title, description: '', mode: 'explore', steps: 0, scenarios: [] });
      return { ok: true, slug: 'guard-play', title: payload.title, target: 'local', targetInferred: true,
        path: '.test-plays/guard-play', files: [], next: '' };
    }
    return fixtures[payload.action];
  };

  let tree = await renderWithEffects(view, request);
  findButton(tree, '新建剧本').props.onClick();
  tree = await renderWithEffects(view, request);
  findInput(tree, '你要验证什么？').props.onChange({ target: { value: '工作站下线后不应继续接单' } });
  tree = await renderWithEffects(view, request);
  findButton(tree, '创建').props.onClick();
  tree = await renderWithEffects(view, request, 14);

  assert.equal(created.length, 1, 'exactly one session was created');
  // Field-by-field: the view builds payloads inside the vm realm, so prototype-sensitive
  // deepEqual would fail on a value that is actually right.
  assert.equal(created[0].request.cwd, REPO, 'the new session owns the repository under test');
  assert.deepEqual(Object.keys(created[0].request), ['cwd'], 'and nothing else is claimed about it');
  assert.equal(prompted.length, 1, 'the goal was handed over');
  const body = prompted[0].request;
  assert.equal(body.sessionId, 'session-new-1', 'it prompted the session just created, not this one');
  assert.equal(body.mode, 'queue');
  assert.ok(body.requestId && body.requestId.startsWith('playtest-'), 'a client-minted id keeps the prompt idempotent');
  assert.match(body.content[0].text, /工作站下线后不应继续接单/, "the user's sentence is the goal");
  assert.ok(body.content[0].text.includes(`${REPO}/.test-plays/guard-play`), 'and which play to fill in');
  assert.match(body.content[0].text, /不要猜|do not guess/, 'the handoff carries the no-guessing constraint');
  assert.match(body.content[0].text, /不要自行发起会打到真实系统的播放|do not start a run that/, 'and the no-self-play rule');
  assert.match(collect(tree, []).join(' '), /已创建 guard-play，并另起会话/, 'the view says where it went');
});

test('a build without the session namespace still creates and states the next step', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const view = loadView(source);                  // no remote.session here
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const request = async (sessionId, payload) => {
    if (payload.action === 'create') {
      fixtures.catalog.plays.push({ slug: 'offline-guard', name: payload.title, description: '', mode: 'explore', steps: 0, scenarios: [] });
      return { ok: true, slug: 'offline-guard', title: payload.title, target: 'local', path: '.test-plays/offline-guard', next: '' };
    }
    return fixtures[payload.action];
  };
  let tree = await renderWithEffects(view, request);
  findButton(tree, '新建剧本').props.onClick();
  tree = await renderWithEffects(view, request);
  findInput(tree, '你要验证什么？').props.onChange({ target: { value: '下线后不应继续接单' } });
  tree = await renderWithEffects(view, request);
  findButton(tree, '创建').props.onClick();
  tree = await renderWithEffects(view, request, 12);
  const text = collect(tree, []).join(' ');
  assert.match(text, /已创建 offline-guard/, 'the skeleton is still created');
  assert.match(text, /让 agent 说一句/, 'and the next step is stated instead of failing silently');
});

test('a throwing Remote namespace still creates the skeleton instead of blanking', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const view = loadView(source, {
    remote: {
      get session() { throw new Error('cannot get property "remote.session" without inject'); }
    }
  });
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const request = async (sessionId, payload) => {
    if (payload.action === 'create') {
      fixtures.catalog.plays.push({ slug: 'probe-play', name: payload.title, description: '', mode: 'explore', steps: 0, scenarios: [] });
      return { ok: true, slug: 'probe-play', title: payload.title, target: 'local', path: '.test-plays/probe-play', next: '' };
    }
    return fixtures[payload.action];
  };
  let tree = await renderWithEffects(view, request);
  findButton(tree, '新建剧本').props.onClick();
  tree = await renderWithEffects(view, request);
  findInput(tree, '你要验证什么？').props.onChange({ target: { value: '下线后不应继续接单' } });
  tree = await renderWithEffects(view, request);
  findButton(tree, '创建').props.onClick();
  tree = await renderWithEffects(view, request, 12);
  const text = collect(tree, []).join(' ');
  assert.match(text, /已创建 probe-play/, 'the probe swallowed the host error and the button still worked');
  assert.match(text, /让 agent 说一句/, 'and it fell back to telling the user the next step');
});

test('the handoff matches the argument count the Remote face actually declares', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const seen = { create: [], prompt: [] };
  // Plain functions so `arguments.length` reports what the view really passed — the bug was
  // calling session.create(request, signal) against a one-parameter face.
  const session = {
    create: async function create(request) { seen.create.push({ args: arguments.length, request }); return { ok: true, value: { sessionId: 'session-arity-1' } }; },
    prompt: async function prompt(request, signal) { seen.prompt.push({ args: arguments.length, request }); return { ok: true, value: { accepted: true } }; }
  };
  const view = loadView(source, { remote: { session } });
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const request = async (sessionId, payload) => {
    if (payload.action === 'create') {
      fixtures.catalog.plays.push({ slug: 'arity-play', name: payload.title, description: '', mode: 'explore', steps: 0, scenarios: [] });
      return { ok: true, slug: 'arity-play', title: payload.title, path: '.test-plays/arity-play', next: '' };
    }
    return fixtures[payload.action];
  };
  let tree = await renderWithEffects(view, request);
  findButton(tree, '新建剧本').props.onClick();
  tree = await renderWithEffects(view, request);
  findInput(tree, '你要验证什么？').props.onChange({ target: { value: '下线后不应继续接单' } });
  tree = await renderWithEffects(view, request);
  findButton(tree, '创建').props.onClick();
  await renderWithEffects(view, request, 14);

  assert.equal(seen.create[0].args, 1, 'a one-parameter face must be called with one argument');
  assert.equal(seen.create[0].request.cwd, REPO);
  assert.equal(seen.prompt[0].args, 2, 'a two-parameter face keeps its signal');
  assert.equal(seen.prompt[0].request.sessionId, 'session-arity-1');
});

test('an arity rejection is retried once with the count the gateway asked for', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const attempts = [];
  const session = {
    // Declares two parameters but the gateway only accepts one: exactly what a stale
    // generated face looks like from the caller's seat.
    create: async function create(request, signal) {
      attempts.push(arguments.length);
      if (arguments.length > 1) throw new Error('client api: session/create expected 1 argument(s), got 2');
      return { ok: true, value: { sessionId: 'session-retried' } };
    },
    prompt: async function prompt(request) { attempts.push('prompt:' + arguments.length); return { ok: true, value: { accepted: true } }; }
  };
  const view = loadView(source, { remote: { session } });
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const request = async (sessionId, payload) => {
    if (payload.action === 'create') return { ok: true, slug: 'retry-play', title: payload.title, path: '.test-plays/retry-play', next: '' };
    return fixtures[payload.action];
  };
  let tree = await renderWithEffects(view, request);
  findButton(tree, '新建剧本').props.onClick();
  tree = await renderWithEffects(view, request);
  findInput(tree, '你要验证什么？').props.onChange({ target: { value: '下线后不应继续接单' } });
  tree = await renderWithEffects(view, request);
  findButton(tree, '创建').props.onClick();
  tree = await renderWithEffects(view, request, 16);

  assert.deepEqual(attempts.slice(0, 2), [2, 1], 'it asked once, honoured the count, and stopped asking');
  assert.equal(attempts.filter(item => item === 2 || item === 1).length, 2, 'no retry loop');
  assert.match(collect(tree, []).join(' '), /已创建 retry-play/, 'the handoff still completed');
});

test('a failed run hands its evidence over, with rules against making it green', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const created = [];
  const prompted = [];
  const view = loadView(source, {
    remote: {
      session: {
        create: async (request) => { created.push(request); return { ok: true, value: { sessionId: 'session-analyse-1' } }; },
        prompt: async (request) => { prompted.push(request); return { ok: true, value: { accepted: true } }; }
      }
    }
  });
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  const openRun = async (read, rounds = 14) => {
    let tree = await renderWithEffects(view, async (sessionId, payload) => {
      if (payload.action === 'read') return read;
      if (payload.action === 'runs') return fixtures.runs;
      if (payload.action === 'catalog') return fixtures.catalog;
      return fixtures[payload.action];
    });
    const refresh = findInSection(tree, '运行历史',
      node => typeof node.props?.onClick === 'function' && collect(node, []).join(' ').includes('刷新'));
    refresh.props.onClick();
    tree = await renderWithEffects(view, async (sessionId, payload) => {
      if (payload.action === 'read') return read;
      if (payload.action === 'runs') return fixtures.runs;
      if (payload.action === 'catalog') return fixtures.catalog;
      return fixtures[payload.action];
    }, 6);
    findRunButton(tree).props.onClick();
    return renderWithEffects(view, async (sessionId, payload) => {
      if (payload.action === 'read') return read;
      if (payload.action === 'runs') return fixtures.runs;
      if (payload.action === 'catalog') return fixtures.catalog;
      return fixtures[payload.action];
    }, rounds);
  };

  // A run that passed offers nothing to analyse.
  let tree = await openRun(JSON.parse(JSON.stringify(FIXTURES.read)));
  assert.equal(findButton(tree, '让 agent 分析这次失败'), null, 'a passed run does not offer analysis');

  const failed = JSON.parse(JSON.stringify(FIXTURES.read));
  failed.verdict = 'failed';
  failed.name = '工作站生命周期';
  failed.artifacts = { runDir: '.test-plays/runs/20261111T034212-b4fa63aa46fe' };
  failed.steps = [
    { phase: 'play', play: 'station-lifecycle', stepNo: 1, name: '停止接单', status: 'passed' },
    { phase: 'play', play: 'station-lifecycle', stepNo: 2, name: '恢复接单', status: 'failed',
      error: '期望 $.success=true，实际 false' }
  ];
  tree = await openRun(failed);
  const button = findButton(tree, '让 agent 分析这次失败');
  assert.ok(button, 'the failing run offers the handover');
  button.props.onClick();
  tree = await renderWithEffects(view, async (sessionId, payload) => {
    if (payload.action === 'read') return failed;
    if (payload.action === 'runs') return fixtures.runs;
    if (payload.action === 'catalog') return fixtures.catalog;
    return fixtures[payload.action];
  }, 14);

  // Field checks: the payload was built inside the vm realm, so a host-realm object
  // literal would differ in prototype while being the same data.
  assert.equal(created.length, 1, 'exactly one analysis session was created');
  assert.equal(created[0].cwd, REPO, 'it owns the repository under test');
  assert.deepEqual(Object.keys(created[0]), ['cwd']);
  assert.equal(prompted.length, 1);
  assert.equal(prompted[0].sessionId, 'session-analyse-1', 'it prompts the session it just created');
  const text = prompted[0].content[0].text;
  assert.match(text, /20261111T034212-b4fa63aa46fe/, 'the runId is handed over, not just a complaint');
  assert.match(text, /恢复接单.*failed/s, 'and which step broke');
  assert.match(text, /期望 \$\.success=true，实际 false/, 'with the assertion message itself');
  assert.match(text, /\.test-plays\/runs\//, 'pointing at the evidence directory');
  assert.match(text, /放宽或删除断言/, 'naming the temptation it must resist');
  assert.match(text, /把预期改成实际值/);
  assert.match(text, /不要自己发起会打到真实系统的播放/, 'and leaving the replay click to the user');
  assert.match(text, /剧本或断言写错|环境或夹具|真实业务缺陷/, 'offering exactly three causes to choose between');
  assert.match(collect(tree, []).join(' '), /已把这次失败交给新会话分析/, 'the view confirms where it went');
});

test('a bare translator reference inside a module-scope helper is caught', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // Regression guard for the exact failure mode: `t` is not in scope at module level.
  assert.match(source, /function named\(t, prefix, value, fallback\)/, 'the helper must take the translator as a parameter');
  const calls = source.replace('function named(t, prefix, value, fallback)', 'function named_definition');
  const offenders = [...calls.matchAll(/named\((?!t,)/g)].length;
  assert.equal(offenders, 0, 'every named() call must pass the translator explicitly');
});
