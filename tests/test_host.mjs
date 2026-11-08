import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlaytestOperations, exitFacts } from '../host.js';
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
test('user effects require explicit confirmation and reviewed digest',async()=>{
  const f=fixture({effects:true});
  await assert.rejects(()=>f.ops.start(f.env,{play:'a',userConfirmedEffects:true},'user'),/confirm/);
  const result=await f.ops.start(f.env,{play:'a',userConfirmedEffects:true,expectedDigest:'abc'},'user');
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
test('run output stays JSON-safe for bigints, non-finite and oversized text',async()=>{
  const f=fixture();
  const started=await f.ops.start(f.env,{play:'a'},'agent');
  const record=f.ops.runs.get(started.runId);
  record.result={ok:true,runId:started.runId,ownerSessionId:'s1',verdict:'passed',execution:'completed',
    cleanup:'completed',steps:[{big:10n,weird:Infinity,keep:'value',long:'y'.repeat(70000)}]};
  const safe=await f.ops.read(f.env,{runId:started.runId});
  assert.equal(safe.steps[0].keep,'value');
  assert.equal(safe.steps[0].big,'10');
  assert.equal(safe.steps[0].weird,'Infinity');
  assert.match(safe.steps[0].long,/host truncated$/);
  const circular={name:'evidence'}; circular.self=circular;
  record.result={ok:true,runId:started.runId,ownerSessionId:'s1',steps:[circular]};
  const lost=await f.ops.read(f.env,{runId:started.runId});
  assert.equal(lost.ok,false);
  assert.match(lost.error,/JSON-safe/);
  await f.ops.cancel(f.env,{runId:started.runId});
  await record.done;
});
test('outcome never leaks live handles into returnable values',()=>{
  const outcome={exitCode:0,signal:null,stdout:{pipe:true},stderr:{pipe:true},target:Symbol('t'),close(){}};
  assert.deepEqual(exitFacts(outcome),{exitCode:0,signal:null});
  const missing=exitFacts({stdout:{}});
  assert.deepEqual(missing,{exitCode:null,signal:null});
});
test('client declares the traced commands namespace dependency',()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
  assert.match(source,/inject:\s*\[[^\]]*['"]remote['"][^\]]*['"]remote\.commands['"]/);
});
test('all tool schemas omit user confirmation authority',()=>{
  const definitions=[];const commands=[];const skill=[];
  const ctx={get:()=>undefined,effect:()=>()=>{},provide:()=>()=>{},
    tools:{register:d=>{definitions.push(d);return()=>{};}},
    skills:{register:d=>{skill.push(d);return()=>{};}},commands:{register:d=>{commands.push(d);return()=>{};}}};
  apply(ctx,{});
  assert.equal(definitions.length,5);
  assert.equal(commands[0].name,'playtest');
  assert.equal(skill[0].name,'playtest');
  assert.ok(definitions.every(d=>!Object.hasOwn(d.parameters.properties,'userConfirmedEffects')));
  assert.ok(definitions.every(d=>d.output.schema.type==='object'));
});
