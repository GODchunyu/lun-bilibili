import { randomUUID } from 'node:crypto';
import { buildRuntimeDisplay, type RuntimeControl } from './runtime-view.js';
import { BiliError, dayStart, safeComment, schedulerStatusSchema, videoSchema } from './model.js';
import type { Account, Bilibili, Topic, TopicConfig, Video, Activity, OrdinaryComment, InteractionAction, SchedulerCurrent, SchedulerNextAction, SchedulerPhase, SchedulerReasonCode, SchedulerStatus, DisplayOperation, RuntimeDisplay } from './model.js';
import { keywordMatchesTitle, normalizeSearchText } from './bilibili.js';
import { Store, STARTUP_PAUSE } from './store.js';

export class Scheduler {
  private active?: Promise<void>;
  private readonly starts=new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private generation=0;
  private nextLoginCheck=0;
  private nextIdleCheck=0;
  private readonly instanceId=randomUUID();
  private snapshotSeq=0;
  private operationSeq=0;
  private readonly operations=new Map<string,DisplayOperation>();
  private startGeneration=0;
  private pauseGeneration=0;
  private runtime:SchedulerStatus;

  constructor(readonly store:Store, private bili:Bilibili, private clock=Date.now, private random=Math.random, _legacyAi?:unknown) {
    const now=this.clock();
    this.runtime=schedulerStatusSchema.parse({phase:'paused',phaseSince:now,serverNow:now,reasonCode:'startup_paused',reason:STARTUP_PAUSE,nextAction:{kind:'manual_action',at:null},deadlineAt:null,timeoutAt:null,current:null,inFlight:false,pauseRequested:false});
  }
  now(){return this.clock();}
  observation():RuntimeControl {
    const operation=[...this.operations.values()].sort((a,b)=>(a.kind==='sending'?-1:0)-(b.kind==='sending'?-1:0)||a.startedAt-b.startedAt)[0]??null;
    return {starting:this.startGeneration===this.generation&&this.starts.size>0&&!this.store.settings().running,pauseRequested:this.pauseGeneration===this.generation&&(this.starts.size>0||!!this.active),operation};
  }
  async observeOperation<T>(kind:string,label:string,current:{planId?:number;title?:string;keyword?:string},call:()=>Promise<T>):Promise<T>{
    const id=this.instanceId+':'+(++this.operationSeq);
    this.operations.set(id,{id,kind,label,startedAt:this.clock(),...current});
    try{return await call();}finally{this.operations.delete(id);}
  }
  display(now:number,writesEnabled:boolean,facts=this.store.runtimeFacts(now)):RuntimeDisplay {
    return buildRuntimeDisplay(facts,this.observation(),writesEnabled,this.instanceId,++this.snapshotSeq);
  }
  status(now=this.clock(),display?:RuntimeDisplay):SchedulerStatus {
    if(!display)return schedulerStatusSchema.parse({...this.runtime,serverNow:now});
    const c=display.interaction.state==='ready'||display.interaction.at!==null?display.interaction:display.search;
    const phase=display.operation?display.operation.kind:display.control.pauseRequested?'pause_requested':display.control.starting?'checking_login':!display.control.running?'paused':c.state==='blocked'?'manual_review':c===display.search?'waiting_search':'waiting_plan';
    return schedulerStatusSchema.parse({...this.runtime,phase,serverNow:now,reason:display.headline.detail,nextAction:{kind:!display.control.running?'manual_action':c===display.search?'search':'interaction',at:!display.control.running?null:c.at},current:display.operation?{planId:display.operation.planId,title:display.operation.title,keyword:display.operation.keyword}:null,inFlight:display.operation!==null||display.attention.waitingEnd>0,pauseRequested:display.control.pauseRequested,timeoutAt:null});
  }
  private setStatus(phase:SchedulerPhase,reasonCode:SchedulerReasonCode,reason='',options:{nextAction?:SchedulerNextAction;deadlineAt?:number|null;timeoutAt?:number|null;current?:SchedulerCurrent|null;inFlight?:boolean;pauseRequested?:boolean}={}) {
    const now=this.clock();
    const same=this.runtime.phase===phase&&this.runtime.reasonCode===reasonCode&&this.runtime.reason===reason&&JSON.stringify(this.runtime.current)===JSON.stringify(options.current??null);
    this.runtime=schedulerStatusSchema.parse({phase,phaseSince:same?this.runtime.phaseSince:now,serverNow:now,reasonCode,reason,nextAction:options.nextAction??{kind:'none',at:null},deadlineAt:options.deadlineAt??null,timeoutAt:options.timeoutAt??null,current:options.current??null,inFlight:options.inFlight??false,pauseRequested:options.pauseRequested??false});
  }
  private reasonCodeForPause(reason:string):SchedulerReasonCode {
    if(reason===STARTUP_PAUSE||reason.startsWith('启动后暂停'))return 'startup_paused';
    if(/风控|验证码/.test(reason))return 'risk_paused';
    if(/登录|账号|UID/.test(reason))return 'auth_required';
    if(/写操作/.test(reason))return 'writes_disabled';
    if(/服务停止/.test(reason))return 'service_stopped';
    return 'manual_paused';
  }
  private waitingStatus(now=this.clock()) {
    const settings=this.store.settings();
    if(!settings.running){this.setStatus('paused',this.reasonCodeForPause(settings.pauseReason),settings.pauseReason,{nextAction:{kind:'manual_action',at:null}});return;}
    if(settings.readRetryAt>now){this.setStatus('backoff','read_backoff','读取退避中',{nextAction:{kind:'retry_search',at:settings.readRetryAt}});return;}
    if(settings.retryAt>now){this.setStatus('backoff','interaction_backoff','互动退避中',{nextAction:{kind:'retry_interaction',at:settings.retryAt}});return;}
    const queue=this.store.queueSummary(now);
    if(queue.uncertain>0&&this.store.anyRequestInFlight()){this.setStatus('uncertain','request_in_flight','发送结果仍在确认中',{nextAction:{kind:'manual_action',at:null},inFlight:true});return;}
    if(queue.nextDueAt!==null){this.setStatus('waiting_plan',queue.overdue>0?'overdue':'none',queue.overdue>0?'存在逾期互动计划':'等待互动计划到期',{nextAction:{kind:'interaction',at:queue.nextDueAt}});return;}
    const topics=this.store.topics(now).filter(topic=>topic.enabled&&topic.nextSearch>0).sort((a,b)=>a.nextSearch-b.nextSearch);
    if(topics.length){this.setStatus('waiting_search','none','等待下一次搜索',{nextAction:{kind:'search',at:topics[0].nextSearch,topicId:topics[0].id}});return;}
    if(queue.waitingTemplate>0){this.setStatus('waiting_plan','waiting_template','等待可用模板',{nextAction:{kind:'manual_action',at:null}});return;}
    if(queue.pausedChannel>0){this.setStatus('waiting_plan','channel_disabled','频道已暂停',{nextAction:{kind:'manual_action',at:null}});return;}
    this.setStatus('idle','no_task','当前没有可执行任务',{nextAction:{kind:'none',at:null}});
  }
  startTimer(){this.timer=setInterval(()=>void this.tick(),1000);}
  async pause(reason='手动暂停'){
    const generation=++this.generation;this.pauseGeneration=generation;
    const pending=[...this.starts,...(this.active?[this.active]:[])];
    const settings=this.store.settings();settings.running=false;settings.pauseReason=reason;this.store.saveSettings(settings);
    this.setStatus(pending.length?'pause_requested':'paused',this.reasonCodeForPause(reason),reason,{nextAction:{kind:'manual_action',at:null},inFlight:pending.length>0,pauseRequested:pending.length>0});
    await Promise.allSettled(pending);
    if(generation===this.generation)this.setStatus('paused',this.reasonCodeForPause(reason),reason,{nextAction:{kind:'manual_action',at:null}});
  }
  run():Promise<void>{
    // Establish ownership before the first await; a later pause always wins.
    const generation=++this.generation;this.startGeneration=generation;
    const settings=this.store.settings();settings.running=false;settings.pauseReason='启动检查中';this.store.saveSettings(settings);
    const task=this.start(generation);
    this.starts.add(task);
    void task.then(()=>this.starts.delete(task),()=>this.starts.delete(task));
    return task;
  }
  private async start(generation:number){
    await this.active;
    if(generation!==this.generation)return;
    this.setStatus('checking_login','none','正在检查登录状态',{nextAction:{kind:'login_check',at:null},inFlight:true});
    try {
      const account=await this.observeOperation('checking_login','正在检查登录状态',{},()=>this.bili.checkLogin());
      if(generation!==this.generation)return;
      const settings=this.store.settings();settings.account=account;this.store.saveSettings(settings);
      if(!account.loggedIn||!account.uid)throw new BiliError('auth');
      const binding=this.store.accountBinding();
      if(!binding){const result=this.store.bindAccount(account.uid,true);if(!result.ok)throw new BiliError('auth','unknown','not_applicable','account_binding_required',undefined,result.reason);}
      else if(!binding.verified||binding.uid!==account.uid)throw new BiliError('auth','unknown','not_applicable','account_uid_mismatch',undefined,'账号 UID 与数据库绑定不一致，请人工确认');
      if(generation!==this.generation)return;
      settings.running=true;settings.pauseReason='';settings.failures=0;settings.retryAt=0;settings.readFailures=0;settings.readRetryAt=0;
      this.nextLoginCheck=this.clock()+300000;this.store.saveSettings(settings);this.waitingStatus();
    }catch(error){
      if(generation!==this.generation)return;
      const failure=error instanceof BiliError?error:new BiliError('api');
      const settings=this.store.settings();settings.pauseReason=failure.message;this.store.saveSettings(settings);
      this.setStatus('manual_review',failure.kind==='risk'?'risk_paused':failure.kind==='auth'?'auth_required':'manual_paused',failure.message,{nextAction:{kind:'manual_action',at:null}});
      throw error;
    }
  }
  tick(){if(this.starts.size)return Promise.resolve();if(this.active)return this.active;this.active=this.cycle().finally(()=>{this.active=undefined;});return this.active;}
  saveTopic(config:TopicConfig,id?:number){
    if(config.enabled&&!id)throw new Error('新频道请先保存为停用状态，添加评论和回复模板后再启用');
    if(config.enabled&&id){const current=this.store.templates().filter(t=>t.topicId===id&&t.enabled);if(!current.some(t=>t.kind==='comment')||!current.some(t=>t.kind==='reply'))throw new Error('启用频道前需要至少一个评论模板和一个回复模板');}
    return this.store.saveTopic(config,id);
  }
  private planTitle(video:string,bvid:string){try{const value=JSON.parse(video);return typeof value.title==='string'?value.title:bvid;}catch{return bvid;}}
  private live(generation:number){return generation===this.generation&&this.store.settings().running;}
  private wait(min:number,max:number){return Math.round((min+this.random()*Math.max(0,max-min))*60000);}
  private log(topic:Topic|undefined,action:string,result:string,details:Partial<Activity>={}){
    this.store.log({time:this.clock(),topicId:topic?.id??null,topic:topic?.name??'系统',keyword:'',bvid:'',title:'',author:'',action,content:'',target:'',result,error:'',...details});
  }
  private fail(error:unknown,topic?:Topic,details:Partial<Activity>={},channel:'read'|'interaction'='read'){
    const failure=error instanceof BiliError?error:new BiliError('api');const settings=this.store.settings();
    if(channel==='interaction')settings.failures++;else settings.readFailures++;
    const count=channel==='interaction'?settings.failures:settings.readFailures;const retryAt=this.clock()+Math.min(3600000,60000*2**Math.min(count-1,6));
    if(channel==='interaction')settings.retryAt=retryAt;else settings.readRetryAt=retryAt;
    const paused=failure.kind==='risk'||failure.kind==='auth'||failure.kind==='disabled'||count>=settings.limits.failureLimit;
    if(paused){settings.running=false;settings.pauseReason=failure.message;this.generation++;}
    if(failure.kind==='auth')settings.account={loggedIn:false,message:failure.message};
    this.store.saveSettings(settings);
    if(paused)this.setStatus('manual_review',failure.kind==='risk'?'risk_paused':failure.kind==='auth'?'auth_required':failure.kind==='disabled'?'writes_disabled':'interaction_backoff',failure.message,{nextAction:{kind:'manual_action',at:null}});
    else this.setStatus('backoff',channel==='interaction'?'interaction_backoff':'read_backoff',failure.message,{nextAction:{kind:channel==='interaction'?'retry_interaction':'retry_search',at:retryAt}});
    this.log(topic,'error','失败',{...details,error:failure.message});
  }
  private async idleLoginCheck(){
    if(this.clock()<this.nextIdleCheck)return;this.nextIdleCheck=this.clock()+12*3600000;
    this.setStatus('checking_login','none','正在检查登录状态',{nextAction:{kind:'login_check',at:null},inFlight:true});
    try{const account=await this.observeOperation('checking_login','正在检查登录状态',{},()=>this.bili.checkLogin());const settings=this.store.settings();if(settings.running)return;settings.account=account;
      const binding=this.store.accountBinding();if(account.loggedIn&&account.uid&&binding&&binding.uid!==account.uid)settings.pauseReason='账号 UID 与数据库绑定不一致，请人工确认';
      else if(account.loggedIn&&settings.pauseReason===STARTUP_PAUSE)settings.pauseReason='启动后暂停；登录有效，可手动启动巡逻';
      this.store.saveSettings(settings);this.waitingStatus();
    }catch{this.nextIdleCheck=this.clock()+5*60000;this.setStatus('paused','auth_required','登录检查失败，请查看活动',{nextAction:{kind:'manual_action',at:null}});}
  }
  private async cycle(){
    const initial=this.store.settings();if(!initial.running)return this.idleLoginCheck();const generation=this.generation;
    try{
      const now=this.clock();const readBackoff=now<initial.readRetryAt;
      const topics=this.store.topics(now);const dueSearch=!readBackoff&&topics.some(t=>t.enabled&&t.nextSearch<=now);
      const duePlan=this.store.dueInteractionPlans(now,1).length>0;const dueUncertain=this.store.dueUncertainInteractionPlans(now,1).length>0;
      if(!dueSearch&&!duePlan&&!dueUncertain&&now<this.nextLoginCheck)return;
      this.setStatus('checking_login','none','正在检查登录状态',{nextAction:{kind:'login_check',at:null},inFlight:true});
      const account=await this.observeOperation('checking_login','正在检查登录状态',{},()=>this.bili.checkLogin());if(!this.live(generation))return;
      if(!account.loggedIn||!account.uid)throw new BiliError('auth');
      const current=this.store.settings();current.account=account;this.store.saveSettings(current);
      const binding=this.store.accountBinding();if(!binding||!binding.verified||binding.uid!==account.uid)throw new BiliError('auth');
      this.nextLoginCheck=now+300000;
      if(!readBackoff)for(const topic of topics){if(!this.live(generation)||!topic.enabled||topic.nextSearch>now)continue;await this.discover(topic,generation);if(this.store.settings().readRetryAt>this.clock())break;}
      if(this.live(generation))await this.interact(generation);
      if(this.live(generation))this.waitingStatus(this.clock());
    }catch(error){this.fail(error);}
  }
  private async discover(topic:Topic,generation:number){
    const now=this.clock();const settings=this.store.settings();
    if(this.store.count('search',now,topic.id)>=topic.dailySearch||this.store.count('search',now)>=settings.limits.dailySearch){this.store.db.prepare('UPDATE topics SET next_search=? WHERE id=?').run(dayStart(now)+86400000,topic.id);return;}
    const keywords=[...new Map(topic.keywords.map(value=>[normalizeSearchText(value),value])).values()];
    const searchedKeyword=keywords[this.store.count('search',now,topic.id)%keywords.length];
    this.store.db.prepare('UPDATE topics SET next_search=?,last_run=? WHERE id=?').run(now+this.wait(topic.intervalMin,topic.intervalMax),now,topic.id);
    this.setStatus('searching','none','正在搜索视频',{nextAction:{kind:'search',at:null,topicId:topic.id},current:{topicId:topic.id,keyword:searchedKeyword},inFlight:true});
    let videos:Video[];try{videos=await this.observeOperation('searching','正在搜索视频',{keyword:searchedKeyword},()=>this.bili.search(searchedKeyword));}catch(error){this.fail(error,topic,{keyword:searchedKeyword});return;}
    if(!this.live(generation))return;const recovered=this.store.settings();recovered.readFailures=0;recovered.readRetryAt=0;this.store.saveSettings(recovered);
    let matched=0,duplicates=0,created=0;
    for(const video of videos){
      if(!this.live(generation))return;const latest=this.store.topic(topic.id);if(!latest?.enabled)return;
      const matchedKeyword=topic.keywords.find(value=>keywordMatchesTitle(value,video.title));if(!matchedKeyword)continue;matched++;
      if(this.store.db.prepare('SELECT bvid FROM discoveries WHERE bvid=? OR aid=?').get(video.bvid,video.aid)){duplicates++;continue;}
      const templates=this.store.templates().filter(t=>t.topicId===topic.id&&t.enabled);const comments=templates.filter(t=>t.kind==='comment').map(t=>t.text);const replies=templates.filter(t=>t.kind==='reply').map(t=>t.text);
      if(!comments.length||!replies.length){this.log(latest,'error','缺少评论或回复模板，未入池',{keyword:matchedKeyword,bvid:video.bvid,title:video.title,author:video.author});continue;}
      const roll=this.random()*100;const deferred=roll<70;const action:InteractionAction=deferred?(this.random()<.8?'comment':'reply'):roll<90?'comment':'reply';
      const matchedField='title';
      const plan=this.store.createInteractionPlan({video,topicId:topic.id,ownerUid:this.store.account().uid!,topicName:topic.name,keyword:matchedKeyword,matchedField,plannedAction:action,commentTemplates:comments,replyTemplates:replies,createdAt:now,dueAt:now+this.wait(settings.limits.waitMin,settings.limits.waitMax),cycleStartDay:dayStart(now),cycleDeadlineDay:dayStart(now)+30*86400000,overflow:false,deferred});
      if(plan){created++;this.log(latest,'queue','已建立互动计划',{keyword:matchedKeyword,bvid:video.bvid,title:video.title,author:video.author,content:action});}else duplicates++;
    }
    this.log(topic,'search','搜索完成',{keyword:searchedKeyword,content:`返回 ${videos.length} 条，匹配 ${matched} 条，重复 ${duplicates} 条，新增计划 ${created} 条`});
  }
  private dispatchClass(plan:{cycleDeadlineDay:number;overflow:boolean},now:number):'ordinary'|'overdue'{
    const today=dayStart(now);return today>plan.cycleDeadlineDay||(plan.overflow&&today>=plan.cycleDeadlineDay)?'overdue':'ordinary';
  }
  private async pollUncertain(generation:number){
    const plans=this.store.dueUncertainInteractionPlans(this.clock(),10);
    for(const plan of plans){
      if(!this.live(generation))return;
      const attempt=this.store.latestInteractionAttempt(plan.id);
      if(!attempt){this.store.deferUncertainPoll(plan.id,this.clock());continue;}
      try{
        if(!this.bili.operationStatus){this.store.deferUncertainPoll(plan.id,this.clock());continue;}
        this.setStatus('uncertain','uncertain_result','发送结果仍不确定',{nextAction:{kind:'manual_action',at:null},current:{planId:plan.id,action:attempt.effectiveAction,bvid:plan.bvid},inFlight:true});
        const status=await this.observeOperation('waiting_receipt','正在查询原请求结果',{planId:plan.id,title:this.planTitle(plan.video,plan.bvid)},()=>this.bili.operationStatus!(plan.bvid,attempt.content,attempt.targetId,attempt.operationId));
        if(status.status==='running'){
          this.store.markRequestInFlight(attempt.id,true,this.clock(),'桥接报告原写请求仍在运行');
          this.store.deferUncertainPoll(plan.id,this.clock());
          return;
        }
        if(status.status==='succeeded'){
          this.store.recordLateReceipt(attempt.id,JSON.stringify(status.result??{}),this.clock(),'幂等操作账本返回原发送成功回执');
          continue;
        }
        if(status.status==='confirmed_failure'){
          const result=typeof status.result==='object'&&status.result!==null?status.result as Record<string,unknown>:{};
          if(result.send_state==='confirmed_not_sent'){
            const failureStage=result.stage==='prepare'||result.stage==='send'||result.stage==='receipt'?result.stage:'send';
            const failure=new BiliError(result.error_type==='risk'||result.error_type==='auth'||result.error_type==='disabled'?result.error_type:'api',failureStage,'confirmed_not_sent',typeof result.error_code==='string'?result.error_code:'confirmed_api_failure');
            const allocation=this.store.rescheduleFailedPlan(plan,this.clock());
            this.store.finishInteractionAttempt({attemptId:attempt.id,outcome:'confirmed_failure',finishedAt:this.clock(),retryAt:allocation.dueAt,retryOverflow:allocation.overflow,failureStage,errorCode:failure.errorCode,evidence:'桥接操作日志确认平台未接受发送'});
            this.fail(failure,undefined,{bvid:plan.bvid},'interaction');
            if(!this.live(generation))return;
          }else{
            this.store.markRequestInFlight(attempt.id,false,this.clock(),'桥接调用结束，但日志未能证明平台未接收');
          }
          continue;
        }
        if(status.status==='not_found'){
          // Missing journal data is not enough evidence to permit an automatic retry.
          this.store.deferUncertainPoll(plan.id,this.clock());
          continue;
        }
        this.store.markRequestInFlight(attempt.id,false,this.clock(),status.status==='interrupted'?'桥接进程结束，发送结果仍待人工核查':'原桥接调用已结束，平台结果仍不确定');
      }catch(error){
        this.store.deferUncertainPoll(plan.id,this.clock());
        this.fail(error,undefined,{bvid:plan.bvid},'read');
        if(!this.live(generation))return;
      }
    }
  }
  private async interact(generation:number){
    const settings=this.store.settings();if(this.clock()<settings.retryAt){this.setStatus('backoff','interaction_backoff','互动退避中',{nextAction:{kind:'retry_interaction',at:settings.retryAt}});return;}
    await this.pollUncertain(generation);if(!this.live(generation))return;
    if(this.store.anyRequestInFlight()){this.setStatus('uncertain','request_in_flight','发送请求仍在确认中',{nextAction:{kind:'manual_action',at:null},inFlight:true});return;}
    if(this.clock()<this.store.settings().nextInteraction){this.setStatus('waiting_plan','interaction_spacing','等待互动间隔',{nextAction:{kind:'interaction',at:this.store.settings().nextInteraction}});return;}
    const plans=this.store.dueInteractionPlans(this.clock(),100);
    for(const plan of plans){
      if(!this.live(generation))return;const now=this.clock();if(plan.nextPrepareAt!==null&&plan.nextPrepareAt>now)continue;
      const topic=plan.topicId===null?undefined:this.store.topic(plan.topicId);if(!topic?.enabled||plan.orphaned||plan.cancelRequested)continue;
      const dispatchClass=this.dispatchClass(plan,now);const action=plan.plannedAction;let effective=action;let target='';let targetId=0;let targetUid='';let fallback='';let candidates:OrdinaryComment[]=[];
      if(!this.store.canClaimNow(now,topic.id,action,dispatchClass)&&!(action==='reply'&&this.store.canClaimNow(now,topic.id,'comment',dispatchClass))){this.store.deferPlanForCapacity(plan.id,plan.version,now);continue;}
      if(action==='reply'){
        if(!this.store.beginPlanPreparation(plan.id,plan.version,now))continue;
        this.setStatus('reading_comments','none','正在读取回复对象',{nextAction:{kind:'interaction',at:plan.dueAt},current:{planId:plan.id,action:'reply',bvid:plan.bvid,title:this.planTitle(plan.video,plan.bvid),keyword:plan.keyword},inFlight:true});
        try{candidates=(await this.observeOperation('reading_comments','正在寻找回复对象',{planId:plan.id,title:this.planTitle(plan.video,plan.bvid)},()=>this.bili.comments(plan.bvid))).filter(value=>safeComment(value)&&value.uid!==this.store.account().uid);}
        catch(error){this.store.recordPlanPreparationFailure(plan.id,plan.version,now,now+86400000,error instanceof BiliError?error.errorCode||'prepare_failed':'prepare_failed','回复对象读取失败');this.fail(error,topic,{bvid:plan.bvid},'read');continue;}
        if(candidates.length){const chosen=candidates[Math.floor(this.random()*candidates.length)];target=chosen.user;targetId=chosen.rpid;targetUid=chosen.uid??'';}
        else{effective='comment';fallback='成功读取评论但没有合格对象';}
      }
      if(!this.store.canClaimNow(this.clock(),topic.id,effective,dispatchClass)){
        if(action==='reply'&&effective==='comment')this.store.deferPlanPreparation(plan.id,plan.version,this.clock());
        else this.store.deferPlanForCapacity(plan.id,plan.version,this.clock());
        continue;
      }
      // A snapshot may be reused for different videos; only blank templates are unusable.
      const pool=(effective==='comment'?plan.commentTemplates:plan.replyTemplates).filter(text=>text.trim().length>0);
      if(!pool.length){this.store.setPlanWaitingTemplate(plan.id,plan.version,this.clock(),'没有可用模板');continue;}
      const text=pool[Math.min(pool.length-1,Math.floor(this.random()*pool.length))];
      let account:Account;
      this.setStatus('checking_login','none','正在复核登录状态',{nextAction:{kind:'login_check',at:null},current:{planId:plan.id,action:effective,bvid:plan.bvid,title:this.planTitle(plan.video,plan.bvid),keyword:plan.keyword},inFlight:true});
      try{account=await this.observeOperation('checking_login','正在检查登录状态',{},()=>this.bili.checkLogin());}
      catch(error){
        const currentPlan=this.store.interactionPlan(plan.id);const at=this.clock();
        if(currentPlan&&currentPlan.state==='scheduled')this.store.recordPlanPreflightFailure(plan.id,currentPlan.version,at,at+86400000,error instanceof BiliError?error.errorCode||'account_check_failed':'account_check_failed','发送前登录复核失败');
        this.fail(error,topic,{bvid:plan.bvid},'interaction');continue;
      }
      const binding=this.store.accountBinding();
      if(!account.loggedIn||!account.uid||account.uid!==plan.ownerUid||!binding?.verified||binding.uid!==account.uid){
        const failure=new BiliError('auth','unknown','not_applicable','account_uid_mismatch',undefined,'账号 UID 与计划归属不一致，请核对后手动恢复');
        const currentPlan=this.store.interactionPlan(plan.id);const at=this.clock();
        if(currentPlan&&currentPlan.state==='scheduled')this.store.recordPlanPreflightFailure(plan.id,currentPlan.version,at,at+86400000,failure.errorCode,failure.message);
        const current=this.store.settings();current.account=account;this.store.saveSettings(current);
        this.fail(failure,topic,{bvid:plan.bvid},'interaction');continue;
      }
      const current=this.store.settings();const latest=this.store.interactionPlan(plan.id);if(!latest||latest.version!==plan.version||!this.live(generation)||!this.store.topic(topic.id)?.enabled)continue;
      const claimTime=this.clock();const currentClass=this.dispatchClass(latest,claimTime);if(!this.store.canClaimNow(claimTime,topic.id,effective,currentClass)){this.store.deferPlanForCapacity(plan.id,latest.version,claimTime);continue;}
      const attempt=this.store.claimInteractionPlan({planId:latest.id,expectedVersion:latest.version,now:claimTime,quotaDay:dayStart(claimTime),dispatchClass:currentClass,billingTopicId:topic.id,billingTopicName:topic.name,senderUid:account.uid,effectiveAction:effective,fallbackReason:fallback,content:text,target,targetId,targetUid,nextInteractionAt:claimTime+this.wait(current.limits.waitMin,current.limits.waitMax),limits:current.limits});
      if(!attempt)continue;
      this.setStatus('sending','none','正在发送互动',{nextAction:{kind:'interaction',at:null},current:{planId:latest.id,action:effective,bvid:latest.bvid,title:this.planTitle(latest.video,latest.bvid),keyword:latest.keyword},inFlight:true});
      try{const receipt=await this.observeOperation('sending',effective==='comment'?'正在发表评论':'正在发表回复',{planId:latest.id,title:this.planTitle(latest.video,latest.bvid)},()=>this.bili.post(latest.bvid,text,targetId,attempt.operationId));this.store.finishInteractionAttempt({attemptId:attempt.id,outcome:'succeeded',finishedAt:this.clock(),receipt:JSON.stringify(receipt??{}),failureStage:'receipt',evidence:'收到可信发送成功结果'});const complete=this.store.settings();complete.failures=0;complete.retryAt=0;this.store.saveSettings(complete);const video=videoSchema.parse(JSON.parse(latest.video));this.log(topic,effective,'成功',{keyword:latest.keyword,bvid:latest.bvid,title:video.title,author:video.author,content:text,target});}
      catch(error){const failure=error instanceof BiliError?error:new BiliError('api','send','uncertain');const outcome=failure.sendState==='confirmed_not_sent'?'confirmed_failure':'uncertain';const requestInFlight=outcome==='uncertain';const allocation=outcome==='confirmed_failure'?this.store.rescheduleFailedPlan(latest,this.clock()):undefined;this.store.finishInteractionAttempt({attemptId:attempt.id,outcome,finishedAt:this.clock(),requestInFlight,failureStage:failure.stage==='unknown'?'send':failure.stage,errorCode:failure.errorCode||failure.kind,retryAt:allocation?.dueAt,retryOverflow:allocation?.overflow??false,evidence:outcome==='confirmed_failure'?'已确认未发送':'发送结果不能确定'});this.fail(failure,topic,{keyword:latest.keyword,bvid:latest.bvid,content:text,target},'interaction');}
      return;
    }
  }
  async close(){clearInterval(this.timer);await this.pause('服务停止');}
}
