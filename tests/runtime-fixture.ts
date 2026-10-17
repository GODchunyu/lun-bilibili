import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { dayStart, limitsSchema, topicSchema, type Account, type OrdinaryComment, type Video } from '../server/model.js';
import type { ApplicationBilibili } from '../server/app.js';
export function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
export class FakeRuntimeBili implements ApplicationBilibili {
 readonly fakeOnly=true;calls:string[]=[];writes:{bvid:string;text:string}[]=[];
 login?:()=>Promise<Account>;searching?:()=>Promise<Video[]>;reading?:()=>Promise<OrdinaryComment[]>;posting?:()=>Promise<object>;
 async checkLogin(){this.calls.push('login');return this.login?this.login():{loggedIn:true,uid:'100',message:'已登录'};}
 async search(){this.calls.push('search');return this.searching?this.searching():[];}
 async comments(){this.calls.push('comments');return this.reading?this.reading():[];}
 async post(bvid:string,text:string){this.calls.push('post');this.writes.push({bvid,text});return this.posting?this.posting():{};}
 async tools(){return [];}async qrStart(){return {status:'',message:'',qrcode_image:''};}async qrCheck(){return {message:''};}async resetSession(){}
}
export function runtimeFixture(){
 let now=Date.parse('2026-10-17T08:00:00+08:00');const store=new Store(':memory:',()=>0);const bili=new FakeRuntimeBili();
 const s=store.settings();s.running=true;s.pauseReason='';s.account={loggedIn:true,uid:'100',message:'已登录'};s.limits=limitsSchema.parse({dailyTotal:100,dailyComment:100,dailyReply:100,waitMin:1,waitMax:1});store.saveSettings(s);
 store.bindAccount('100',true);const topicId=store.saveTopic(topicSchema.parse({name:'测试',enabled:true,keywords:['gpt'],dailySearch:20,dailyComment:100,dailyReply:100}));
 store.db.prepare('UPDATE topics SET next_search=? WHERE id=?').run(now+600000,topicId);
 const scheduler=new Scheduler(store,bili,()=>now,()=>0);let sequence=0;
 function plan(action:'comment'|'reply'='comment',due=now,topic=topicId){const n=++sequence;const result=store.createInteractionPlan({video:{bvid:`BV${String(n).padStart(10,'0')}`,aid:n,title:'测试视频'+n,author:'UP',play:1,pubdate:1},topicId:topic,topicName:'测试',ownerUid:'100',keyword:'gpt',matchedField:'title',plannedAction:action,commentTemplates:['评论'],replyTemplates:['回复'],createdAt:now,dueAt:due,cycleStartDay:dayStart(now),cycleDeadlineDay:dayStart(now)+30*86400000});if(!result)throw Error('fixture duplicate');store.db.prepare('UPDATE interaction_plans SET due_at=? WHERE id=?').run(due,result.id);return store.interactionPlan(result.id)!;}
 return {store,bili,scheduler,topicId,plan,now:()=>now,setNow:(value:number)=>{now=value;},advance:(ms:number)=>{now+=ms;},facts:()=>store.runtimeFacts(now)};
}
