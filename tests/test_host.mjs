import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PlaytestOperations, exitFacts, lossless } from '../host.js';
import { apply } from '../index.js';

function fixture({mode='workspace-write', contained=true, effects=false}={}) {
  const calls=[];
  const ctx={ get:()=>undefined };
  const ops=new PlaytestOperations(ctx);
  const env={agent:{id:'s1'},repoRoot:'/work/repo',policy:{mode},rootTarget:{},target:{},
    fs:{contains:()=>contained},signal:new AbortController().signal,
    approval:{request:async()=>{calls.push('approval');return 'allowed-once';}}};
  ops.environment=async()=>env;
  ops.preview=async()=>({ok:true,digest:'abc',requiresConfirmation:effects,effects:effects?[{kind:'http',target:'local'}]:[]});
  let finish;
  ops.spawn=async(_env, request, event)=>{
    calls.push(request);
    const done=new Promise(resolve=>{finish=resolve;});
    const handle={terminate:()=>{calls.push('terminate');finish({ok:false,status:'cancelled',verdict:'inconclusive',execution:'cancelled',cleanup:'completed'});}};
    return {handle,done,enforcement:'full'};
  };
  return {ops,env,calls,finish:value=>finish(value)};
}

test('creating assets obeys the same file sandbox as playing',async()=>{
  const ro=fixture({mode:'read-only'});
  const blockedA=await ro.ops.perform({id:'s1'},{action:'create',repoRoot:'/work/repo',name:'a',title:'标题'},{caller:'agent'});
  assert.equal(blockedA.ok,false,'read-only must not create assets');
  assert.match(blockedA.error,/read-only/);
  const blockedB=await ro.ops.perform({id:'s1'},{action:'draft',repoRoot:'/work/repo',runId:'20261111T1-abcdef012345',name:'a'},{caller:'agent'});
  assert.match(blockedB.error,/read-only/);
  const escaped=fixture({contained:false});
  const blockedC=await escaped.ops.perform({id:'s1'},{action:'create',repoRoot:'/work/repo',name:'a',title:'标题'},{caller:'agent'});
  assert.match(blockedC.error,/outside/,'a repository outside the workspace cannot be written either');
});
test('read-only cannot start or escalate permissions',async()=>{
  const f=fixture({mode:'read-only'});
  await assert.rejects(()=>f.ops.start(f.env,{play:'a'},'agent'),/read-only/);
  assert.equal(f.calls.length,0);
});
test('repository escaping workspace cannot start',async()=>{
  const f=fixture({contained:false});
  await assert.rejects(()=>f.ops.start(f.env,{play:'a'},'agent'),/outside/);
});
test('stale preview blocks before spawning',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.ops.start(f.env,{play:'a',expectedDigest:'old'},'user'),/changed/);
  assert.equal(f.calls.length,0);
});
test('agent cannot self-authorize with a flag',async()=>{
  const f=fixture({effects:true});
  f.env.approval.request=async()=>{f.calls.push('rejected');return 'rejected';};
  await assert.rejects(()=>f.ops.start(f.env,{play:'a',userConfirmedEffects:true},'agent'),/not approved/);
  assert.deepEqual(f.calls,['rejected']);
});
test('a human start is granted by clicking, but only for the reviewed digest',async()=>{
  const f=fixture({effects:true});
  // No extra checkbox: the click itself is the grant, yet it must still name the
  // snapshot the user was shown.
  await assert.rejects(()=>f.ops.start(f.env,{play:'a'},'user'),/reviewed snapshot digest/);
  const result=await f.ops.start(f.env,{play:'a',expectedDigest:'abc'},'user');
  assert.equal(result.ok,true);
  assert.equal(f.calls[0].allowEffects,true);
  f.finish({ok:true,status:'completed',verdict:'passed',execution:'completed',cleanup:'completed'});
  await f.ops.runs.get(result.runId).done;
});
test('own-mock run does not ask approval; returns identifier immediately',async()=>{
  const f=fixture();
  const started=await f.ops.start(f.env,{play:'a'},'agent');
  assert.equal(started.status,'running');
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].expectedDigest,'abc');
  assert.equal(f.calls[0].ownerSessionId,'s1');
  await f.ops.cancel(f.env,{runId:started.runId});
  await f.ops.runs.get(started.runId).done;
  assert.equal((await f.ops.read(f.env,{runId:started.runId})).cleanup,'completed');
});
test('one active run per repository and other sessions cannot cancel/read',async()=>{
  const f=fixture();
  const started=await f.ops.start(f.env,{play:'a'},'agent');
  await assert.rejects(()=>f.ops.start(f.env,{play:'b'},'agent'),/already active/);
  const other={...f.env,agent:{id:'s2'}};
  await assert.rejects(()=>f.ops.read(other,{runId:started.runId}),/owned/);
  await assert.rejects(()=>f.ops.cancel(other,{runId:started.runId}),/owned/);
  await f.ops.cancel(f.env,{runId:started.runId});
  await f.ops.dispose();
});
test('event read is bounded and reports omitted range',()=>{
  const f=fixture();
  const r={events:[],steps:[],count:0};
  for(let i=0;i<400;i++) f.ops.recordEvent(r,{type:'assertion',seq:i});
  assert.equal(r.events.length,300);
  assert.equal(r.count,400);
});
test('permission change during approval blocks execution',async()=>{
  const f=fixture({effects:true});
  f.env.approval.request=async()=>{f.env.policy={mode:'read-only'};return 'allowed-once';};
  await assert.rejects(()=>f.ops.start(f.env,{play:'a'},'agent'),/read-only/);
  assert.equal(f.calls.length,0);
});
test('plugin unload during approval does not spawn late work',async()=>{
  const f=fixture({effects:true});
  f.env.approval.request=async()=>{await f.ops.dispose();return 'allowed-once';};
  await assert.rejects(()=>f.ops.start(f.env,{play:'a'},'agent'),/unloaded/);
  assert.equal(f.calls.length,0);
});
test('step events preserve phase and play identities',()=>{
  const f=fixture();const r={events:[],steps:[],count:0};
  f.ops.recordEvent(r,{type:'step_started',phase:'play',play:'a',step:{stepNo:1,name:'A',type:'http'}});
  f.ops.recordEvent(r,{type:'step_started',phase:'play',play:'b',step:{stepNo:1,name:'B',type:'http'}});
  f.ops.recordEvent(r,{type:'step_finished',phase:'play',play:'a',step:{stepNo:1,name:'A',status:'passed',ok:true}});
  assert.equal(r.steps.length,2);
  assert.equal(r.steps[0].status,'passed');
  assert.equal(r.steps[1].status,'running');
});
test('lossless guards bigint, non-finite, oversized text and circular structures',()=>{
  const safe=lossless({big:10n, weird:Infinity, keep:'value', long:'y'.repeat(70000)});
  assert.equal(safe.big,'10');
  assert.equal(safe.weird,'Infinity');
  assert.equal(safe.keep,'value');
  assert.equal(safe.long.length, 65536 + '…[host truncated]'.length);
  assert.match(safe.long, /host truncated\]$/);
  const circular={name:'evidence'}; circular.self=circular;
  const lost=lossless({runId:'r1',steps:[circular]});
  assert.equal(lost.ok,false);
  assert.match(lost.error,/JSON-safe/);
  assert.equal(lost.runId,'r1');
});
test('outcome never leaks live handles into returnable values',()=>{
  const outcome={exitCode:0,signal:null,stdout:{pipe:true},stderr:{pipe:true},close(){}};
  assert.deepEqual(exitFacts(outcome),{exitCode:0,signal:null});
  assert.deepEqual(exitFacts({stdout:{}}),{exitCode:null,signal:null});
});
test('perform sanitizes run output at the tool and UI boundary',async()=>{
  const f=fixture();
  const started=await f.ops.start(f.env,{play:'a'},'agent');
  const record=f.ops.runs.get(started.runId);
  record.result={ok:true,runId:started.runId,ownerSessionId:'s1',verdict:'inconclusive',
    execution:'completed',cleanup:'completed',steps:[{big:10n,weird:Infinity}]};
  try {
    const value=await f.ops.perform({id:'s1',session:{},ctx:{}},{action:'read',runId:started.runId});
    assert.equal(value.ok,true);
    assert.equal(value.steps[0].big,'10');
    assert.equal(value.steps[0].weird,'Infinity');
  } finally {
    await f.ops.cancel(f.env,{runId:started.runId});
    await record.done;
  }
});
test('client declares the traced commands namespace dependency',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.match(source,/inject:\s*\[[^\]]*['"]remote['"][^\]]*['"]remote\.commands['"]/);
});
test('every Remote namespace the view touches is declared in inject',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  // An undeclared Remote face throws at read time and blanks the whole panel; this bit
  // twice (remote.commands, then remote.session), so it is now an assertion not a memory.
  const declared=(source.match(/inject: \[([^\]]*)\]/)||[,''])[1];
  const used=new Set();
  for (const m of source.matchAll(/\bremote\.([a-zA-Z][\w-]*)/g)) used.add('remote.'+m[1]);
  for (const m of source.matchAll(/remoteNamespace\(ctx\.remote,\s*'([\w-]+)'\)/g)) used.add('remote.'+m[1]);
  assert.ok(used.size>=2,'the scan should find the faces the view actually reads');
  const missing=[...used].filter(ns=>!declared.includes(`'${ns}'`));
  assert.deepEqual(missing,[],'undeclared Remote namespaces would blank the view');
});
test('the workspace action reports the session workspace, not the repository',()=>{
  const source=readFileSync(new URL('../host.js',import.meta.url),'utf8');
  assert.match(source,/case 'workspace':/,'the view can ask where to open a handoff session');
  assert.match(source,/workspaceRoot: env\.policy\.workspaceRoot/,'it reports the session workspace root');
  const client=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.match(client,/const cwd = goal\.workspaceRoot \|\| goal\.repoRoot;/,'and the handoff prefers it over the repository');
  assert.match(client,/await ensureWorkspace\(\);/,'it is fetched before any session is created');
});
test('creating a play asks one question and saving a run asks none',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.match(source,/button\(t\('newPlay'\), createForm/,'the toolbar offers a new-play entry');
  assert.match(source,/setForm\(\{ mode: 'create', title: '' \}\)/,'the form carries exactly one field');
  const form=source.slice(source.indexOf("form ? h('section'"),source.indexOf("catalog && catalog.repoRoot"));
  assert.equal((form.match(/h\('input'/g)||[]).length,1,'one input, not a form to fill out');
  assert.ok(!/createName|createTarget|createNote/.test(source),'the derived fields must be gone from the view');
  assert.match(form,/onKeyDown: event => \{ if \(event\.key === 'Enter'/,'Enter submits');
  assert.match(form,/!form\.title\.trim\(\)/,'an empty sentence cannot be submitted');
  assert.match(source,/call\('draft', \{ \.\.\.options\(\), runId \}\)/,'saving a run sends only the run it came from');
  assert.match(source,/button\(t\('saveAsPlay'\), draftPlay, !!busy \|\| !runId/,'and it is one click, not a form');
});

test('the view has no confirmation checkbox and pins start to the digest',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.ok(!/pt-confirm/.test(source),'the effect-confirmation checkbox row is gone');
  assert.ok(!/userConfirmedEffects/.test(source),'the view never claims a confirmation flag');
  assert.match(source,/expectedDigest: digest/,'start still pins the reviewed snapshot');
});
test('repository is a dropdown and the nested-repo chooser is gone',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.match(source,/h\('select',\s*\{[\s\S]{0,200}?onChange:[\s\S]{0,120}?selectRepo/,
    'repository must be chosen from a select that reloads the catalog');
  assert.match(source,/call\('repos'/, 'the view must load Git repositories on mount');
  assert.ok(!/repoCandidates|repoHint/.test(source), 'free-form repository input and nested chooser must be removed');
});
test('start action sits above preview details and preview is automatic',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  const bar=source.indexOf('pt-actionbar');
  const start=source.indexOf("button(t('start')");
  const details=source.indexOf("t('inspectDetails')");
  assert.ok(bar>0&&start>bar&&details>start,'start must render in the action bar above the preview body');
  assert.match(source,/inspect\(selected, \{ auto: true \}\)/,'selection must trigger an automatic preview');
  const previewButton=/button\(t\('preview'\),[^)]*\)/.exec(source);
  assert.ok(!previewButton||/!validPreview/.test(source.slice(Math.max(0,previewButton.index-120),previewButton.index+10)),
    'a preview button may only exist as a conditional retry');
});
test('a run opens in its own tab and phases are grouped in order',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.match(source,/role: 'tablist'/,'the view exposes a tab strip');
  assert.match(source,/'data-tab': tab/,'panels switch with the selected tab');
  assert.match(source,/\.pt-view\[data-tab=run\] \.pt-only-work[^}]*display:none/,'preparation and preview hide while watching a run');
  const choose=source.slice(source.indexOf('const chooseRun'),source.indexOf('const chooseRun')+220);
  assert.match(choose,/setTab\('run'\)/,'opening a run switches to the run tab');
  const phases=(source.match(/const RUN_PHASES = \[.*\];/)||[''])[0];
  const order=['prepare','setup','play','cleanup'].map(name=>phases.indexOf("'"+name+"'"));
  assert.ok(phases&&order.every(i=>i>=0)&&order.every((i,k)=>k===0||i>order[k-1]),'run steps group as prepare → setup → play → cleanup');
  assert.match(source,/h\(RunSteps, \{ steps, t \}\)/,'the run panel renders grouped phases, not a flat list');
});
test('every dictionary key exists in Chinese too, and no raw key can leak',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  const vm=createRequire(import.meta.url)('vm');
  const start=source.indexOf('const en = {');
  const stop=source.indexOf('};',source.indexOf('const zh = {'));
  const ctx={};vm.createContext(ctx);
  vm.runInContext(source.slice(start,stop+2).replace(/const (en|zh) =/g,'var $1 =')+';this.en=en;this.zh=zh;',ctx);
  const en=Object.keys(ctx.en), zh=new Set(Object.keys(ctx.zh));
  assert.deepEqual(en.filter(k=>!zh.has(k)),[],'keys present in English must have a Chinese entry');
  // dynamic lookups: type./phase./effect./state./mode./event. must never print the raw key
  assert.match(source,/function named\(t, prefix, value, fallback\)/,'the label helper takes the translator explicitly');
  assert.match(source,/translated === prefix \+ text \? \(fallback != null \? fallback : text\)/,
    'an unknown value falls back to the engine value, not to "playtest-ui.type.foo"');
  assert.match(source,/named\(t, 'type\.', step\.type \|\| 'http'\)/,'action types render in Chinese');
  assert.match(source,/named\(t, 'effect\.', item\.code, item\.kind \|\| 'effect'\)/,'expected effects render as rows, not raw JSON');
  assert.match(source,/"code": "http\.external"|effect\.http\.external/,'effects carry a stable machine code for localization');
});
test('long scene notes never stretch the list; they open on hover or focus',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  const from=source.indexOf("className: 'pt-list'");
  const list=source.slice(from,source.indexOf("t(plays.length ? 'noMatches'",from));
  assert.ok(!/h\('p', null, play\.description/.test(list),'catalog rows must not inline the description');
  assert.match(list,/'data-text': play\.description/,'the row carries its note for the popup');
  assert.match(list,/onMouseEnter: showTip, onMouseLeave: hideTip/,'mouse opens and closes the popup');
  assert.match(list,/onFocus: showTip, onBlur: hideTip/,'keyboard focus does the same');
  assert.match(source,/className: 'pt-tip', role: 'tooltip'/,'a single popup element renders the note');
  assert.match(source,/position:fixed[^}]*pointer-events:none/,'the popup floats without stealing hover or layout space');
  assert.match(source,/h\('details', \{ className: 'pt-desc' \}/,'preview notes stay collapsed instead of filling the column');
});
test('repository labels and step rows carry no counters',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.ok(!/plays \? ' · '/.test(source),'the repository label must not append a play count');
  assert.ok(!/step\.assertions \|\| 0/.test(source),'preview rows must not show an assertion count');
  assert.ok(!/checkSummary|included:/.test(source),'no check-count summary remains');
});
test('verifications render inside their step, never as their own row',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.match(source,/function checksOf\(step\)/,'steps expose their embedded checks');
  assert.match(source,/className: 'pt-checks'/,'checks render in the owning step cell');
  // The table body must stay one row per step: no second map over checks.
  const body=source.slice(source.indexOf('function StepTable'), source.indexOf('function mergeEvents'));
  assert.equal((body.match(/steps\.map\(/g)||[]).length,1,'one row per business step');
  assert.ok(!/checks\.map\([^)]*\)\s*=>\s*h\('tr'/.test(body),'checks must not become table rows');
});
test('all tool schemas omit user confirmation authority',()=>{
  const definitions=[];const commands=[];const skill=[];
  const ctx={get:()=>undefined,effect:()=>()=>{},provide:()=>()=>{},
    tools:{register:d=>{definitions.push(d);return()=>{};}},
    skills:{register:d=>{skill.push(d);return()=>{};}},commands:{register:d=>{commands.push(d);return()=>{};}}};
  apply(ctx,{});
  assert.equal(definitions.length, 6, 'catalog/repos/run/suite/lint/new-play/save-play');
  assert.equal(commands[0].name,'playtest');
  assert.equal(skill[0].name,'playtest');
  assert.ok(definitions.every(d=>!Object.hasOwn(d.parameters.properties,'userConfirmedEffects')));
  assert.ok(definitions.every(d=>d.output.schema.type==='object'));
  const draft = definitions.find(d => d.name === 'playtest_save_play').output.render;
  assert.match(draft({}, { ok: true, slug: 'probe-observed', stepCount: 2, draftedSteps: 1 })[0].text,
    /probe-observed/, 'a drafted play renders as data, not as a crash');
  assert.match(draft({}, { ok: false, error: 'Play directory already exists' })[0].text,
    /already exists/, 'a refused create surfaces its reason');
  const run = definitions.find(d => d.name === 'playtest').output.render;
  assert.match(run({}, { ok: true, runId: 'r1', status: 'completed',
    steps: [{ phase: 'play', stepNo: 1, name: '停止接单', status: 'passed' }] })[0].text,
    /停止接单/, 'run results still render step lines');
});

