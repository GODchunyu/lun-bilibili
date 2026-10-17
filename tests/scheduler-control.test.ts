import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { type Bilibili } from '../server/model.js';

function deferred<T>() { let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
const account={loggedIn:true,uid:'100',message:'已登录'};
function fixture(check:()=>Promise<typeof account>) {
 const store=new Store(':memory:',()=>0);let reads=0;let writes=0;
 const bili:Bilibili={checkLogin:check,async search(){reads++;return [];},async comments(){reads++;return [];},async post(){writes++;return {};}};
 const scheduler=new Scheduler(store,bili,()=>1700000000000,()=>0);
 return {store,scheduler,counts:()=>({reads,writes})};
}
test('O04b: pause immediately following run prevents the older startup from enabling patrol',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return account;});
 try {const start=f.scheduler.run();const pause=f.scheduler.pause('手动暂停');await Promise.all([start,pause]);assert.equal(f.store.settings().running,false);assert.equal(f.store.settings().pauseReason,'手动暂停');assert.equal(f.scheduler.status().phase,'paused');assert.equal(calls,0);assert.deepEqual(f.counts(),{reads:0,writes:0});}finally{await f.scheduler.close();f.store.close();}
});
for(const fail of [false,true])test(`O04a: a late login ${fail?'failure':'success'} cannot overwrite a newer pause`,async()=>{
 const login=deferred<typeof account>();const entered=deferred<void>();const f=fixture(()=>{entered.resolve();return login.promise;});
 try {const start=f.scheduler.run();await entered.promise;const pause=f.scheduler.pause('用户暂停');assert.equal(f.scheduler.status().phase,'pause_requested');if(fail)login.reject(new Error('private raw failure'));else login.resolve(account);await Promise.all([start,pause]);assert.equal(f.store.settings().running,false);assert.equal(f.scheduler.status().phase,'paused');assert.equal(f.scheduler.status().reason,'用户暂停');assert.equal(JSON.stringify(f.scheduler.status()).includes('private raw failure'),false);}finally{await f.scheduler.close();f.store.close();}
});
test('O04c: run-pause-run resolves without self-wait and only the latest startup controls running',async()=>{
 const old=deferred<typeof account>();const entered=deferred<void>();let checks=0;const f=fixture(()=>{checks++;if(checks===1){entered.resolve();return old.promise;}return Promise.resolve(account);});
 try {const first=f.scheduler.run();await entered.promise;const pause=f.scheduler.pause();const last=f.scheduler.run();await last;old.resolve(account);await Promise.all([first,pause]);assert.equal(f.store.settings().running,true);assert.equal(f.store.settings().pauseReason,'');assert.equal(f.scheduler.status().pauseRequested,false);assert.deepEqual(f.counts(),{reads:0,writes:0});}finally{await f.scheduler.close();f.store.close();}
});
test('normal startup and sequential pause retain their behavior and startup failures release ownership',async()=>{
 let valid=false;const f=fixture(async()=>({...account,loggedIn:valid}));
 try {await assert.rejects(f.scheduler.run());assert.equal(f.store.settings().running,false);assert.equal(f.scheduler.status().inFlight,false);valid=true;await f.scheduler.run();assert.equal(f.store.settings().running,true);await f.scheduler.pause();assert.equal(f.store.settings().running,false);assert.equal(f.scheduler.status().phase,'paused');}finally{await f.scheduler.close();f.store.close();}
});
