import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimePanel } from '../web/runtime-panel.js';
import { serverTime,until,beijing } from '../web/runtime-time.js';
import { createStatePoller, type ConnectionState } from '../web/state-poller.js';
import { runtimeFixture,deferred } from './runtime-fixture.js';

test('U01/U02/U13: monotonic anchors survive wall-clock jumps and format Beijing explicitly',()=>{
 const anchor={serverNow:Date.parse('2026-10-17T00:00:00+08:00'),receivedAt:100};assert.equal(serverTime(anchor,1100),anchor.serverNow+1000);assert.equal(until(anchor.serverNow,anchor.serverNow),'已到时间，正在重新确认');assert.equal(until(anchor.serverNow-86400000,anchor.serverNow).includes('-'),false);assert.match(beijing(anchor.serverNow),/2026.*10.*17.*00:00:00.*北京时间/);
});
test('U11/U13: pure runtime UI renders simple reasons and direct actions without a resetting phase stopwatch',()=>{
 const f=runtimeFixture();try{f.plan();const d=f.scheduler.display(f.now(),true);d.attention={total:1,waitingEnd:0,items:[{key:'plan-1',planId:1,label:'这条评论需要核实发送结果',detail:'核对后处理',href:'/plans?state=uncertain&planId=1',canResolve:true}]};const html=renderToStaticMarkup(React.createElement(RuntimePanel,{display:d,connection:'fresh',now:f.now()}));assert.match(html,/下一次搜索/);assert.match(html,/视频互动/);assert.match(html,/去核实/);assert.match(html,/plans\?state=uncertain&amp;planId=1/);assert.equal(html.includes('当前阶段已运行'),false);assert.equal(html.includes('已到期 1天'),false);}finally{f.store.close();}
});
test('U04/U06: stale UI labels history instead of advertising live running or countdown promises',()=>{
 const f=runtimeFixture();try{f.plan();const html=renderToStaticMarkup(React.createElement(RuntimePanel,{display:f.scheduler.display(f.now(),true),connection:'offline',now:f.now()}));assert.match(html,/无法连接本机服务/);assert.match(html,/安排待更新/);assert.equal(html.includes('服务在线'),false);assert.equal(html.includes('可尝试'),false);}finally{f.store.close();}
});
test('U05/A06: polling is single-flight and rejects old snapshots after restart',async()=>{
 const response=deferred<unknown>();let calls=0;let payload:unknown;const received:number[]=[];const states:ConnectionState[]=[];
 const poll=createStatePoller<{instanceId:string;snapshotSeq:number}>({fetch:()=>{calls++;return calls===1?response.promise:Promise.resolve(payload);},parse:x=>x as {instanceId:string;snapshotSeq:number},version:x=>x,data:x=>received.push(x.snapshotSeq),connection:x=>states.push(x),now:()=>100});
 try{const a=poll.refresh();const b=poll.refresh();assert.equal(a,b);assert.equal(calls,1);response.resolve({instanceId:'old',snapshotSeq:10});await a;payload={instanceId:'new',snapshotSeq:1};await poll.refresh();payload={instanceId:'old',snapshotSeq:11};await poll.refresh();payload={instanceId:'new',snapshotSeq:0};await poll.refresh();assert.deepEqual(received,[10,1]);assert.equal(states.at(-1),'fresh');}finally{poll.stop();}
});
test('U04/U03: timeout, freshness and disposal cannot publish late data',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});const response=deferred<unknown>();let now=0;const received:unknown[]=[];const states:ConnectionState[]=[];
 const poll=createStatePoller({fetch:()=>response.promise,parse:x=>x,data:x=>received.push(x),connection:x=>states.push(x),now:()=>now});
 const request=poll.refresh();t.mock.timers.tick(5000);await request;assert.equal(states.at(-1),'offline');response.resolve({late:true});await Promise.resolve();assert.deepEqual(received,[]);poll.stop();
 const good=createStatePoller({fetch:async()=>({}),parse:x=>x,data:()=>{},connection:x=>states.push(x),now:()=>now});await good.refresh();now=15001;good.checkFreshness();assert.equal(states.at(-1),'stale');good.stop();t.mock.timers.reset();
});
test('A04: incompatible API data is not classified as a stopped service',async()=>{let connection='';const p=createStatePoller({fetch:async()=>({old:true}),parse:()=>{throw Error('schema mismatch');},data:()=>assert.fail(),connection:x=>{connection=x;},now:()=>0});try{await p.refresh();assert.equal(connection,'incompatible');}finally{p.stop();}});
