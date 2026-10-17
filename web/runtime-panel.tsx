import React from 'react';
import type { RuntimeDisplay, DisplayChannel } from '../server/model.js';
import type { ConnectionState } from './state-poller.js';
import { beijing,duration,until } from './runtime-time.js';
const action={comment:'评论',reply:'回复'};
function ChannelRow({name,value,now,fresh}:{name:string;value:DisplayChannel;now:number;fresh:boolean}){
 return <div className="channel-row"><strong>{name}</strong><div><span>{fresh?value.title:'安排待更新'}</span>{fresh&&value.at!==null&&<><b className="channel-time">{until(value.at,now)}{value.timeKind==='check'?' · 再检查':' · 可尝试'}</b><small>{beijing(value.at)}</small></>}{fresh&&value.keyword&&<small>关键词：{value.keyword}{value.topicName?' · '+value.topicName:''}</small>}{fresh&&value.candidate&&<small>{action[value.candidate.action]}《{value.candidate.title}》</small>}</div></div>;
}
export function RuntimePanel({display,connection,now}:{display:RuntimeDisplay;connection:ConnectionState;now:number}){
 const fresh=connection==='fresh';const messages={connecting:'正在连接本机服务',fresh:'',offline:'无法连接本机服务',stale:'运行状态正在更新',incompatible:'页面与服务版本不兼容，需要更新服务或刷新页面'};
 return <><section className={`runtime-card ${fresh?display.headline.tone:'paused'}`}>
  <div className="runtime-top"><div><span className="eyebrow">现在在做什么</span><h2>{fresh?display.headline.title:messages[connection]}</h2></div><span className="runtime-badge">{fresh?'服务在线':'实时状态暂不可确认'}</span></div>
  <p className="runtime-reason">{fresh?display.headline.detail:'下方保留最近记录；搜索和发送安排以重新连接后的状态为准。'}</p>
  {fresh&&display.operation&&<p className="operation-elapsed">已等待 <strong>{duration(now-display.operation.startedAt)}</strong> · 等待当前操作返回结果</p>}
  <ChannelRow name="下一次搜索" value={display.search} now={now} fresh={fresh}/><ChannelRow name="视频互动" value={display.interaction} now={now} fresh={fresh}/>
 </section>
 {display.attention.total>0&&<section className="attention-card"><h2>需要处理 <small>{display.attention.total} 项{!fresh?' · 最近记录':''}</small></h2>{display.attention.waitingEnd>0&&<p className="warning">有原请求尚未确认结束，其他评论暂缓。原请求结果需先确认；搜索按自己的安排处理。</p>}{display.attention.items.map(item=><div className="attention-item" key={item.key}><div><strong>{item.label}</strong><p>{item.detail}</p></div><a className="review-link" href={item.href}>{item.key==='account'?'去登录':item.key==='writes'?'查看设置':item.label.includes('模板')?'补充模板':'去核实'}</a></div>)}</section>}
 <section><h2>今日完成 <small>按发送发起日统计 · 北京时间</small></h2><div className="runtime-totals"><span>评论 <strong>{display.totals.commentSucceeded}</strong> 条</span><span>回复 <strong>{display.totals.replySucceeded}</strong> 条</span><span>待处理 <strong>{display.totals.pending}</strong> 条</span><span>需要核实或处理 <strong>{display.totals.needReview}</strong> 条</span></div></section>
 <section><div className="section-heading"><h2>接下来 <small>基于当前已知计划</small></h2><a href="/plans">查看全部计划</a></div>{display.upcoming.length===0?<p className="empty">暂无待执行计划。</p>:display.upcoming.map(plan=><a className="upcoming-plan" href={plan.href} key={plan.id}><span className="tag">{action[plan.action]} · {plan.deferred?'延后计划':'普通计划'}</span><strong>{plan.title}</strong><small>{beijing(plan.currentDueAt)} · {!fresh?'状态待更新':plan.beyondCycle?'超过30天未完成':plan.currentDueAt<=now?'已到执行时间；当前安排见上方':'等待计划时间'}</small></a>)}</section>
 </>;
}
