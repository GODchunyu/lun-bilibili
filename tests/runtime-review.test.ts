import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { dayStart } from '../server/model.js';
import { runtimeFixture } from './runtime-fixture.js';

test('U08/U09/O08: stale manual resolution, missing evidence and in-flight state never schedule a duplicate',async()=>{
 const f=runtimeFixture();const app=await createApp(f.store,f.bili,f.scheduler,'unused.json',false);
 try{
 const p=f.plan();const a=f.store.claimInteractionPlan({planId:p.id,expectedVersion:p.version,now:f.now(),quotaDay:dayStart(f.now()),dispatchClass:'ordinary',billingTopicId:f.topicId,billingTopicName:'测试',senderUid:'100',effectiveAction:'comment',content:'评论',limits:f.store.settings().limits});assert.ok(a);f.store.finishInteractionAttempt({attemptId:a.id,outcome:'uncertain',finishedAt:f.now(),requestInFlight:true});
 const post=(action:string,evidence:string)=>app.inject({method:'POST',url:`/api/attempts/${a.id}/resolve`,payload:{action,evidence}});
 assert.notEqual((await post('not_sent','已经核对')).statusCode,200);assert.equal(f.store.interactionPlan(p.id)?.state,'uncertain');assert.equal(f.store.interactionAttempts(p.id).length,1);assert.notEqual((await post('succeeded',' ')).statusCode,200);
 f.store.markRequestInFlight(a.id,false,f.now());f.store.recordLateReceipt(a.id,'{}',f.now());assert.notEqual((await post('not_sent','旧页面的请求')).statusCode,200);assert.equal(f.store.interactionPlan(p.id)?.state,'succeeded');assert.equal(f.store.interactionAttempts(p.id).length,1);assert.deepEqual(f.bili.writes,[]);
 const missing=(await app.inject('/api/plans/99999')).json();assert.equal(missing.error,'计划不存在');
 }finally{await app.close();await f.scheduler.close();f.store.close();}
});
test('A03/A09: failed and uncertain attempts consume quota but are not counted as successful comments',()=>{
 const f=runtimeFixture();try{for(const outcome of ['confirmed_failure','uncertain'] as const){const p=f.plan();const a=f.store.claimInteractionPlan({planId:p.id,expectedVersion:p.version,now:f.now(),quotaDay:dayStart(f.now()),dispatchClass:'ordinary',billingTopicId:f.topicId,billingTopicName:'测试',senderUid:'100',effectiveAction:'comment',content:'评论',limits:f.store.settings().limits});assert.ok(a);f.store.finishInteractionAttempt({attemptId:a.id,outcome,finishedAt:f.now(),requestInFlight:false});}assert.equal(f.store.attemptCount(f.now()),2);assert.equal(f.scheduler.display(f.now(),true).totals.commentSucceeded,0);}finally{f.store.close();}
});
