// Isolated browser acceptance server. Never imports or constructs the real bridge.
import { createApp } from '../server/app.js';
import { runtimeFixture,FakeRuntimeBili,deferred } from './runtime-fixture.js';
import { BiliError, dayStart } from '../server/model.js';
const f=runtimeFixture();
if(process.env.BILIBILI_WRITES_ENABLED!=='false'||!(f.bili instanceof FakeRuntimeBili)||!f.bili.fakeOnly)throw Error('Fake browser fixture requires real write lock OFF');
for(let i=0;i<60;i++){const p=f.plan();f.store.db.prepare("UPDATE interaction_plans SET state='cancelled' WHERE id=?").run(p.id);}
const upcoming=f.plan('comment',f.now()-86400000);const reply=f.plan('reply',f.now()+300000);const review=f.plan();
const a=f.store.claimInteractionPlan({planId:review.id,expectedVersion:review.version,now:f.now(),quotaDay:dayStart(f.now()),dispatchClass:'ordinary',billingTopicId:f.topicId,billingTopicName:'测试',senderUid:'100',effectiveAction:'comment',content:'合成测试评论',limits:f.store.settings().limits});
if(!a)throw Error('fixture claim failed');f.store.finishInteractionAttempt({attemptId:a.id,outcome:'uncertain',finishedAt:f.now(),requestInFlight:false});
let settings=f.store.settings();settings.running=false;settings.pauseReason='启动后暂停';settings.nextInteraction=f.now()+272000;f.store.saveSettings(settings);
// This literal true only enables the HTTP gate of this Fake-only app; the real environment lock stays false.
if(!process.env.LUN_UI_STAGE)throw Error('isolated static build required');process.chdir(process.env.LUN_UI_STAGE);
const app=await createApp(f.store,f.bili,f.scheduler,'unused-fake-credential.json',true);
app.get('/__test/info',()=>({reviewId:review.id,upcomingId:upcoming.id,replyId:reply.id,writes:f.bili.writes,bridgeConstructed:false,realWriteLock:process.env.BILIBILI_WRITES_ENABLED}));
let pendingPost:ReturnType<typeof deferred<object>>|undefined;
app.post('/__test/release',async()=>{pendingPost?.resolve({});return {ok:true};});
app.post('/__test/scenario',async request=>{
 const name=(request.body as {name:string}).name;settings=f.store.settings();settings.running=true;settings.pauseReason='';settings.retryAt=0;settings.readRetryAt=0;settings.nextInteraction=f.now()+272000;settings.limits.dailyComment=100;settings.limits.dailyTotal=100;settings.limits.dailyReply=100;settings.account={loggedIn:true,uid:'100',message:'已登录'};f.store.saveSettings(settings);
 f.store.db.prepare('UPDATE interaction_attempts SET request_in_flight=0 WHERE id=?').run(a.id);
 if(name==='paused')await f.scheduler.pause('手动暂停');
 if(name==='quota'){settings=f.store.settings();settings.limits.dailyComment=0;settings.limits.dailyReply=0;f.store.saveSettings(settings);}
 if(name==='inflight')f.store.db.prepare('UPDATE interaction_attempts SET request_in_flight=1 WHERE id=?').run(a.id);
 if(name==='sending'){settings=f.store.settings();settings.nextInteraction=0;f.store.saveSettings(settings);pendingPost=deferred<object>();f.bili.posting=()=>pendingPost!.promise;void f.scheduler.tick();}
 if(name==='send'){settings=f.store.settings();settings.nextInteraction=0;f.store.saveSettings(settings);await f.scheduler.tick();}
 if(name==='auth'){settings=f.store.settings();settings.running=false;settings.pauseReason=new BiliError('auth').message;settings.account={loggedIn:false,message:'登录失效'};f.store.saveSettings(settings);}
 return {ok:true};
});
const port=Number(process.env.LUN_FAKE_PORT??'3329');if(port===3227||port===3217)throw Error('cannot use a production port');
await app.listen({host:'127.0.0.1',port});console.log('Fake UI ready on '+port);
const timer=setInterval(()=>f.advance(1000),1000);
process.on('SIGTERM',()=>{clearInterval(timer);void app.close().then(()=>{f.store.close();process.exit(0);});});
