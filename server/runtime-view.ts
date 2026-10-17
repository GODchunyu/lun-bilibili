import { dayStart, type DisplayChannel, type DisplayOperation, type DisplayPlan, type DisplayReason, type InteractionPlan, type QueueSummary, type RuntimeDisplay, type Settings } from './model.js';
import { normalizeSearchText } from './bilibili.js';
import { quotaDecision } from './eligibility.js';
export interface RuntimeTopic {id:number;name:string;enabled:boolean;keywords:string[];nextSearch:number;dailySearch:number;dailyComment:number;dailyReply:number}
export interface RuntimeUsage {total:number;comment:number;reply:number;overdue:number;topic:Record<number,{comment:number;reply:number}>;readCount:number;searches:number;topicSearches:Record<number,number>}
export interface ReviewFact {plan:InteractionPlan;requestInFlight:boolean;canResolve:boolean}
export interface RuntimeFacts {now:number;settings:Settings;topics:RuntimeTopic[];queue:QueueSummary;binding:{uid:string;verified:boolean}|undefined;due:InteractionPlan[];future:InteractionPlan[];inFlightCount:number;pollAt:number|null;review:ReviewFact[];usage:RuntimeUsage;success:{comment:number;reply:number}}
export interface RuntimeControl {starting:boolean;pauseRequested:boolean;operation:DisplayOperation|null}
const reason=(code:string,label:string,at:number|null=null):DisplayReason=>({code,label,at});
export function displayPlan(plan:InteractionPlan,now:number):DisplayPlan {
 let title=plan.bvid;try{const video=JSON.parse(plan.video);if(typeof video.title==='string'&&video.title.trim())title=video.title;}catch{/* Missing display metadata does not change scheduling facts. */}
 return {id:plan.id,bvid:plan.bvid,title,action:plan.plannedAction,state:plan.state,topicName:plan.topicName,deferred:plan.deferred,currentDueAt:plan.dueAt,deadlineAt:plan.cycleDeadlineDay,beyondCycle:dayStart(now)>plan.cycleDeadlineDay||(plan.overflow&&dayStart(now)>=plan.cycleDeadlineDay),href:`/plans?planId=${plan.id}`};
}
function channel(reasons:DisplayReason[],candidate:DisplayPlan|null=null):DisplayChannel {
 if(reasons.some(r=>r.at===null))return {state:'blocked',title:reasons.find(r=>r.at===null)!.label,timeKind:'manual',at:null,reasons,candidate};
 if(reasons.length){const at=Math.max(...reasons.map(r=>r.at!));const primary=reasons.find(r=>r.at===at)!;return {state:'waiting',title:primary.label,timeKind:primary.code.includes('quota')||primary.code==='read_budget'?'check':'eligible',at,reasons,candidate};}
 return {state:'ready',title:'已到执行时间，等待调度检查',timeKind:'eligible',at:null,reasons:[],candidate};
}
function quota(f:RuntimeFacts,p:InteractionPlan,action:'comment'|'reply') {
 const topic=f.topics.find(t=>t.id===p.topicId);if(!topic)return [reason('orphaned','所属频道已不存在，需要人工处理')];
 const u=f.usage;return quotaDecision(f.now,f.settings.limits,topic,action,displayPlan(p,f.now).beyondCycle,{total:u.total,action:u[action],topicAction:u.topic[topic.id]?.[action]??0,overdue:u.overdue});
}
function planChannel(f:RuntimeFacts,p:InteractionPlan):DisplayChannel {
 const reasons:DisplayReason[]=[];const topic=f.topics.find(t=>t.id===p.topicId);const s=f.settings;const now=f.now;
 if(!topic||p.orphaned)reasons.push(reason('orphaned','所属频道已不存在，需要人工处理'));
 else if(!topic.enabled||p.channelDisabled)reasons.push(reason('channel_disabled','所属频道已暂停'));
 if(p.cancelRequested)reasons.push(reason('cancelled','已请求取消，不再安排发送'));
 if(!f.binding?.verified||f.binding.uid!==p.ownerUid)reasons.push(reason('owner','账号归属需要核对'));
 if(p.dueAt>now)reasons.push(reason('schedule','等待当前计划时间',p.dueAt));
 if(s.retryAt>now)reasons.push(reason('interaction_backoff','互动暂缓，等待再次检查',s.retryAt));
 if(s.nextInteraction>now)reasons.push(reason('spacing','等待发送间隔',s.nextInteraction));
 // The executor checks nextPrepareAt before both actions, not just replies.
 if(p.nextPrepareAt!==null&&p.nextPrepareAt>now)reasons.push(reason('prepare_cooldown','等待准备冷却',p.nextPrepareAt));
 let q=quota(f,p,p.plannedAction);
 if(p.plannedAction==='reply'){
  const fallback=quota(f,p,'comment');if(q.length&&!fallback.length)q=[];else if(q.some(r=>r.at===null)&&fallback.every(r=>r.at!==null))q=fallback;
  const count=p.readDay===dayStart(now)?p.readCount:0;
  if(count>=3||f.usage.readCount>=s.limits.dailyTotal*3)reasons.push(reason('read_budget','今日回复对象检查次数已用完',dayStart(now)+86400000));
 }
 reasons.push(...q);
 const pool=p.plannedAction==='reply'?[...p.commentTemplates,...p.replyTemplates]:p.commentTemplates;
 if(!pool.some(t=>t.trim()))reasons.push(reason('template','等待补充本计划模板'));
 const result=channel(reasons,displayPlan(p,now));
 if(p.plannedAction==='reply'&&result.state==='ready')result.title='已到执行时间，准备检查回复对象';
 return result;
}
function deriveSearch(f:RuntimeFacts):DisplayChannel {
 const enabled=f.topics.filter(t=>t.enabled);
 if(!enabled.length)return {state:'idle',title:'暂无启用的搜索频道',timeKind:'unknown',at:null,reasons:[],candidate:null};
 const candidates=enabled.map(t=>{
  const reasons:DisplayReason[]=[];const s=f.settings;
  if(s.limits.dailySearch===0||t.dailySearch===0)reasons.push(reason('zero_search_quota','搜索额度设为0，需要调整设置'));
  else if(f.usage.searches>=s.limits.dailySearch||(f.usage.topicSearches[t.id]??0)>=t.dailySearch)reasons.push(reason('search_quota','今日搜索额度已用完',dayStart(f.now)+86400000));
  if(t.nextSearch>f.now)reasons.push(reason('next_search','等待下一次搜索',t.nextSearch));
  if(s.readRetryAt>f.now)reasons.push(reason('read_backoff','搜索暂缓，等待再次检查',s.readRetryAt));
  const result=channel(reasons);result.topicName=t.name;
  const keywords=[...new Map(t.keywords.map(k=>[normalizeSearchText(k),k])).values()];result.keyword=keywords[(f.usage.topicSearches[t.id]??0)%keywords.length];
  if(result.state==='ready')result.title='等待检查并搜索';
  return result;
 });
 return candidates.find(c=>c.state==='ready')??candidates.filter(c=>c.at!==null).sort((a,b)=>a.at!-b.at!)[0]??candidates[0];
}
function deriveInteraction(f:RuntimeFacts):DisplayChannel {
 if(f.inFlightCount){const c=channel([reason('unconfirmed_request','上一条请求尚未确认结束，其他评论暂缓')]);c.timeKind='check';c.at=f.settings.retryAt>f.now?f.settings.retryAt:f.pollAt;c.reasons.push(reason('poll','下次检查原请求结果',c.at));return c;}
 const window=f.due.slice(0,100);const derived=window.map(p=>planChannel(f,p));
 const ready=derived.find(c=>c.state==='ready');if(ready)return ready;
 const future=f.future.map(p=>planChannel(f,p));
 const timed=[...derived,...future].filter(c=>c.at!==null).sort((a,b)=>a.at!-b.at!);
 if(f.due.length>100){const c=channel([reason('scan_window','当前调度批次受限，后续候选尚未选中')]);if(timed.length)c.reasons.push(...timed[0].reasons);return c;}
 if(timed.length)return timed[0];
 if(derived.length)return derived[0];if(future.length)return future[0];
 if(f.queue.waitingTemplate)return channel([reason('template','等待补充计划模板')]);
 if(f.queue.pausedChannel)return channel([reason('channel_disabled','计划所属频道已暂停')]);
 return {state:'idle',title:'暂无可执行计划，等待搜索发现',timeKind:'unknown',at:null,reasons:[],candidate:null};
}
export function buildRuntimeDisplay(f:RuntimeFacts,control:RuntimeControl,writesEnabled:boolean,instanceId:string,snapshotSeq:number):RuntimeDisplay {
 const search=deriveSearch(f);let interaction=deriveInteraction(f);const s=f.settings;
 const pausedReason=reason('paused',s.pauseReason||'巡逻已暂停，请手动启动');
 if(!s.running){for(const c of [search,interaction]){c.state='paused';c.title=control.starting?'启动检查中':pausedReason.label;c.at=null;c.timeKind='manual';c.reasons=[pausedReason,...c.reasons];}}
 else {
  if(!s.account.loggedIn){for(const c of [search,interaction]){c.state='blocked';c.title='登录状态需要确认';c.at=null;c.timeKind='manual';c.reasons.unshift(reason('auth','登录状态需要确认'));}}
  if(!writesEnabled){interaction=channel([reason('writes_disabled','真实写操作未开启')],interaction.candidate);}
 }
 const operation=control.operation;
 let headline:RuntimeDisplay['headline']={title:'巡逻中',detail:'搜索与互动按各自安排检查，依次执行',tone:'normal'};
 if(!s.running)headline={title:control.starting?'启动检查中':'巡逻已暂停',detail:s.pauseReason||'等待手动启动',tone:'paused'};
 else if(interaction.state==='blocked')headline={title:'巡逻中 · 视频互动暂缓',detail:interaction.title,tone:'attention'};
 else if(search.state==='idle'&&interaction.state==='idle')headline={title:'巡逻中 · 暂无任务',detail:'等待启用频道或新的计划',tone:'normal'};
 else if(interaction.state==='waiting')headline={title:'巡逻中 · '+interaction.title,detail:f.queue.due?`有${f.queue.due}条计划已到执行时间；安排基于当前已知任务`:'搜索与互动按各自安排检查',tone:'normal'};
 if(operation)headline={title:(control.pauseRequested?'暂停中 · ':!s.running&&!control.starting?'巡逻已暂停 · ':'')+operation.label,detail:operation.title??operation.keyword??'等待当前操作返回结果',tone:control.pauseRequested?'paused':'normal'};
 const items:RuntimeDisplay['attention']['items']=f.review.map(({plan,requestInFlight,canResolve})=>({key:'plan-'+plan.id,label:plan.state==='uncertain'?'这条互动需要核实发送结果':plan.state==='waiting_template'?'需要补充计划模板':'这条计划需要人工处理',detail:requestInFlight?'原请求结束尚未确认，暂不能确认未发送':'请进入详情核对；未看到评论不等于未发送',href:`/plans?state=${plan.state}&planId=${plan.id}`,planId:plan.id,canResolve}));
 if(!s.account.loggedIn)items.unshift({key:'account',label:'账号需要登录或检查',detail:'请在设置页检查账号',href:'/settings',canResolve:false});
 if(!writesEnabled)items.push({key:'writes',label:'真实写操作未开启',detail:'请在设置页查看说明',href:'/settings',canResolve:false});
 const reviewTotal=f.queue.uncertain+f.queue.manualReview+f.queue.waitingTemplate;
 const upcoming=[...f.due,...f.future].filter(p=>!p.cancelRequested&&!p.orphaned&&p.state==='scheduled').slice(0,3).map(p=>displayPlan(p,f.now));
 return {schemaVersion:1,instanceId,snapshotSeq,serverNow:f.now,control:{running:s.running,starting:control.starting,pauseRequested:control.pauseRequested,writesEnabled},operation,headline,search,interaction,attention:{total:reviewTotal+(!s.account.loggedIn?1:0)+(!writesEnabled?1:0),waitingEnd:f.inFlightCount,items:items.slice(0,8)},upcoming,totals:{commentSucceeded:f.success.comment,replySucceeded:f.success.reply,pending:f.queue.pending,needReview:reviewTotal,claimed:f.queue.claimed}};
}
