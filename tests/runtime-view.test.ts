import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRuntimeDisplay, type RuntimeFacts } from '../server/runtime-view.js';
import { runtimeDisplaySchema, dayStart } from '../server/model.js';
import { runtimeFixture } from './runtime-fixture.js';
const view=(f:RuntimeFacts)=>runtimeDisplaySchema.parse(buildRuntimeDisplay(f,{starting:false,pauseRequested:false,operation:null},true,'test',1));
const codes=(f:RuntimeFacts)=>view(f).interaction.reasons.map(r=>r.code);

test('D01/D02/D03: search and interaction have independent timelines; elapsed due does not replace spacing or preparation',()=>{
 const f=runtimeFixture();try{const p=f.plan('reply',f.now()-86400000);const s=f.store.settings();s.nextInteraction=f.now()+272000;f.store.saveSettings(s);let v=view(f.facts());assert.equal(v.search.at,f.now()+600000);assert.equal(v.interaction.at,s.nextInteraction);assert.equal(v.interaction.title,'等待发送间隔');assert.equal(v.interaction.candidate?.currentDueAt,p.dueAt);f.store.db.prepare('UPDATE interaction_plans SET next_prepare_at=? WHERE id=?').run(f.now()+900000,p.id);v=view(f.facts());assert.equal(v.interaction.at,f.now()+900000);assert.equal(v.interaction.title,'等待准备冷却');}finally{f.store.close();}
});
test('D04/D05: read and interaction backoff do not block the other channel',()=>{
 const f=runtimeFixture();try{f.plan();const s=f.store.settings();s.readRetryAt=f.now()+3600000;f.store.saveSettings(s);let v=view(f.facts());assert.equal(v.interaction.state,'ready');assert.equal(v.search.at,s.readRetryAt);s.readRetryAt=0;s.retryAt=f.now()+1800000;f.store.saveSettings(s);v=view(f.facts());assert.equal(v.search.at,f.now()+600000);assert.equal(v.interaction.at,s.retryAt);}finally{f.store.close();}
});
for(const key of ['dailyTotal','dailyComment'] as const)test('D07: zero '+key+' does not promise tomorrow recovery',()=>{const f=runtimeFixture();try{f.plan();const s=f.store.settings();s.limits[key]=0;f.store.saveSettings(s);const c=view(f.facts()).interaction;assert.equal(c.state,'blocked');assert.equal(c.at,null);assert.ok(c.reasons.some(r=>r.code.startsWith('zero_')));}finally{f.store.close();}});
test('D06/D08: full quotas and read budgets have an explicit next-day check',()=>{
 const f=runtimeFixture();try{const p=f.plan('reply');f.store.db.prepare('UPDATE interaction_plans SET read_day=?,read_count=3 WHERE id=?').run(dayStart(f.now()),p.id);const c=view(f.facts()).interaction;assert.equal(c.at,dayStart(f.now())+86400000);assert.ok(c.reasons.some(r=>r.code==='read_budget'));const facts=f.facts();facts.usage.total=facts.settings.limits.dailyTotal;assert.ok(codes(facts).includes('total_quota'));assert.equal(f.store.canClaimNow(f.now(),f.topicId,'comment','ordinary'),true);}finally{f.store.close();}
});
test('D09/D10: choose a ready task inside the execution window; never promise task 101 outside it',()=>{
 const f=runtimeFixture();try{const p=f.plan('reply');f.store.db.prepare('UPDATE interaction_plans SET next_prepare_at=? WHERE id=?').run(f.now()+600000,p.id);const ready=f.plan();assert.equal(view(f.facts()).interaction.candidate?.id,ready.id);const facts=f.facts();facts.due=Array.from({length:101},(_,i)=>({...p,id:i+1,nextPrepareAt:f.now()+600000}));facts.due[100].nextPrepareAt=null;const c=view(facts).interaction;assert.equal(c.state,'blocked');assert.ok(c.reasons.some(r=>r.code==='scan_window'));}finally{f.store.close();}
});
test('D11: recent plans and attention are independent of 201 historical terminal rows',()=>{
 const f=runtimeFixture();try{for(let i=0;i<201;i++){const p=f.plan();f.store.db.prepare("UPDATE interaction_plans SET state='cancelled' WHERE id=?").run(p.id);}const p=f.plan('comment',f.now()+60000);const v=view(f.facts());assert.equal(v.upcoming[0].id,p.id);assert.equal(v.totals.pending,1);}finally{f.store.close();}
});
test('D12/D16/D17: disabled, empty and 30-day deadline have different explanations',()=>{
 const f=runtimeFixture();try{assert.equal(view(f.facts()).interaction.state,'idle');const p=f.plan();f.store.db.prepare('UPDATE interaction_plans SET cycle_deadline_day=? WHERE id=?').run(dayStart(f.now())-86400000,p.id);assert.equal(view(f.facts()).upcoming[0].beyondCycle,true);f.store.saveTopic({...f.store.topic(f.topicId)!,enabled:false},f.topicId);const v=view(f.facts());assert.equal(v.search.state,'idle');assert.equal(v.interaction.state,'blocked');}finally{f.store.close();}
});
test('A01: repeated observation is read-only, including counters, settings, versions and network calls',()=>{
 const f=runtimeFixture();try{f.plan();const tables=['interaction_plans','discoveries','interaction_attempts','interaction_events','activity','app_settings','auth_metadata'];const dump=()=>tables.map(t=>f.store.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all());const before=dump();for(let i=0;i<100;i++)view(f.facts());assert.deepEqual(dump(),before);assert.deepEqual(f.bili.calls,[]);}finally{f.store.close();}
});
test('A10: late success belongs to the Shanghai start day rather than the confirmation day',()=>{
 const f=runtimeFixture();try{f.setNow(Date.parse('2026-10-17T23:59:59+08:00'));const p=f.plan();const a=f.store.claimInteractionPlan({planId:p.id,expectedVersion:p.version,now:f.now(),quotaDay:dayStart(f.now()),dispatchClass:'ordinary',billingTopicId:f.topicId,billingTopicName:'测试',senderUid:'100',effectiveAction:'comment',content:'评论',limits:f.store.settings().limits});assert.ok(a);f.advance(2000);f.store.finishInteractionAttempt({attemptId:a.id,outcome:'succeeded',finishedAt:f.now()});assert.equal(view(f.facts()).totals.commentSucceeded,0);assert.equal(view(f.store.runtimeFacts(f.now()-2000)).totals.commentSucceeded,1);}finally{f.store.close();}
});
test('O06/O07: an unresolved ended attempt does not impose a global barrier, any in-flight row does',()=>{
 const f=runtimeFixture();try{const p=f.plan();const a=f.store.claimInteractionPlan({planId:p.id,expectedVersion:p.version,now:f.now(),quotaDay:dayStart(f.now()),dispatchClass:'ordinary',billingTopicId:f.topicId,billingTopicName:'测试',senderUid:'100',effectiveAction:'comment',content:'评论',limits:f.store.settings().limits});assert.ok(a);f.store.finishInteractionAttempt({attemptId:a.id,outcome:'uncertain',finishedAt:f.now(),requestInFlight:false});f.plan();let v=view(f.facts());assert.equal(v.interaction.state,'ready');assert.equal(v.attention.items[0].canResolve,true);f.store.db.prepare('UPDATE interaction_attempts SET request_in_flight=1 WHERE id=?').run(a.id);v=view(f.facts());assert.equal(v.interaction.state,'blocked');assert.equal(v.attention.items[0].canResolve,false);assert.equal(v.search.state,'waiting');}finally{f.store.close();}
});
test('U13/A05: malformed video metadata falls back to BV without exposing content',()=>{
 const f=runtimeFixture();try{const p=f.plan();f.store.db.prepare("UPDATE interaction_plans SET video='invalid json',comment_templates=? WHERE id=?").run(JSON.stringify(['PRIVATE_TEMPLATE_MARKER']),p.id);const v=view(f.facts());assert.equal(v.upcoming[0].title,p.bvid);assert.equal(JSON.stringify(v).includes('PRIVATE_TEMPLATE_MARKER'),false);}finally{f.store.close();}
});
