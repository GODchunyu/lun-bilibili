import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { AiConfigError, AiFailure, OpenAiPatrol, chatCompletionsUrl } from './ai.js';
import { BiliError, dayStart, aiConfigSchema, limitsSchema, topicSchema, templateSchema, type Bilibili } from './model.js';
import { saveCookie, clearCookie, parseCookie } from './auth.js';
export interface ApplicationBilibili extends Bilibili {
  tools(): Promise<Tool[]>;
  qrStart(): Promise<{ status: string; message: string; qrcode_image: string }>;
  qrCheck(): Promise<{ status?: string; message: string }>;
  resetSession(): Promise<void>;
}
function localHosts(): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1']);
  for (const raw of [process.env.HOST, process.env.YUI_ALLOWED_HOSTS]) {
    for (const part of (raw ?? '').split(',')) {
      const host = part.trim();
      if (!host || host === '0.0.0.0' || host === '::' || host === '*') continue;
      hosts.add(host);
    }
  }
  return hosts;
}
export async function createApp(store: Store, bili: ApplicationBilibili, scheduler: Scheduler, credentialFile: string, writesEnabled: boolean) {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  app.addHook('onRequest', async (request,reply) => {
    const hostname = (request.headers.host ?? '').split(':')[0];
    if (!localHosts().has(hostname)) return reply.code(403).send({ error: '仅允许本机访问' });
    // Allow this loopback origin (including PORT overrides) and the existing local Vite origins only.
    if (!['GET','HEAD'].includes(request.method) && request.headers.origin) {
      const allowed = [`http://${request.headers.host}`,'http://localhost:3217','http://127.0.0.1:3217','http://localhost:3218','http://127.0.0.1:3218'];
      if (!allowed.includes(request.headers.origin)) return reply.code(403).send({ error: '禁止跨站请求' });
    }
    reply.header('Cache-Control','no-store');
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Referrer-Policy','no-referrer');
  });
  app.setErrorHandler((error,_request,reply) => {
    if (error instanceof AiConfigError) return reply.code(409).send({ error: error.message });
    if (error instanceof AiFailure) return reply.code(502).send({ error: error.message });
    if (error instanceof BiliError) {
      store.log({ time: Date.now(), topicId: null, topic: '系统', keyword: '', bvid: '', title: '', author: '', action: 'error', content: '', target: '', result: '请求失败', error: error.message });
      return reply.code(409).send({ error: error.message });
    }
    if (error instanceof ZodError) return reply.code(400).send({ error: '输入配置无效，请检查范围、必填项和概率之和' });
    return reply.code(400).send({ error: '请求失败，请检查配置或登录状态' });
  });
  app.get('/api/health', () => ({ status: 'ok', version: '1.0.0' }));
  app.get('/api/state', () => {
    const now = Date.now();
    const queue = store.queueSummary(now);
    const plans = store.interactionPlans({ limit: 200 });
    const today=dayStart(now);
    const metrics=store.db.prepare(`SELECT
      (SELECT count(*) FROM interaction_plans WHERE first_enqueued_at>=?) AS created_today,
      (SELECT count(*) FROM interaction_plans WHERE first_enqueued_at>=? AND deferred=1) AS deferred_today,
      (SELECT count(*) FROM interaction_attempts WHERE started_at>=? AND status='succeeded') AS succeeded_today,
      (SELECT count(*) FROM interaction_plans WHERE state='scheduled' AND (cycle_deadline_day<? OR (overflow=1 AND cycle_deadline_day<=?))) AS overdue,
      (SELECT count(*) FROM interaction_plans WHERE state IN ('scheduled','waiting_template','paused_channel') AND overflow=1) AS overflow,
      (SELECT min(cycle_deadline_day) FROM interaction_plans WHERE state='scheduled' AND (cycle_deadline_day<? OR (overflow=1 AND cycle_deadline_day<=?))) AS earliest_overdue`).get(today,today,today,today,today,today,today) as { created_today:number;deferred_today:number;succeeded_today:number;overdue:number;overflow:number;earliest_overdue:number|null };
    const binding=store.accountBinding();
    return { serverNow: now, runtime: scheduler.status(), settings: store.settings(), topics: store.topics(now), templates: store.templates(), plans, queue, recentComments: store.recentComments(10), today: { discover: metrics.created_today, deferred:metrics.deferred_today, comment: store.attemptCount(now,undefined,'comment'), reply: store.attemptCount(now,undefined,'reply'), skip: store.count('skip',now), error: store.count('error',now) }, system: { version: '1.0.0', node: process.version, uptime: Math.floor(process.uptime()), writesEnabled, queued: queue.pending, attempts: store.attemptCount(now), overdue: metrics.overdue, overflow:metrics.overflow, createdToday:metrics.created_today, succeededToday:metrics.succeeded_today, earliestOverdue:metrics.earliest_overdue, accountBinding:binding??null, legacyOwnershipPending:store.legacyOwnershipPending() } };
  });
  app.get('/api/plans', request => {
    const query=z.object({ state: z.enum(['scheduled','waiting_template','paused_channel','claimed','succeeded','uncertain','manual_review','cancelled']).optional(), limit:z.coerce.number().int().min(1).max(500).default(100), offset:z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return { items:store.interactionPlans(query),total:store.interactionPlanCount(query.state) };
  });
  app.get('/api/plans/:id', request => {
    const id=z.object({id:z.coerce.number().int().positive()}).parse(request.params).id; const plan=store.interactionPlan(id); if(!plan) return {error:'计划不存在'};
    return {plan,attempts:store.interactionAttempts(id),events:store.interactionEvents(id)};
  });
  app.post('/api/plans/:id/cancel', request => { const id=z.coerce.number().int().positive().parse((request.params as {id:string}).id); const body=z.object({version:z.number().int().nonnegative(),reason:z.string().trim().max(300).default('用户取消')}).parse(request.body); if(!store.cancelInteractionPlan(id,body.version,Date.now(),body.reason)) throw new Error('计划已变化或不可取消'); return {ok:true}; });
  app.post('/api/attempts/:id/resolve', request => { const id=z.coerce.number().int().positive().parse((request.params as {id:string}).id); const body=z.object({action:z.enum(['succeeded','not_sent']),evidence:z.string().trim().min(1).max(500)}).parse(request.body); return store.resolveUncertainAttempt(id,body.action,Date.now(),body.evidence); });
  app.put('/api/plans/:id/templates', request => { const id=z.coerce.number().int().positive().parse((request.params as {id:string}).id); const body=z.object({version:z.number().int().nonnegative(),commentTemplates:z.array(z.string()),replyTemplates:z.array(z.string())}).parse(request.body); return store.updatePlanTemplates(id,body.version,body.commentTemplates,body.replyTemplates); });
  app.post('/api/account/bind-legacy', async (request,reply) => {
    z.object({confirmLegacyOwnership:z.literal(true)}).parse(request.body);
    const account=await bili.checkLogin();
    if(!account.loggedIn||!account.uid)return reply.code(409).send({error:'当前账号未通过登录验证，不能绑定旧数据库'});
    const result=store.bindAccount(account.uid,true,true);
    if(!result.ok)return reply.code(409).send({error:result.reason});
    const settings=store.settings();settings.account=account;store.saveSettings(settings);
    return {ok:true,binding:result.binding};
  });
  app.post('/api/plans/:id/adopt-legacy', async (request,reply) => {
    const id=z.coerce.number().int().positive().parse((request.params as {id:string}).id);
    const body=z.object({version:z.number().int().nonnegative()}).parse(request.body);
    const account=await bili.checkLogin();const binding=store.accountBinding();
    if(!account.loggedIn||!account.uid||!binding?.verified||binding.uid!==account.uid)return reply.code(409).send({error:'当前登录账号与本机数据库绑定不一致'});
    const settings=store.settings();settings.account=account;store.saveSettings(settings);
    try{return store.adoptLegacyPlan(id,body.version,account.uid);}
    catch(error){return reply.code(409).send({error:error instanceof Error?error.message:'旧计划不能恢复'});}
  });
  app.post('/api/topics', request => ({ id: scheduler.saveTopic(topicSchema.parse(request.body)) }));
  app.put('/api/topics/:id', request => {
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
    return { id: scheduler.saveTopic(topicSchema.parse(request.body),id) };
  });
  app.delete('/api/topics/:id', request => {
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
    store.deleteTopic(id); return { ok: true };
  });
  app.post('/api/templates', request => ({ id: store.saveTemplate(templateSchema.parse(request.body)) }));
  app.put('/api/templates/:id', request => {
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
    return { id: store.saveTemplate(templateSchema.parse(request.body),id) };
  });
  app.delete('/api/templates/:id', request => {
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
    store.db.prepare('DELETE FROM templates WHERE id=?').run(id); return { ok: true };
  });
  app.get('/api/activity', request => {
    const filter = z.object({ action: z.enum(['all','judge','comment','reply','skip','error']).default('all'), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return store.activity(filter.action,100,filter.offset);
  });
  app.put('/api/limits', request => { const s = store.settings(); const previous=s.limits; s.limits = limitsSchema.parse(request.body); store.saveSettings(s); if(previous.dailyTotal!==s.limits.dailyTotal||previous.dailyComment!==s.limits.dailyComment||previous.dailyReply!==s.limits.dailyReply)store.rebalanceCapacity(); return { ok: true }; });
  app.put('/api/ai/settings', request => {
    // Omitted key keeps the saved secret; an explicit empty string clears it.
    const update = aiConfigSchema.extend({ apiKey: aiConfigSchema.shape.apiKey.optional() }).strict().parse(request.body);
    const config = { ...update, apiKey: update.apiKey ?? store.aiConfig().apiKey };
    if (config.baseUrl) chatCompletionsUrl(config.baseUrl);
    if (config.apiKey && (config.baseUrl.includes(config.apiKey) || config.model.includes(config.apiKey))) throw new AiConfigError('API key 只能填写在设置页的密码框中');
    store.saveAiConfig(config);
    return { ok: true };
  });
  app.post('/api/ai/check', async () => {
    await new OpenAiPatrol(() => store.aiConfig()).checkConnection();
    return { ok: true, message: '连接成功，模型已返回有效响应' };
  });
  app.post('/api/scheduler', async request => {
    const { running } = z.object({ running: z.boolean() }).parse(request.body);
    if (running) { if (!writesEnabled) throw new BiliError('disabled'); await scheduler.run(); }
    else await scheduler.pause();
    return { ok: true };
  });
  app.get('/api/tools', () => bili.tools());
  app.post('/api/account/check', async () => {
    try {
      const account = await bili.checkLogin();
      const s = store.settings(); s.account = account; store.saveSettings(s);
      if (!account.loggedIn) await scheduler.pause('登录失效，请重新登录');
      return account;
    } catch (error) { await scheduler.pause('登录检查失败，请查看活动'); throw error; }
  });
  app.post('/api/account/cookie', async request => {
    const { cookie,refreshToken } = z.object({ cookie: z.string().min(1).max(8192), refreshToken: z.string().max(256).default('') }).parse(request.body);
    // Validate before pausing or resetting so a malformed token never disturbs the current login.
    parseCookie(cookie,refreshToken);
    await scheduler.pause('账号配置已变更，请检查后启动');
    await bili.resetSession();
    const checking = store.settings(); checking.account = { loggedIn: false, message: '账号已变更，等待登录验证' }; store.saveSettings(checking);
    await saveCookie(credentialFile,cookie,refreshToken);
    const account = await bili.checkLogin();
    const s = store.settings(); s.account = account; store.saveSettings(s);
    return account;
  });
  app.delete('/api/account', async () => {
    await scheduler.pause('已退出登录');
    await bili.resetSession();
    await clearCookie(credentialFile);
    const s = store.settings(); s.account = { loggedIn: false, message: '已退出登录' }; store.saveSettings(s);
    return { ok: true };
  });
  app.post('/api/account/qr', async () => { await scheduler.pause('正在扫码登录'); return bili.qrStart(); });
  app.post('/api/account/qr/check', async () => {
    const result = await bili.qrCheck();
    if (result.status === 'done') {
      // The credential file was just replaced; never keep showing the previous account state.
      const s = store.settings();
      try { s.account = await bili.checkLogin(); }
      catch (error) { s.account = { loggedIn: false, message: '扫码完成但登录验证失败，请重试或改用 Cookie 登录' }; store.saveSettings(s); throw error; }
      store.saveSettings(s);
    }
    return result;
  });
  if (existsSync(resolve('dist/index.html'))) {
    await app.register(fastifyStatic,{ root: resolve('dist'), index: ['index.html'] });
    app.setNotFoundHandler((request,reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
  }
  return app;
}
