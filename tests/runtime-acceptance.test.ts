import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { dayStart,topicSchema,BiliError } from '../server/model.js';
import { quotaDecision } from '../server/eligibility.js';
import { runtimeFixture,deferred } from './runtime-fixture.js';

test('D06: all action, channel and overdue limits retain the original quota decisions',()=>{
 const f=runtimeFixture();try{const limits=f.store.settings().limits;const topic=f.store.topic(f.topicId)!;const base={total:0,action:0,topicAction:0,overdue:0};for(const field of ['total','action','topicAction'] as const){const used={...base,[field]:100};assert.ok(quotaDecision(f.now(),limits,topic,'comment',false,used).length);}
 assert.ok(quotaDecision(f.now(),limits,topic,'reply',true,{...base,overdue:50}).some(r=>r.code==='overdue_quota'));assert.equal(quotaDecision(f.now(),limits,topic,'reply',false,{...base,overdue:50}).length,0);
 }finally{f.store.close();}
});
test('D07/D12/D16: zero search limits, cancelled flags, mismatched owners and empty channels never promise automatic recovery',()=>{
 const f=runtimeFixture();try{const p=f.plan();let s=f.store.settings();s.limits.dailySearch=0;f.store.saveSettings(s);let d=f.scheduler.display(f.now(),true);assert.equal(d.search.state,'blocked');assert.equal(d.search.at,null);f.store.db.prepare('UPDATE interaction_plans SET cancel_requested=1 WHERE id=?').run(p.id);d=f.scheduler.display(f.now(),true);assert.ok(d.interaction.reasons.some(r=>r.code==='cancelled'));assert.equal(d.upcoming.length,0);f.store.db.prepare("UPDATE interaction_plans SET cancel_requested=0,owner_uid='other' WHERE id=?").run(p.id);assert.ok(f.scheduler.display(f.now(),true).interaction.reasons.some(r=>r.code==='owner'));s=f.store.settings();s.limits.dailySearch=100;f.store.saveSettings(s);f.store.db.prepare('UPDATE topics SET next_search=0 WHERE id=?').run(f.topicId);assert.equal(f.scheduler.display(f.now(),true).search.state,'ready');}finally{f.store.close();}
});
test('D13/D14: reply fallback uses its effective action and current rescheduled due time is preserved',async()=>{
 const f=runtimeFixture();try{await f.scheduler.run();const p=f.plan('reply');assert.match(f.scheduler.display(f.now(),true).interaction.title,/检查回复对象/);await f.scheduler.tick();const a=f.store.interactionAttempts(p.id)[0];assert.equal(a.effectiveAction,'comment');assert.equal(f.scheduler.display(f.now(),true).totals.commentSucceeded,1);const later=f.plan();assert.ok(f.store.deferPlanForCapacity(later.id,later.version,f.now()));assert.equal(f.scheduler.display(f.now(),true).interaction.candidate?.currentDueAt,dayStart(f.now())+86400000);assert.ok(f.store.interactionEvents(later.id).some(e=>e.eventType==='capacity_wait'));}finally{await f.scheduler.close();f.store.close();}
});
test('D08: global reply-read budget is counted across plans while comment candidates remain available',()=>{
 const f=runtimeFixture();try{const p=f.plan('reply');f.store.db.prepare('UPDATE interaction_plans SET read_day=?,read_count=? WHERE id=?').run(dayStart(f.now()),300,p.id);assert.ok(f.scheduler.display(f.now(),true).interaction.reasons.some(r=>r.code==='read_budget'));const comment=f.plan();assert.equal(f.scheduler.display(f.now(),true).interaction.candidate?.id,comment.id);}finally{f.store.close();}
});
test('O03/O05/O10/O11: pausing a reply read retains facts and prevents a new preflight or send after it returns',async()=>{
 const f=runtimeFixture();const entered=deferred<void>();const read=deferred<[]>();try{await f.scheduler.run();f.plan('reply');f.bili.reading=()=>{entered.resolve();return read.promise;};const tick=f.scheduler.tick();await entered.promise;const old=f.scheduler.display(f.now(),true).operation;f.advance(60000);assert.equal(f.scheduler.display(f.now(),true).operation?.id,old?.id);const calls=f.bili.calls.length;const pause=f.scheduler.pause();read.resolve([]);await Promise.all([tick,pause]);assert.equal(f.bili.calls.length,calls);assert.equal(f.bili.writes.length,0);assert.equal(f.scheduler.display(f.now(),true).control.running,false);}finally{await f.scheduler.close();f.store.close();}
});
test('O09: auth, risk and disabled status do not display an automatic recovery timer',async()=>{
 for(const kind of ['auth','risk','disabled'] as const){const f=runtimeFixture();try{f.bili.login=async()=>{throw new BiliError(kind);};await assert.rejects(f.scheduler.run());const d=f.scheduler.display(f.now(),kind!=='disabled');assert.equal(d.control.running,false);assert.equal(d.search.at,null);assert.equal(d.interaction.at,null);}finally{await f.scheduler.close();f.store.close();}}
});
test('O06: any historical in-flight attempt remains a barrier and cannot invent a polling deadline',()=>{
 const f=runtimeFixture();try{const p=f.plan();const a=f.store.claimInteractionPlan({planId:p.id,expectedVersion:p.version,now:f.now(),quotaDay:dayStart(f.now()),dispatchClass:'ordinary',billingTopicId:f.topicId,billingTopicName:'测试',senderUid:'100',effectiveAction:'comment',content:'评论',limits:f.store.settings().limits});assert.ok(a);f.store.finishInteractionAttempt({attemptId:a.id,outcome:'succeeded',finishedAt:f.now()});f.store.db.prepare('UPDATE interaction_attempts SET request_in_flight=1 WHERE id=?').run(a.id);const d=f.scheduler.display(f.now(),true);assert.equal(d.interaction.state,'blocked');assert.equal(d.interaction.at,null);}finally{f.store.close();}
});
test('A07: 10,000 synthetic plans and 50 channels keep the state snapshot bounded and within the p95 budget',async()=>{
 const f=runtimeFixture();const app=await createApp(f.store,f.bili,f.scheduler,'unused.json',false);
 try{
  for(let i=1;i<50;i++)f.store.saveTopic(topicSchema.parse({name:'频道'+i,enabled:true,keywords:['gpt']}));
  const first=f.plan();const row=f.store.db.prepare('SELECT * FROM interaction_plans WHERE id=?').get(first.id)!;const columns=Object.keys(row);const insert=f.store.db.prepare(`INSERT INTO interaction_plans(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);const discovery=f.store.db.prepare('INSERT INTO discoveries(bvid,aid,topic_id,video,keyword,time) VALUES(?,?,?,?,?,?)');
  f.store.db.exec('BEGIN IMMEDIATE');try{for(let i=2;i<=10000;i++){const id=`BV${String(i).padStart(10,'0')}`;const video=JSON.stringify({bvid:id,aid:i,title:'合成计划'+i,author:'合成UP',play:1,pubdate:1});discovery.run(id,i,f.topicId,video,'gpt',f.now());const data={...row,id:i,bvid:id,aid:i,video,due_at:f.now()+86400000+i};insert.run(...columns.map(c=>data[c as keyof typeof data]));}f.store.db.exec('COMMIT');}catch(e){f.store.db.exec('ROLLBACK');throw e;}
  await app.inject('/api/state');const times:number[]=[];let size=0;
  for(let i=0;i<20;i++){const start=performance.now();const r=await app.inject('/api/state');times.push(performance.now()-start);assert.equal(r.statusCode,200);const d=r.json().display;assert.equal(d.totals.pending,10000);assert.equal(d.upcoming.length,3);size=Buffer.byteLength(JSON.stringify(d));}
  times.sort((a,b)=>a-b);const p95=times[18];console.info('Runtime API benchmark '+JSON.stringify({plans:10000,channels:50,samples:20,p95Ms:Math.round(p95*100)/100,addedBytes:size}));assert.ok(p95<=250,`p95 ${p95}ms exceeds budget`);assert.ok(size<=32768);const plan=f.store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM interaction_plans WHERE state='scheduled' AND due_at<=? ORDER BY due_at LIMIT 101").all(f.now());assert.ok(JSON.stringify(plan).includes('interaction_plans_due'));
 }finally{await app.close();await f.scheduler.close();f.store.close();}
});
