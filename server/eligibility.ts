import { dayStart, type DisplayReason, type Limits } from './model.js';
export interface QuotaUsage { total:number; action:number; topicAction:number; overdue:number }
export function quotaDecision(now:number,limits:Limits,topic:{dailyComment:number;dailyReply:number},action:'comment'|'reply',overdue:boolean,used:QuotaUsage):DisplayReason[] {
 const tomorrow=dayStart(now)+86400000;
 const checks:[string,string,number,number][]=[['total_quota','今日总互动额度',limits.dailyTotal,used.total],['action_quota',action==='comment'?'今日评论额度':'今日回复额度',action==='comment'?limits.dailyComment:limits.dailyReply,used.action],['topic_quota','当前频道额度',action==='comment'?topic.dailyComment:topic.dailyReply,used.topicAction]];
 const reasons:DisplayReason[]=[];
 for(const [code,label,limit,count] of checks){if(limit===0)reasons.push({code:'zero_'+code,label:label+'设为0，需要调整设置',at:null});else if(count>=limit)reasons.push({code,label:label+'已用完',at:tomorrow});}
 if(overdue){const index=Math.floor((dayStart(now)+8*3600000)/86400000);const limit=Math.floor(limits.dailyTotal/2)+(limits.dailyTotal%2&&index%2===0?1:0);if(used.overdue>=limit)reasons.push({code:'overdue_quota',label:'超过30天任务的今日名额已用完',at:tomorrow});}
 return reasons;
}
