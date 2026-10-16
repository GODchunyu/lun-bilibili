import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BiliError, dayStart, limitsSchema, topicSchema, type Bilibili, type OrdinaryComment, type PostReceipt, type Video } from '../server/model.js';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { keywordMatchesTitle } from '../server/bilibili.js';

const start = Date.parse('2026-10-14T08:00:00Z');
class Fake implements Bilibili {
  loggedIn = true; videos: Video[] = []; replies: OrdinaryComment[] = []; writes: Array<{ bvid:string;text:string;rpid:number;operationId:string }> = [];
  postError?: BiliError; status: 'not_found'|'running'|'succeeded'|'confirmed_failure'|'uncertain'|'interrupted' = 'not_found'; searches = 0; reads = 0;
  async checkLogin() { return { loggedIn:this.loggedIn, uid:'100', username:'fake', message:this.loggedIn?'已登录':'未登录' }; }
  async search() { this.searches++; return this.videos; }
  async comments() { this.reads++; return this.replies; }
  async post(bvid:string,text:string,rpid=0,operationId='') { this.writes.push({bvid,text,rpid,operationId}); if(this.postError)throw this.postError; return undefined as unknown as PostReceipt; }
  async operationStatus() { return { status:this.status }; }
  async tools() { return []; } async qrStart() { return {status:'',message:'',qrcode_image:''}; } async qrCheck() { return {message:''}; } async resetSession() {}
}
function setup(random=()=>0, store=new Store(':memory:')) {
  let now=start; const bili=new Fake();
  const s=store.settings();s.limits=limitsSchema.parse({waitMin:1,waitMax:1});store.saveSettings(s);
  const id=store.saveTopic(topicSchema.parse({name:'测试频道',enabled:false,keywords:['建筑','猫 cat'],intervalMin:1,intervalMax:1}));
  store.saveTemplate({topicId:id,kind:'comment',text:'评论模板',enabled:true});store.saveTemplate({topicId:id,kind:'reply',text:'回复模板',enabled:true});
  store.saveTopic({...store.topic(id)!,enabled:true},id);
  const scheduler=new Scheduler(store,bili,()=>now,random); return {store,bili,scheduler,id,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
const video=(bvid:string,aid:number,title:string,author='普通UP'):Video=>({bvid,aid,title,author,play:0,pubdate:1});

test('scheduler status exposes startup pause, current time, and the next interaction',async()=>{
  const f=setup();
  try {
    const initial=f.scheduler.status();
    assert.equal(initial.phase,'paused');assert.equal(initial.reasonCode,'startup_paused');assert.equal(initial.pauseRequested,false);assert.equal(initial.inFlight,false);assert.equal(initial.serverNow,f.now());
    f.bili.videos=[video('BV1000000001',1,'建筑')];
    await f.scheduler.run();assert.notEqual(f.scheduler.status().phase,'paused');
    await f.scheduler.tick();
    const plan=f.store.interactionPlans()[0];const status=f.scheduler.status();
    assert.equal(status.phase,'waiting_plan');assert.equal(status.nextAction.kind,'interaction');assert.equal(status.nextAction.at,plan.dueAt);assert.equal(status.serverNow,f.now());
    await f.scheduler.pause('手动暂停');const paused=f.scheduler.status();assert.equal(paused.phase,'paused');assert.equal(paused.reasonCode,'manual_paused');assert.equal(paused.reason,'手动暂停');
  } finally {await f.scheduler.close();f.store.close();}
});

test('patrol matches titles only locally and ignores old age/play filters',async()=>{
  const f=setup();f.bili.videos=[video('BV1000000001',1,'建筑教程','无关UP'),video('BV1000000002',2,'完全无关','建筑达人'),video('BV1000000003',3,'完全无关','别的UP'),video('BV1000000004',4,'建','筑')];
  await f.scheduler.run();await f.scheduler.tick();
  const plans=f.store.interactionPlans();assert.equal(plans.length,1);assert.deepEqual(plans.map(p=>p.bvid),['BV1000000001']);assert.equal(plans[0].matchedField,'title');assert.equal(f.bili.searches,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM discoveries').get()?.n,1);
  await f.scheduler.close();f.store.close();
});

test('title keyword matching preserves normalization and ASCII word boundaries',()=>{
  assert.equal(keywordMatchesTitle('游戏','游 戏！'),true);
  assert.equal(keywordMatchesTitle('cat','ＣＡＴ!'),true);
  assert.equal(keywordMatchesTitle('cat','concatenate'),false);
  assert.equal(keywordMatchesTitle('123','12345'),false);
});

test('new plans save a fixed action and template snapshot with deferred capacity date',async()=>{
  const f=setup(()=>0);f.bili.videos=[video('BV1000000001',1,'建筑')];await f.scheduler.run();await f.scheduler.tick();const plan=f.store.interactionPlans()[0];assert.equal(plan.deferred,true);assert.equal(plan.plannedAction,'comment');assert.deepEqual(plan.commentTemplates,['评论模板']);assert.deepEqual(plan.replyTemplates,['回复模板']);assert.ok(plan.dueAt>=start+86400000);const before=plan.dueAt;f.store.saveTemplate({topicId:f.id,kind:'comment',text:'后来修改',enabled:true});assert.equal(f.store.interactionPlan(plan.id)?.commentTemplates[0],'评论模板');assert.equal(f.store.interactionPlan(plan.id)?.dueAt,before);await f.scheduler.close();f.store.close();
});

test('routing boundaries are exactly 70% deferred, then 20% comment and 10% reply',async()=>{
  const values=[0,0.7,0,0.9,0,0.69999,0,0,0];let index=0;const f=setup(()=>values[index++]??0);f.bili.videos=[video('BV1000000001',1,'建筑一'),video('BV1000000002',2,'建筑二'),video('BV1000000003',3,'建筑三')];await f.scheduler.run();await f.scheduler.tick();const plans=f.store.interactionPlans().sort((a,b)=>a.bvid.localeCompare(b.bvid));assert.equal(plans[0].plannedAction,'comment');assert.equal(plans[0].deferred,false);assert.equal(plans[1].plannedAction,'reply');assert.equal(plans[1].deferred,false);assert.equal(plans[2].plannedAction,'comment');assert.equal(plans[2].deferred,true);await f.scheduler.close();f.store.close();
});

test('reply selects a current safe comment and falls back to comment when none exists',async()=>{
  const f=setup(()=>0.95);f.bili.videos=[video('BV1000000001',1,'建筑')];f.bili.replies=[];await f.scheduler.run();await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();assert.equal(f.bili.writes.length,1);assert.equal(f.bili.writes[0].rpid,0);const attempt=f.store.interactionAttempts(f.store.interactionPlans()[0].id)[0];assert.equal(attempt.effectiveAction,'comment');assert.match(attempt.fallbackReason,/没有合格对象/);await f.scheduler.close();f.store.close();
});

test('confirmed send failure consumes one attempt and schedules the original action in a new cycle',async()=>{
  const f=setup(()=>0.8);f.bili.videos=[video('BV1000000001',1,'建筑')];f.bili.postError=new BiliError('api','send','confirmed_not_sent','temporary');await f.scheduler.run();await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();const plan=f.store.interactionPlans()[0];const attempt=f.store.interactionAttempts(plan.id)[0];assert.equal(attempt.status,'failed');assert.equal(plan.plannedAction,'comment');assert.equal(plan.state,'scheduled');assert.equal(plan.cycleCount,1);assert.equal(f.store.attemptCount(f.now()),1);assert.ok(plan.dueAt>f.now());await f.scheduler.close();f.store.close();
});

test('uncertain send is claimed once and operation polling never posts a second time',async()=>{
  const f=setup(()=>0.8);f.bili.videos=[video('BV1000000001',1,'建筑')];f.bili.postError=new BiliError('api','send','uncertain','timeout');f.bili.status='running';await f.scheduler.run();await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();assert.equal(f.bili.writes.length,1);const plan=f.store.interactionPlans()[0];assert.equal(plan.state,'uncertain');f.advance(60000);await f.scheduler.tick();assert.equal(f.bili.writes.length,1);assert.equal(f.store.interactionAttempts(plan.id)[0].requestInFlight,true);await f.scheduler.close();f.store.close();
});

// Use explicit fixture dates to test send gating independently of capacity allocation.
function reusablePlan(f: Pick<ReturnType<typeof setup>,'store'|'id'|'now'>, number: number, action: 'comment'|'reply'='comment') {
  const at=f.now();
  const plan=f.store.createInteractionPlan({video:video(`BV${String(number).padStart(10,'0')}`,number,'建筑'),topicId:f.id,ownerUid:'100',topicName:'测试频道',keyword:'建筑',matchedField:'title',plannedAction:action,commentTemplates:['共用模板'],replyTemplates:['共用模板'],createdAt:at,dueAt:at,cycleStartDay:dayStart(at),cycleDeadlineDay:dayStart(at)+30*86400000});
  assert.ok(plan);
  f.store.db.prepare('UPDATE interaction_plans SET due_at=? WHERE id=?').run(at,plan.id);
  return f.store.interactionPlan(plan.id)!;
}

test('one template can be reused for different videos only after the configured interval',async()=>{
  const f=setup();
  try {
    await f.scheduler.run();
    const first=reusablePlan(f,101);const second=reusablePlan(f,102);
    await f.scheduler.tick();
    assert.equal(f.bili.writes.length,1);
    f.advance(59999);await f.scheduler.tick();assert.equal(f.bili.writes.length,1);
    f.advance(1);await f.scheduler.tick();assert.equal(f.bili.writes.length,2);
    assert.deepEqual(f.bili.writes.map(w=>w.text),['共用模板','共用模板']);
    assert.notEqual(f.bili.writes[0].operationId,f.bili.writes[1].operationId);
    assert.equal(f.store.interactionPlan(first.id)?.state,'succeeded');
    assert.equal(f.store.interactionPlan(second.id)?.state,'succeeded');
    f.advance(60000);await f.scheduler.tick();assert.equal(f.bili.writes.length,2,'completed videos must not replay');
  } finally {await f.scheduler.close();f.store.close();}
});

for(const hasTarget of [true,false])test(`comment and reply share the same text, with ${hasTarget?'a safe reply target':'comment fallback'}`,async()=>{
  const f=setup();
  try {
    await f.scheduler.run();
    reusablePlan(f,111);const reply=reusablePlan(f,112,'reply');
    if(hasTarget)f.bili.replies=[{rpid:123,user:'普通用户',uid:'200',content:'支持',pinned:false,ordinary:true}];
    await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();
    assert.equal(f.bili.writes.length,2);assert.equal(f.bili.writes[1].text,f.bili.writes[0].text);
    assert.equal(f.bili.writes[1].rpid,hasTarget?123:0);
    const attempt=f.store.interactionAttempts(reply.id)[0];
    assert.equal(attempt.effectiveAction,hasTarget?'reply':'comment');
    assert.equal(f.store.interactionPlan(reply.id)?.plannedAction,'reply');
  } finally {await f.scheduler.close();f.store.close();}
});

for(const contents of [[],['','  \t\n']])test(`missing or blank snapshot ${JSON.stringify(contents)} still waits for templates`,async()=>{
  const f=setup();
  try {
    await f.scheduler.run();const plan=reusablePlan(f,121);
    f.store.db.prepare('UPDATE interaction_plans SET comment_templates=? WHERE id=?').run(JSON.stringify(contents),plan.id);
    await f.scheduler.tick();assert.equal(f.bili.writes.length,0);
    assert.equal(f.store.interactionPlan(plan.id)?.state,'waiting_template');
    assert.equal(f.store.interactionEvents(plan.id).at(-1)?.reason,'没有可用模板');
  } finally {await f.scheduler.close();f.store.close();}
});

for(const scope of ['total','globalComment','topicComment'] as const)test(`reused text still respects the ${scope} daily quota`,async()=>{
  const f=setup();
  try {
    await f.scheduler.run();reusablePlan(f,131);const second=reusablePlan(f,132);
    const settings=f.store.settings();
    if(scope==='total')settings.limits.dailyTotal=1;
    if(scope==='globalComment')settings.limits.dailyComment=1;
    f.store.saveSettings(settings);
    if(scope==='topicComment')f.store.saveTopic({...f.store.topic(f.id)!,dailyComment:1},f.id);
    await f.scheduler.tick();f.advance(60000);await f.scheduler.tick();
    assert.equal(f.bili.writes.length,1);assert.equal(f.store.attemptCount(f.now()),1);
    assert.equal(f.store.interactionPlan(second.id)?.state,'scheduled');
    assert.ok(f.store.interactionPlan(second.id)!.dueAt>f.now());
  } finally {await f.scheduler.close();f.store.close();}
});

test('one template remains reusable after a Shanghai day change and SQLite restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lun-template-restart-'));const path=join(dir,'patrol.sqlite');
  const f=setup(()=>0,new Store(path));let reopened:Store|undefined;let scheduler:Scheduler|undefined;let closed=false;
  try {
    await f.scheduler.run();reusablePlan(f,141);const second=reusablePlan(f,142);
    await f.scheduler.tick();assert.equal(f.bili.writes.length,1);
    await f.scheduler.close();f.store.close();closed=true;
    f.advance(86400000);reopened=new Store(path);
    assert.equal(reopened.settings().running,false);assert.equal(reopened.settings().lastContent,'共用模板');
    scheduler=new Scheduler(reopened,f.bili,()=>f.now(),()=>0);
    await scheduler.tick();assert.equal(f.bili.writes.length,1,'restart stays paused');
    await scheduler.run();await scheduler.tick();assert.equal(f.bili.writes.length,2);
    assert.equal(f.bili.writes[1].text,'共用模板');assert.equal(reopened.interactionPlan(second.id)?.state,'succeeded');
    assert.equal(reopened.attemptCount(f.now()),1,'the new Shanghai day has its own accounting');
  } finally {if(scheduler)await scheduler.close();if(reopened)reopened.close();if(!closed){await f.scheduler.close();f.store.close();}await rm(dir,{recursive:true,force:true});}
});
