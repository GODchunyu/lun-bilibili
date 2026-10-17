import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { topicSchema, templateSchema, settingsSchema, aiSettingsSchema, activitySchema, recentCommentSchema, interactionPlanSchema, interactionAttemptSchema, queueSummarySchema, schedulerStatusSchema, runtimeDisplaySchema, type TopicConfig, type Topic, type Template, type Limits, type Activity, type RecentComment, type InteractionPlan } from '../server/model.js';
import { RuntimePanel } from './runtime-panel.js';
import { serverTime } from './runtime-time.js';
import { createStatePoller, type ConnectionState } from './state-poller.js';
import './style.css';
const stateSchema = z.object({
  display: runtimeDisplaySchema,
  serverNow: z.number(),
  runtime: schedulerStatusSchema,
  queue: queueSummarySchema,
  settings: settingsSchema,
  topics: z.array(topicSchema.and(z.object({ id: z.number(), nextSearch: z.number(), lastRun: z.number().nullable(), todayDiscovered: z.number(), todayInteractions: z.number() }))),
  templates: z.array(templateSchema.extend({ id: z.number() })), plans: z.array(interactionPlanSchema).default([]),
  recentComments: z.array(recentCommentSchema), today: z.record(z.number()),
  system: z.object({ version: z.string(), node: z.string(), uptime: z.number(), writesEnabled: z.boolean(), queued: z.number(), attempts:z.number().default(0), overdue:z.number().default(0), overflow:z.number().default(0), createdToday:z.number().default(0), succeededToday:z.number().default(0), earliestOverdue:z.number().nullable().default(null), accountBinding:z.object({uid:z.string(),boundAt:z.number(),verified:z.boolean()}).nullable().default(null), legacyOwnershipPending:z.boolean().default(false) }),
});
type State = z.infer<typeof stateSchema> & { receivedAt:number };
type Mutate = (path: string, method: string, body?: unknown) => Promise<void>;
const pages = { dashboard: '总览', topics: '巡逻频道', plans: '互动计划', templates: '评论模板', activity: '活动记录', settings: '设置' };
type Page = keyof typeof pages;
const labels: Record<string,string> = { discover: '新建计划', deferred:'延后入池', search: '搜索', judge: '历史 AI 判断', comment: '评论', reply: '回复', skip: '跳过', error: '失败', queue: '排队' };
async function api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(`/api${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(error.success ? error.data.error : '请求失败');
  }
  return data;
}
function App() {
  const [page,setPage] = useState<Page>('dashboard');
  const [state,setState] = useState<State>();
  const [notice,setNotice] = useState('');
  const [dark,setDark] = useState(localStorage.getItem('theme') === 'dark');
  const [busy,setBusy] = useState(false);
  const [connection,setConnection]=useState<ConnectionState>('connecting');
  const poller=useRef<ReturnType<typeof createStatePoller<State>>|null>(null);
  async function refresh(){await poller.current?.refresh();}
  useEffect(()=>{
    const service=createStatePoller<State>({now:()=>performance.now(),fetch:async signal=>{const response=await fetch('/api/state',{signal});if(!response.ok)throw new Error('state request failed');return response.json();},parse:raw=>({...stateSchema.parse(raw),receivedAt:performance.now()}),version:value=>({instanceId:value.display.instanceId,snapshotSeq:value.display.snapshotSeq}),data:value=>setState(value),connection:setConnection});
    poller.current=service;service.start();
    const focus=()=>{if(document.visibilityState==='visible')void service.resync();};
    const freshness=setInterval(()=>service.checkFreshness(),1000);
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{service.stop();clearInterval(freshness);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('theme',dark ? 'dark' : 'light'); },[dark]);
  useEffect(() => {
    const onNavigation = () => { const value = window.location.pathname.slice(1); setPage(value in pages ? value as Page : 'dashboard'); };
    onNavigation(); window.addEventListener('popstate',onNavigation); return () => window.removeEventListener('popstate',onNavigation);
  },[]);
  const mutate: Mutate = async (path,method,body) => {
    if(connection!=='fresh'&&!(path==='/scheduler'&&(body as {running?:boolean})?.running===false))throw new Error('请等待运行状态更新后再操作');
    setBusy(true); setNotice('');
    try { await api(path,method,body); await refresh(); setNotice('已保存'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '请求失败'); throw error; }
    finally { setBusy(false); }
  };
  return <div className="shell">
    <aside><a className="brand" href="/dashboard">Yui<span>bilibili patrol</span></a><div className="nav-label">工作空间</div><nav>{Object.entries(pages).map(([key,label],index) => <a key={key} href={`/${key}`} className={page === key ? 'selected' : ''} onClick={event => { event.preventDefault(); setPage(key as Page); history.pushState(null,'',`/${key}`); }}><span>0{index+1}</span>{label}</a>)}</nav><div className="sidebar-bottom"><span className={`dot ${connection==='fresh'&&state?.settings.running ? 'running' : ''}`} />{connection!=='fresh'?'状态待更新':state?.settings.running ? '巡逻中' : '已暂停'}<button onClick={() => setDark(!dark)}>{dark ? '浅色模式' : '深色模式'}</button></div></aside>
    <main><header><div><div className="eyebrow">YUI / {page.toUpperCase()}</div><h1>{pages[page]}</h1></div>{state && <button disabled={busy||(!state.settings.running&&connection!=='fresh')} className={state.settings.running ? '' : 'primary'} onClick={() => { void mutate('/scheduler','POST',{ running: !state.settings.running }).catch(() => {}); }}>{state.settings.running ? '暂停巡逻' : '启动巡逻'}</button>}</header>
      {notice && <div className="notice" role="status">{notice}</div>}
      {!state ? <p role="status">{connection==='incompatible'?'页面与服务版本不兼容，请更新服务或刷新页面。':connection==='offline'?'无法连接本机服务，正在等待恢复。':'正在连接本机服务…'}</p> : <>
        {!state.settings.account.loggedIn && <div className="warning">{state.settings.account.message} · {state.settings.account.message === '登录状态待检查' ? '启动后会自动检查，稍候即可。' : '请到设置登录；未登录不会互动。'}</div>}
        {state.settings.account.loggedIn && state.settings.account.renewal?.status === 'failed' && <div className="warning">登录自动续期失败，当前登录仍可用，12 小时后重试；若持续失败请到设置重新扫码登录。</div>}
        {page === 'dashboard' && <Dashboard state={state} connection={connection} />}
        {page === 'topics' && <Topics state={state} mutate={mutate} busy={busy||connection!=='fresh'} />}
        {page === 'plans' && <Plans state={state} mutate={mutate} busy={busy||connection!=='fresh'} />}
        {page === 'templates' && <Templates state={state} mutate={mutate} busy={busy||connection!=='fresh'} />}
        {page === 'activity' && <Activities />}
        {page === 'settings' && <Settings state={state} mutate={mutate} refresh={refresh} busy={busy||connection!=='fresh'} />}
      </>}
      <footer>Yui-bilibili · 低频巡逻，安全优先 · V1</footer>
    </main>
  </div>;
}
function Dashboard({state,connection}:{state:State;connection:ConnectionState}){
 const [tick,setTick]=useState(()=>performance.now());
 useEffect(()=>{const timer=setInterval(()=>setTick(performance.now()),1000);return()=>clearInterval(timer);},[]);
 const now=serverTime({serverNow:state.serverNow,receivedAt:state.receivedAt},tick);
 return <><RuntimePanel display={state.display} connection={connection} now={now}/><section><h2>最近评论 <small>仅含已确认成功的评论与回复</small></h2><RecentComments rows={state.recentComments}/></section></>;
}
const compact = new Intl.NumberFormat('zh-CN',{ notation: 'compact', maximumFractionDigits: 1 });
function commentUrl(row: RecentComment) {
  const video = `https://www.bilibili.com/video/${encodeURIComponent(row.bvid)}/`;
  return row.rpid ? `${video}#reply${row.rpid}` : video;
}
function RecentComments({ rows }: { rows: RecentComment[] }) {
  if (!rows.length) return <p className="empty">还没有发送成功的评论。</p>;
  return <div className="comment-list">{rows.map(row => {
    const stats = [['播放',row.stats.view],['点赞',row.stats.like],['评论',row.stats.reply],['收藏',row.stats.favorite]] as const;
    return <a key={row.id} className="comment-card" href={commentUrl(row)} target="_blank" rel="noreferrer">
      <div className="cover"><span>暂无封面</span>{row.cover && <img src={row.cover.includes('@') ? row.cover : `${row.cover}@320w_180h_1c`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}</div>
      <div className="comment-body">
        <strong>{row.title || row.bvid}</strong>
        <small>UP {row.author} · {row.bvid} · {row.topic}</small>
        <p className="comment-content">{row.action === 'reply' && <span className="tag">{row.target ? `回复 @${row.target}` : '回复'}</span>}{row.content}</p>
        <small className="comment-meta"><span>{stats.filter(([,value]) => value !== undefined).map(([label,value]) => `${label} ${compact.format(value ?? 0)}`).join(' · ')}（{row.statsAt === 'post' ? '发送时' : '发现时'}）</span><span>{new Date(row.time).toLocaleString('zh-CN')}</span><span className="jump">{row.rpid ? '定位到这条评论 ↗' : '打开视频 ↗'}</span></small>
      </div>
    </a>;
  })}</div>;
}
const blankTopic: TopicConfig = { name: '', enabled: false, aiJudgment: false, writingMode: 'template', style: '', keywords: [], intervalMin: 30, intervalMax: 90, maxAgeHours: 72, minPlay: null, maxPlay: null, dailySearch: 20, dailyComment: 5, dailyReply: 3, skipProbability: 70, commentProbability: 20, replyProbability: 10 };
function Topics({ state,mutate,busy }: { state: State; mutate: Mutate; busy: boolean }) {
  const [draft,setDraft] = useState<TopicConfig & { id?: number }>();
  const [keywords,setKeywords] = useState('');
  const numberFields: [keyof TopicConfig,string][] = [['intervalMin','搜索间隔最小（分钟）'],['intervalMax','搜索间隔最大（分钟）'],['dailySearch','每日最多搜索'],['dailyComment','每日最多评论'],['dailyReply','每日最多回复']];
  function edit(topic?: Topic) { setDraft(topic ?? { ...blankTopic }); setKeywords(topic?.keywords.join('\n') ?? ''); }
  return <><div className="section-heading"><p>本地只按视频标题匹配关键词。发布时间和播放量不参与过滤。</p><button onClick={() => edit()}>+ 新建频道</button></div><div className="topic-grid">{state.topics.map(topic => <article key={topic.id}><div className="section-heading"><h2>{topic.name}</h2><span className="tag">{topic.enabled ? '已启用' : '已暂停'}</span></div><p>{topic.keywords.join(' / ')}</p><div className="mini-stats">今日新计划 {topic.todayDiscovered} · 互动尝试 {topic.todayInteractions}</div><p className="muted">最近运行：{topic.lastRun ? new Date(topic.lastRun).toLocaleString('zh-CN') : '尚未运行'}</p><div className="actions"><button onClick={() => edit(topic)}>编辑</button><button disabled={busy} onClick={() => { void mutate(`/topics/${topic.id}`,'PUT',{ ...topic, enabled: !topic.enabled }).catch(() => {}); }}>{topic.enabled ? '暂停频道' : '开启频道'}</button></div></article>)}</div>{draft && <section className="editor"><div className="section-heading"><h2>{draft.id ? '编辑频道' : '新建频道'}</h2><button onClick={() => setDraft(undefined)}>关闭</button></div><form onSubmit={event => { event.preventDefault(); void mutate(draft.id ? `/topics/${draft.id}` : '/topics',draft.id ? 'PUT' : 'POST',{ ...draft, keywords: keywords.split('\n').map(s => s.trim()).filter(Boolean) }).then(() => setDraft(undefined)).catch(() => {}); }}><label>名称<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><label>搜索关键词（每行一个）<textarea required value={keywords} onChange={e => setKeywords(e.target.value)} /></label><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用这个频道</label>
    <div className="form-grid">{numberFields.map(([key,label]) => <label key={key}>{label}<input type="number" min={key.startsWith('daily') ? 0 : 1} step="1" value={typeof draft[key] === 'number' ? draft[key] : ''} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} /></label>)}</div><p className="muted">自动分流固定为 70% 延后、20% 评论、10% 回复。新频道必须先停用保存，添加评论和回复模板后才能启用。搜索最多取第一页 50 条，不保证覆盖所有匹配视频。</p><div className="actions"><button className="primary" disabled={busy}>保存频道</button>{draft.id && <button type="button" className="danger" disabled={busy} onClick={() => { if (confirm('删除频道？历史视频去重记录将保留。')) void mutate(`/topics/${draft.id}`,'DELETE').then(() => setDraft(undefined)).catch(() => {}); }}>删除频道</button>}</div></form></section>}</>;
}
const planEventSchema = z.object({ id:z.number(),planId:z.number(),eventType:z.string(),at:z.number(),cycle:z.number(),fromState:z.string(),toState:z.string(),reason:z.string(),errorCode:z.string() });
const planDetailSchema = z.object({ plan:interactionPlanSchema,attempts:z.array(interactionAttemptSchema),events:z.array(planEventSchema) });
const planStates = { scheduled:'待执行',waiting_template:'等待模板',paused_channel:'频道已暂停',claimed:'发送中',succeeded:'已完成',uncertain:'结果不确定',manual_review:'人工核查',cancelled:'已取消' } as const;
function Plans({ state,mutate,busy }: { state:State;mutate:Mutate;busy:boolean }) {
  const [filter,setFilter]=useState('');const [offset,setOffset]=useState(0);const [rows,setRows]=useState<InteractionPlan[]>([]);const [total,setTotal]=useState(0);const [selected,setSelected]=useState<number>();const [detail,setDetail]=useState<z.infer<typeof planDetailSchema>>();const [commentDraft,setCommentDraft]=useState('');const [replyDraft,setReplyDraft]=useState('');const [error,setError]=useState('');const [reload,setReload]=useState(0);
  useEffect(()=>{let alive=true;const query=new URLSearchParams({limit:'50',offset:String(offset)});if(filter)query.set('state',filter);api(`/plans?${query}`).then(value=>{const page=z.object({items:z.array(interactionPlanSchema),total:z.number()}).parse(value);if(alive){setRows(page.items);setTotal(page.total);if(selected!==undefined&&!page.items.some(plan=>plan.id===selected))setSelected(undefined);}}).catch(e=>alive&&setError(e instanceof Error?e.message:'计划加载失败'));return()=>{alive=false;};},[filter,offset,reload]);
  useEffect(()=>{if(selected===undefined){setDetail(undefined);return;}let alive=true;api(`/plans/${selected}`).then(value=>{const parsed=planDetailSchema.parse(value);if(alive){setDetail(parsed);setCommentDraft(parsed.plan.commentTemplates.join('\n'));setReplyDraft(parsed.plan.replyTemplates.join('\n'));setError('');}}).catch(e=>alive&&setError(e instanceof Error?e.message:'计划详情加载失败'));return()=>{alive=false;};},[selected,reload]);
  const latest=detail?.attempts.at(-1);const canResolve=!!latest&&['uncertain','manual_review'].includes(latest.status)&&!latest.requestInFlight;
  async function saveTemplates(){if(!detail)return;await mutate(`/plans/${detail.plan.id}/templates`,'PUT',{version:detail.plan.version,commentTemplates:commentDraft.split('\n').map(x=>x.trim()).filter(Boolean),replyTemplates:replyDraft.split('\n').map(x=>x.trim()).filter(Boolean)});setReload(x=>x+1);}
  async function cancel(){if(!detail||!confirm('取消此计划？已发出的请求无法撤回；在途结果仍会继续核查。'))return;await mutate(`/plans/${detail.plan.id}/cancel`,'POST',{version:detail.plan.version,reason:'用户在计划页取消'});setReload(x=>x+1);}
  async function resolve(action:'succeeded'|'not_sent') {if(!latest||!detail)return;const promptText=action==='succeeded'?'请填写核查依据（例如 B 站页面中的评论链接）':'请填写你已核对未发送的依据';const evidence=prompt(promptText);if(!evidence?.trim())return;if(action==='not_sent'&&!confirm('只有在原桥接请求已结束且你已核对 B 站页面后，才能确认未发送并安排下一周期。继续？'))return;await mutate(`/attempts/${latest.id}/resolve`,'POST',{action,evidence:evidence.trim()});setReload(x=>x+1);}
  async function adoptLegacy(){if(!detail||!confirm('确认此旧排队计划原本尚未发送，并确认将由当前已绑定账号继续执行？历史成功记录仍保留“账号未知”。'))return;await mutate(`/plans/${detail.plan.id}/adopt-legacy`,'POST',{version:detail.plan.version});setReload(x=>x+1);}
  async function bindLegacy(){if(!confirm('请先确认数据库中的旧计划和成功记录属于当前登录账号。绑定后不能自动更换账号。'))return;await mutate('/account/bind-legacy','POST',{confirmLegacyOwnership:true});setReload(x=>x+1);}
  return <><div className="section-heading"><p>计划在入池时固定动作与模板快照；失败历史、重试周期和逾期额度都在这里查看。</p><select aria-label="计划状态筛选" value={filter} onChange={e=>{setFilter(e.target.value);setOffset(0);}}><option value="">全部状态</option>{Object.entries(planStates).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>{state.system.legacyOwnershipPending&&<div className="warning">旧数据库中有账号归属未知的历史计划。核对确认属于当前账号后，才能恢复旧排队任务。<button disabled={busy||!state.system.accountBinding?.verified} onClick={()=>void bindLegacy().catch(()=>{})}>确认旧数据账号归属</button></div>}{error&&<p className="error" role="alert">{error}</p>}<div className="plan-layout"><section><h2>计划列表 <small>{total} 条 · 每页 50 条</small></h2>{!rows.length?<p className="empty">没有符合筛选条件的计划。</p>:rows.map(plan=><button type="button" className={`list-row plan-row ${selected===plan.id?'selected':''}`} key={plan.id} onClick={()=>setSelected(plan.id)}><strong>{plan.video?JSON.parse(plan.video).title:plan.bvid}</strong><span>{plan.topicName} · {plan.keyword} · {planStates[plan.state]}</span><span>{plan.plannedAction==='comment'?'评论':'回复'} · 计划 {new Date(plan.dueAt).toLocaleDateString('zh-CN')}{plan.overflow?' · 容量溢出':''}{plan.failureCount?` · 已失败 ${plan.failureCount} 次`:''}</span></button>)}<div className="actions"><button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</button><button disabled={offset+50>=total} onClick={()=>setOffset(offset+50)}>下一页</button></div></section>{detail&&<section className="plan-detail"><div className="section-heading"><h2>{planStates[detail.plan.state]} <small>#{detail.plan.id}</small></h2><button onClick={()=>{setSelected(undefined);setDetail(undefined);}}>关闭</button></div><p><a target="_blank" rel="noreferrer" href={`https://www.bilibili.com/video/${encodeURIComponent(detail.plan.bvid)}`}>{detail.plan.video?JSON.parse(detail.plan.video).title:detail.plan.bvid}</a></p><p className="muted">UP {detail.plan.video?JSON.parse(detail.plan.video).author:''} · 频道 {detail.plan.topicName} · 命中“{detail.plan.keyword}”({detail.plan.matchedField})</p><p>原定动作：{detail.plan.plannedAction==='comment'?'评论':'回复'} · 创建 {new Date(detail.plan.firstEnqueuedAt).toLocaleString('zh-CN')} · 本周期 {new Date(detail.plan.cycleStartDay).toLocaleDateString('zh-CN')}–{new Date(detail.plan.cycleDeadlineDay).toLocaleDateString('zh-CN')} · 执行日 {new Date(detail.plan.dueAt).toLocaleDateString('zh-CN')}</p><p className="muted">周期 {detail.plan.cycleCount} · 连续失败 {detail.plan.failureCount} · 计划归属 UID {detail.plan.ownerUid}{detail.plan.snapshotSource==='legacy_snapshot'?' · 旧数据快照':''}{detail.plan.overflow?' · 容量溢出':''}</p>{detail.plan.failureCount>=3&&<p className="warning">此任务已连续失败至少 3 次，请检查历史；系统不会自动删除。</p>}
      {latest&&<section><h3>最近尝试 <small>#{latest.attemptNo}</small></h3><p>{latest.status} · 实际动作 {latest.effectiveAction==='comment'?'评论':'回复'} · 账号 {latest.senderUid} · 额度日 {new Date(latest.quotaDay).toLocaleDateString('zh-CN')} · {latest.dispatchClass}</p><p>{latest.content}{latest.target?` → @${latest.target}`:''}</p>{latest.fallbackReason&&<p className="muted">降级原因：{latest.fallbackReason}</p>}{latest.errorCode&&<p className="error">错误码：{latest.errorCode} · {latest.failureStage}</p>}{latest.requestInFlight&&<p className="warning">桥接仍报告原请求在途。暂不允许确认未发送，也不会执行其他写入。</p>}</section>}
      {detail.plan.snapshotSource==='legacy_snapshot'&&detail.plan.ownerUid==='unknown'&&detail.plan.state==='manual_review'&&state.system.accountBinding?.verified&&<button className="primary" disabled={busy||detail.attempts.length>0} onClick={()=>void adoptLegacy().catch(()=>{})}>确认并恢复此旧排队计划</button>}
      {canResolve&&<div className="actions"><button disabled={busy} onClick={()=>void resolve('succeeded').catch(()=>{})}>核实后标记已发送</button><button disabled={busy} onClick={()=>void resolve('not_sent').catch(()=>{})}>核实未发送并重排</button></div>}
      {!['succeeded','cancelled'].includes(detail.plan.state)&&<button className="danger" disabled={busy} onClick={()=>void cancel().catch(()=>{})}>取消未来执行</button>}
      <section><h3>模板快照 <small>只影响本计划后续执行</small></h3><label>评论模板候选<textarea value={commentDraft} onChange={e=>setCommentDraft(e.target.value)} /></label><label>回复模板候选<textarea value={replyDraft} onChange={e=>setReplyDraft(e.target.value)} /></label><button disabled={busy||['claimed','uncertain','succeeded','cancelled'].includes(detail.plan.state)} onClick={()=>void saveTemplates().catch(()=>{})}>保存计划模板快照</button></section>
      <section><h3>发送历史与事件</h3>{detail.events.slice().reverse().map(event=><p className="muted" key={event.id}>{new Date(event.at).toLocaleString('zh-CN')} · {event.eventType} · {event.reason} {event.errorCode&&`(${event.errorCode})`}</p>)}</section></section>}</div></>;
}
function Templates({ state,mutate,busy }: { state: State;mutate: Mutate;busy: boolean }) {
  const [draft,setDraft] = useState<Omit<Template,'id'> & { id?: number }>({ topicId: state.topics[0]?.id ?? 0, kind: 'comment', text: '', enabled: true });
  return <><p>模板直接绑定频道。评论与回复各自管理；相同文字可用于不同视频，已有计划使用入池时保存的快照。</p><section className="editor"><h2>{draft.id ? '编辑模板' : '添加模板'}</h2><form onSubmit={event => { event.preventDefault(); void mutate(draft.id ? `/templates/${draft.id}` : '/templates',draft.id ? 'PUT' : 'POST',draft).then(() => setDraft({ ...draft, id: undefined, text: '' })).catch(() => {}); }}><div className="form-grid"><label>所属频道<select required value={draft.topicId} onChange={e => setDraft({ ...draft, topicId: Number(e.target.value) })}><option value="0" disabled>请选择频道</option>{state.topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>类型<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value === 'reply' ? 'reply' : 'comment' })}><option value="comment">视频评论模板</option><option value="reply">普通评论回复模板</option></select></label></div><label>内容<textarea required maxLength={300} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用模板</label><button className="primary" disabled={busy || !state.topics.length}>保存模板</button></form></section><section>{state.templates.map(template => <div className="list-row template-row" key={template.id}><div><strong>{template.text}</strong><p className="muted">{state.topics.find(t => t.id === template.topicId)?.name} / {template.kind === 'comment' ? '视频评论' : '用户回复'} / {template.enabled ? '启用' : '禁用'}</p></div><div className="actions"><button onClick={() => setDraft(template)}>编辑</button><button disabled={busy} onClick={() => { void mutate(`/templates/${template.id}`,'PUT',{ ...template, enabled: !template.enabled }).catch(() => {}); }}>{template.enabled ? '禁用' : '启用'}</button><button className="danger" disabled={busy} onClick={() => { void mutate(`/templates/${template.id}`,'DELETE').catch(() => {}); }}>删除</button></div></div>)}</section></>;
}
function ActivityTable({ rows }: { rows: Activity[] }) {
  return !rows.length ? <p className="empty">暂无活动。默认不会自动巡逻。</p> : <div className="table-scroll"><table><thead><tr><th>时间 / 频道</th><th>关键词 / 视频 / UP 主</th><th>动作 / 内容 / 对象</th><th>结果</th></tr></thead><tbody>{rows.map((row,index) => <tr key={row.id ?? index}><td>{new Date(row.time).toLocaleString('zh-CN')}<small>{row.topic}</small></td><td>{row.bvid ? <a target="_blank" rel="noreferrer" href={`https://www.bilibili.com/video/${encodeURIComponent(row.bvid)}`}>{row.title || row.bvid}</a> : '—'}<small>{row.keyword} {row.author && `· UP ${row.author}`}</small></td><td><span className="tag">{labels[row.action] ?? row.action}</span><small>{row.content} {row.target && `→ @${row.target}`}</small></td><td>{row.result}<small className="error">{row.error}</small></td></tr>)}</tbody></table></div>;
}
function Activities() {
  const [filter,setFilter] = useState('all'); const [rows,setRows] = useState<Activity[]>([]); const [offset,setOffset] = useState(0); const [error,setError] = useState('');
  useEffect(() => { let alive = true; api(`/activity?action=${filter}&offset=${offset}`).then(data => { if (alive) setRows(z.array(activitySchema).parse(data)); }).catch(() => setError('活动记录加载失败')); return () => { alive = false; }; },[filter,offset]);
  return <><div className="section-heading"><p>搜索、发现、AI 判断、互动和错误的完整轨迹。</p><select aria-label="活动筛选" value={filter} onChange={e => { setFilter(e.target.value); setOffset(0); }}>{['all','judge','comment','reply','skip','error'].map(key => <option key={key} value={key}>{key === 'all' ? '全部' : labels[key]}</option>)}</select></div>{error && <p className="error">{error}</p>}<ActivityTable rows={rows} /><div className="actions"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset-100))}>较新记录</button><button disabled={rows.length < 100} onClick={() => setOffset(offset+100)}>较早记录</button></div></>;
}
function Settings({ state,mutate,refresh,busy }: { state: State; mutate: Mutate; refresh: () => Promise<void>; busy: boolean }) {
  const [limits,setLimits] = useState<Limits>(state.settings.limits); const [cookie,setCookie] = useState(''); const [refreshToken,setRefreshToken] = useState(''); const [qr,setQr] = useState(''); const [qrStatus,setQrStatus] = useState('');
  const [aiBaseUrl,setAiBaseUrl] = useState(state.settings.ai.baseUrl); const [aiModel,setAiModel] = useState(state.settings.ai.model);
  const [apiKey,setApiKey] = useState(''); const [clearApiKey,setClearApiKey] = useState(false);
  const [aiBusy,setAiBusy] = useState(false); const [aiNotice,setAiNotice] = useState('');
  const [aiSaving,setAiSaving] = useState(false);
  const aiDirty = aiBaseUrl !== state.settings.ai.baseUrl || aiModel !== state.settings.ai.model || !!apiKey || clearApiKey;
  async function aiAction(check: boolean) {
    setAiBusy(true); setAiSaving(!check); setAiNotice('');
    try {
      if (check) {
        const result = z.object({ message: z.string() }).parse(await api('/ai/check','POST'));
        setAiNotice(result.message);
      } else {
        await api('/ai/settings','PUT',{ baseUrl: aiBaseUrl, model: aiModel, ...(clearApiKey ? { apiKey: '' } : apiKey ? { apiKey } : {}) });
        const saved = aiSettingsSchema.parse({ baseUrl: aiBaseUrl, model: aiModel });
        setAiBaseUrl(saved.baseUrl); setAiModel(saved.model);
        setApiKey(''); setClearApiKey(false); await refresh(); setAiNotice('模型配置已保存');
      }
    } catch (error) { setAiNotice(error instanceof Error ? error.message : '模型请求失败'); }
    finally { setAiSaving(false); setAiBusy(false); }
  }
  const renewal = state.settings.account.renewal;
  const renewedAt = renewal?.at ? new Date(renewal.at).toLocaleString('zh-CN') : '';
  const renewalNote = !state.settings.account.loggedIn ? '' : !renewal ? '自动续期：等待下一次登录检查' : {
    current: `自动续期已开启 · ${renewedAt} 检查，暂不需要刷新`,
    renewed: `自动续期已开启 · ${renewedAt} 已自动续期`,
    failed: `自动续期失败（${renewedAt}）：当前登录仍可用，12 小时后重试；若持续失败请重新扫码登录`,
    unsupported: '未保存刷新令牌，无法自动续期：扫码登录会自动保存；Cookie 登录可填写 ac_time_value',
  }[renewal.status];
  const limitFields: [keyof Limits,string][] = [['dailySearch','每日最多搜索'],['dailyComment','每日最多评论'],['dailyReply','每日最多回复'],['dailyTotal','每日最多总互动'],['waitMin','两次互动最短间隔（分钟）'],['waitMax','最长随机等待（分钟）'],['failureLimit','连续失败暂停阈值']];
  async function qrStart() {
    try { const value = z.object({ qrcode_image: z.string(), message: z.string() }).parse(await api('/account/qr','POST')); setQr(value.qrcode_image); setQrStatus(value.message); }
    catch (error) { setQr(''); setQrStatus(`${error instanceof Error ? error.message : '二维码生成失败'}；可改用 Cookie 登录`); }
    await refresh();
  }
  // True once the scan reaches a final state; removing the QR then stops polling.
  async function qrCheck(): Promise<boolean> {
    try {
      const value = z.object({ status: z.string().optional(), message: z.string() }).parse(await api('/account/qr/check','POST'));
      setQrStatus(value.message);
      if (value.status === 'waiting_scan' || value.status === 'waiting_confirm') return false;
    } catch (error) { setQrStatus(`${error instanceof Error ? error.message : '扫码状态检查失败'}；请重新生成二维码或改用 Cookie 登录`); }
    setQr(''); await refresh(); return true;
  }
  useEffect(() => {
    if (!qr) return;
    // One request at a time while the QR is shown; Bilibili expires it after 180 seconds.
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => { timer = setTimeout(() => { void qrCheck().then(final => { if (!final && !stopped) poll(); }); },2000); };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  },[qr]);
  return <><section><h2>AI 模型 <small>全局一份 / OpenAI 兼容 Chat Completions</small></h2>
    <form onSubmit={event => { event.preventDefault(); void aiAction(false); }}>
      <div className="form-grid">
        <label>接口根地址<input type="url" autoComplete="off" maxLength={2048} disabled={aiSaving} value={aiBaseUrl} placeholder="https://api.deepseek.com 或 https://api.siliconflow.cn/v1" onChange={event => { setAiBaseUrl(event.target.value); setAiNotice(''); }} /></label>
        <label>模型名<input autoComplete="off" maxLength={200} disabled={aiSaving} value={aiModel} placeholder="由服务商提供的模型名，可自由填写" onChange={event => { setAiModel(event.target.value); setAiNotice(''); }} /></label>
        <label>API key（{state.settings.ai.apiKeyConfigured ? '已配置' : '未配置'}）<input type="password" autoComplete="new-password" maxLength={4096} disabled={aiSaving || clearApiKey} value={apiKey} placeholder="留空保留已保存的 key；填入新 key 可替换" onChange={event => { setApiKey(event.target.value); setAiNotice(''); }} /></label>
      </div>
      <label className="check"><input type="checkbox" disabled={aiSaving} checked={clearApiKey} onChange={event => { setClearApiKey(event.target.checked); setApiKey(''); setAiNotice(''); }} />清空已保存的 API key（保存后生效）</label>
      <p className="muted">地址和模型名可留空以清空。缺任一项时，AI 判断频道不能保存或启动；AI 关闭的频道不受影响。自动追加一次 /chat/completions，不强加 /v1；地址不允许账号密码、查询参数或片段。</p>
      <div className="actions"><button className="primary" disabled={busy || aiBusy}>保存模型配置</button><button type="button" disabled={busy || aiBusy || aiDirty} onClick={() => { void aiAction(true); }}>检查已保存配置的连接</button></div>
      <p className="muted">修改后请先保存再检查。检查只发送最短模型请求，结果仅显示在此处，不记录巡逻活动、不发送 B 站内容。key 仅存本机，不会从接口回显。</p>
      {aiNotice && <p role="status">{aiNotice}</p>}
    </form></section>
    <section><h2>账号 <small>单账号 / 本机私有存储</small></h2><div className="status-line"><span className={`dot ${state.settings.account.loggedIn ? 'running' : ''}`} /><strong>{state.settings.account.username || (state.settings.account.loggedIn ? '已登录' : '未登录')}</strong><span>{state.settings.account.message}</span></div>{renewalNote && <p className="muted">{renewalNote}</p>}<div className="actions"><button disabled={busy} onClick={() => { void mutate('/account/check','POST').catch(() => {}); }}>检查登录状态</button><button disabled={busy} onClick={() => { void mutate('/account','DELETE').then(() => { setCookie(''); setQr(''); }).catch(() => {}); }}>退出登录</button></div><form onSubmit={event => { event.preventDefault(); const value = cookie; const token = refreshToken; setCookie(''); setRefreshToken(''); void mutate('/account/cookie','POST',{ cookie: value, refreshToken: token }).catch(() => {}); }}><label>Cookie 登录<input type="password" autoComplete="off" value={cookie} onChange={e => setCookie(e.target.value)} placeholder="粘贴本账号的完整 Cookie，仅本机保存" required /></label><label>刷新令牌 ac_time_value（可选，用于自动续期）<input type="password" autoComplete="off" value={refreshToken} onChange={e => setRefreshToken(e.target.value)} placeholder="在该账号的 bilibili.com 页面控制台运行 localStorage.ac_time_value" /></label><p className="muted">需包含 SESSDATA、bili_jct、DedeUserID。不会显示或写入日志。重新登录会暂停巡逻。刷新令牌只填专用或无痕窗口里的登录；与日常浏览器共用时，任一方续期都会把另一方挤下线。</p><button disabled={busy} className="primary">保存并验证登录</button></form><div className="actions"><button disabled={busy || !!qr} onClick={() => { void qrStart(); }}>生成登录二维码</button></div>{qr && <img className="qr" src={qr} alt="Bilibili 登录二维码" />}<p className="muted" role="status">{qrStatus || '扫码后在手机上确认，状态会自动更新；不成功时可使用 Cookie 登录。'}</p></section><section><h2>全局限制 <small>与频道限制同时生效；失败尝试也计入额度</small></h2><form onSubmit={e => { e.preventDefault(); void mutate('/limits','PUT',limits).catch(() => {}); }}><div className="form-grid">{limitFields.map(([key,label]) => <label key={key}>{label}<input type="number" min={key.startsWith('daily') ? 0 : 1} value={limits[key]} onChange={e => setLimits({ ...limits, [key]: Number(e.target.value) })} required /></label>)}</div><button className="primary" disabled={busy}>保存全局限制</button></form></section><section><h2>调度器</h2><p>{state.settings.running ? 'Running / 巡逻中' : `Paused / ${state.settings.pauseReason}`}</p><p className="muted">默认暂停；未登录不发评论；验证码或风控立即停止。重启后需要手动启动。</p>{!state.system.writesEnabled && <div className="warning">真实写操作已禁用。如本人确认要进行真实互动，请停止服务，在启动环境中显式设置 BILIBILI_WRITES_ENABLED=true 后重新启动；程序不会自动加载 .env。开发和自动化测试期间保持关闭。</div>}</section><section><h2>系统</h2><dl><dt>版本</dt><dd>{state.system.version}</dd><dt>Node</dt><dd>{state.system.node}</dd><dt>已运行</dt><dd>{state.system.uptime} 秒</dd><dt>持久化</dt><dd>SQLite / 本机单进程</dd></dl></section></>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<App />);
