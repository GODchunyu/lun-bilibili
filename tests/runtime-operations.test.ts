import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { runtimeDisplaySchema } from '../server/model.js';
import { runtimeFixture,deferred } from './runtime-fixture.js';

test('O02/O03: send operation retains identity and elapsed time while pause waits for it',async()=>{
 const f=runtimeFixture();const entered=deferred<void>();const post=deferred<object>();
 try {await f.scheduler.run();f.plan();f.bili.posting=()=>{entered.resolve();return post.promise;};const tick=f.scheduler.tick();await entered.promise;const first=f.scheduler.display(f.now(),true);assert.equal(first.operation?.kind,'sending');f.advance(4000);const second=f.scheduler.display(f.now(),true);assert.equal(second.operation?.id,first.operation?.id);assert.equal(second.operation?.startedAt,first.operation?.startedAt);const pause=f.scheduler.pause('用户暂停');const stopping=f.scheduler.display(f.now(),true);assert.equal(stopping.control.pauseRequested,true);assert.match(stopping.headline.title,/暂停中/);assert.equal(stopping.operation?.id,first.operation?.id);post.resolve({});await Promise.all([tick,pause]);const done=f.scheduler.display(f.now(),true);assert.equal(done.operation,null);assert.equal(done.control.running,false);assert.equal(f.bili.writes.length,1);}finally{await f.scheduler.close();f.store.close();}
});
for(const kind of ['searching','reading_comments'] as const)test('O02: '+kind+' reports the real operation without a fabricated whole-operation deadline',async()=>{
 const f=runtimeFixture();const entered=deferred<void>();const finish=deferred<[]>();try{
 await f.scheduler.run();if(kind==='searching'){f.store.db.prepare('UPDATE topics SET next_search=0').run();f.bili.searching=()=>{entered.resolve();return finish.promise;};}else{f.plan('reply');f.bili.reading=()=>{entered.resolve();return finish.promise;};}
 const tick=f.scheduler.tick();await entered.promise;const d=f.scheduler.display(f.now(),true);assert.equal(d.operation?.kind,kind);assert.equal(d.operation?.startedAt,f.now());f.advance(60000);assert.equal(f.scheduler.display(f.now(),true).operation?.id,d.operation?.id);finish.resolve([]);await tick;assert.equal(f.scheduler.display(f.now(),true).operation,null);
 }finally{await f.scheduler.close();f.store.close();}
});
test('A01/A02/A04/A06: API snapshots share a clock and instance, grow in order and preserve persisted facts',async()=>{
 const f=runtimeFixture();const app=await createApp(f.store,f.bili,f.scheduler,'unused.json',false);
 try {f.plan();const before=f.store.db.prepare('SELECT * FROM app_settings').all();const requests=[];
 for(let i=0;i<4;i++){const response=await app.inject('/api/state');assert.equal(response.statusCode,200);const data=response.json();const d=runtimeDisplaySchema.parse(data.display);assert.equal(d.serverNow,data.serverNow);assert.equal(d.serverNow,data.runtime.serverNow);requests.push(d);}
 assert.equal(new Set(requests.map(d=>d.instanceId)).size,1);assert.deepEqual(requests.map(d=>d.snapshotSeq),[1,2,3,4]);assert.deepEqual(f.store.db.prepare('SELECT * FROM app_settings').all(),before);assert.deepEqual(f.bili.calls,[]);
 const response=await app.inject({method:'POST',url:'/api/scheduler',payload:{running:true}});assert.equal(response.statusCode,409);assert.deepEqual(f.bili.calls,[]);
 }finally{await app.close();await f.scheduler.close();f.store.close();}
});
test('O01: observing the same waiting phase does not reset its start time',async()=>{const f=runtimeFixture();try{await f.scheduler.run();const initial=f.scheduler.status().phaseSince;f.advance(5000);for(let i=0;i<10;i++)f.scheduler.display(f.now(),false);assert.equal(f.scheduler.status().phaseSince,initial);}finally{await f.scheduler.close();f.store.close();}});
