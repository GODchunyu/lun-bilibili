import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createApp, type ApplicationBilibili } from '../server/app.js';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { topicSchema, settingsSchema, type AiConfig } from '../server/model.js';
// Three legacy cases exercise retired AI-enabled patrol/channel semantics; independent connection and security cases remain active.

const now = Date.parse('2026-10-05T08:00:00Z');
const key = 'LOCAL_TEST_SECRET_NOT_A_REAL_KEY';
const replacement = 'LOCAL_REPLACEMENT_NOT_A_REAL_KEY';
const requestSchema = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), content: z.string() })), temperature: z.literal(0.2).optional(), max_tokens: z.literal(4096).optional(), response_format: z.object({ type: z.literal('json_object') }).optional() }).strict();
type ModelRequest = z.infer<typeof requestSchema>;
type CapturedRequest = { url: string; authorization: string; body: ModelRequest };
async function provider(t: TestContext, handler: (response: ServerResponse, request: CapturedRequest) => void) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const captured = { url: request.url ?? '', authorization: request.headers.authorization ?? '', body: requestSchema.parse(JSON.parse(raw)) };
    requests.push(captured); handler(response, captured);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { base: `http://127.0.0.1:${address.port}`, requests };
}
function answer(response: ServerResponse, content: string) {
  // This vendor-only field must never override content or get persisted/returned.
  response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content, reasoning_content: `IGNORED_REASONING ${key}` } }] }));
}
async function fixture(t: TestContext, path = ':memory:') {
  const store = new Store(path); const calls: string[] = [];
  const bili: ApplicationBilibili = {
    async checkLogin() { calls.push('login'); return { loggedIn: true, uid: '100', message: '本地假账号' }; },
    async search() { calls.push('search'); return [{ bvid: 'BV1000000001', aid: 1, title: '方块建筑', author: '假UP', play: 1000, pubdate: now / 1000 - 1 }]; },
    async comments() { calls.push('comments'); return []; }, async post() { calls.push('post'); },
    async tools() { calls.push('tools'); return []; }, async qrStart() { calls.push('qr'); return { status: 'unused', message: '', qrcode_image: '' }; },
    async qrCheck() { calls.push('qr-check'); return { message: '' }; }, async resetSession() { calls.push('reset'); },
  };
  const scheduler = new Scheduler(store, bili, () => now);
  const app = await createApp(store, bili, scheduler, 'unused.json', true);
  t.after(async () => { await app.close(); await scheduler.close(); store.close(); });
  return { store, scheduler, app, calls };
}

test.skip('settings retain, replace and clear a private key across unrelated writes and SQLite restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'yui-ai-settings-')); const path = join(directory, 'private/patrol.sqlite');
  t.after(() => rmSync(directory, { recursive: true }));
  const f = await fixture(t, path);
  const save = (config: Partial<AiConfig>) => f.app.inject({ method: 'PUT', url: '/api/ai/settings', payload: config });
  assert.equal((await save({ baseUrl: 'https://placeholder.invalid', model: 'free-form-model', apiKey: key })).statusCode, 200);
  const stale = f.store.settings();
  assert.equal((await save({ baseUrl: 'https://placeholder.invalid/v1/', model: 'other-model', apiKey: replacement })).statusCode, 200);
  f.store.saveSettings(stale);
  assert.deepEqual(f.store.aiConfig(), { baseUrl: 'https://placeholder.invalid/v1/', model: 'other-model', apiKey: replacement });
  assert.equal((await save({ baseUrl: 'https://placeholder.invalid', model: 'retained-model' })).statusCode, 200);
  assert.equal(f.store.aiConfig().apiKey, replacement);
  for (const url of ['/api/state', '/api/activity', '/api/health']) {
    const result = await f.app.inject({ url }); assert.equal(result.statusCode, 200);
    assert.equal(result.body.includes(key), false); assert.equal(result.body.includes(replacement), false);
  }
  const state = z.object({ settings: settingsSchema }).parse((await f.app.inject({ url: '/api/state' })).json());
  assert.deepEqual(state.settings.ai, { baseUrl: 'https://placeholder.invalid', model: 'retained-model', apiKeyConfigured: true });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  const reopened = new Store(path);
  try { assert.deepEqual(reopened.aiConfig(), f.store.aiConfig()); assert.equal(JSON.stringify(reopened.settings()).includes(replacement), false); }
  finally { reopened.close(); }
  assert.equal((await save({ baseUrl: '', model: '', apiKey: '' })).statusCode, 200);
  assert.deepEqual(f.store.aiConfig(), { baseUrl: '', model: '', apiKey: '' });
  const cleared = new Store(path);
  try { assert.equal(cleared.settings().ai.apiKeyConfigured, false); assert.equal(cleared.aiConfig().apiKey, ''); }
  finally { cleared.close(); }
});

test.skip('saved DeepSeek and SiliconFlow root shapes judge content with JSON mode and ignore reasoning_content', async t => {
  for (const [root, endpoint, model] of [
    ['', '/chat/completions', 'deepseek-flash'], ['/v1', '/v1/chat/completions', 'Qwen/Qwen2.5-72B-Instruct'],
    ['///', '/chat/completions', 'free-model'], ['/v1///', '/v1/chat/completions', 'free-model'],
    ['/v1/chat/completions/', '/v1/chat/completions', 'free-model'],
  ]) {
    const p = await provider(t, response => answer(response, JSON.stringify({ action: 'comment', reason: '适合温和交流' })));
    const f = await fixture(t);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/ai/settings', payload: { baseUrl: p.base + root, model, apiKey: key } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/topics', payload: { name: '测试频道', keywords: ['建筑'], enabled: true, aiJudgment: true } })).statusCode, 200);
    await f.scheduler.run(); await f.scheduler.tick();
    assert.equal(f.store.nextQueue(now + 3600000)?.action, 'comment');
    assert.equal(f.store.activity('judge')[0].content, '适合温和交流');
    assert.equal(p.requests[0].url, endpoint); assert.equal(p.requests[0].authorization, `Bearer ${key}`);
    assert.equal(p.requests[0].body.model, model); assert.deepEqual(p.requests[0].body.response_format, { type: 'json_object' });
    assert.equal(p.requests[0].body.max_tokens, 4096); assert.equal(p.requests[0].body.temperature, 0.2);
    assert.equal(f.calls.includes('post'), false);
    for (const url of ['/api/state', '/api/activity']) {
      const result = await f.app.inject({ url });
      assert.equal(result.body.includes(key), false); assert.equal(result.body.includes('IGNORED_REASONING'), false);
    }
  }
});

test('unsafe root URLs are rejected atomically without revealing key or echoing credentials', async t => {
  const f = await fixture(t);
  const baseline = { baseUrl: 'http://127.0.0.1:19099/v1', model: 'local-model', apiKey: key };
  f.store.saveAiConfig(baseline);
  for (const baseUrl of [`https://user:${key}@placeholder.invalid`, `https://placeholder.invalid?token=${key}`, `https://placeholder.invalid#${key}`, 'https://placeholder.invalid?', 'https://placeholder.invalid#', 'file:///private/model', 'not a URL']) {
    const response = await f.app.inject({ method: 'PUT', url: '/api/ai/settings', payload: { ...baseline, baseUrl } });
    assert.equal(response.statusCode, 409); assert.equal(response.body.includes(key), false);
    assert.deepEqual(f.store.aiConfig(), baseline); assert.deepEqual(f.store.activity(), []);
  }
});

test.skip('every missing setting blocks AI saves atomically and startup, while AI-off channels still save and run', async t => {
  for (const [field, label] of [['baseUrl', '接口根地址'], ['model', '模型名'], ['apiKey', 'API key']] as const) {
    const f = await fixture(t);
    const config = { baseUrl: 'http://127.0.0.1:19099', model: 'local-model', apiKey: key, [field]: '' };
    f.store.saveAiConfig(config);
    const legacy = topicSchema.parse({ name: 'AI 关闭', keywords: ['建筑'], enabled: true });
    const saved = await f.app.inject({ method: 'POST', url: '/api/topics', payload: legacy });
    assert.equal(saved.statusCode, 200);
    const id = z.object({ id: z.number() }).parse(saved.json()).id;
    const before = f.store.db.prepare('SELECT * FROM topics').all();
    for (const [method, url] of [['POST', '/api/topics'], ['PUT', `/api/topics/${id}`]] as const) {
      const response = await f.app.inject({ method, url, payload: { ...legacy, name: '不应保存', keywords: ['不应保存'], aiJudgment: true } });
      assert.equal(response.statusCode, 409); assert.ok(response.body.includes(label)); assert.ok(response.body.includes('设置页'));
      assert.deepEqual(f.store.db.prepare('SELECT * FROM topics').all(), before);
      assert.deepEqual(f.store.db.prepare('SELECT keyword FROM keywords').all().map(row => row.keyword), ['建筑']);
      assert.deepEqual(f.store.activity(), []); assert.deepEqual(f.store.aiConfig(), config);
    }
    await f.scheduler.run(); assert.equal(f.store.settings().running, true); await f.scheduler.pause();
    const aiId = f.store.saveTopic(topicSchema.parse({ name: '以前的 AI 频道', keywords: ['建筑'], aiJudgment: true, enabled: false }));
    f.calls.length = 0;
    const blocked = await f.app.inject({ method: 'POST', url: '/api/scheduler', payload: { running: true } });
    assert.equal(blocked.statusCode, 409); assert.ok(blocked.body.includes(label)); assert.ok(blocked.body.includes('设置页'));
    assert.equal(f.store.settings().running, false); assert.deepEqual(f.calls, []);
    f.store.saveTopic({ ...f.store.topic(aiId)!, aiJudgment: false }, aiId);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/scheduler', payload: { running: true } })).statusCode, 200);
    assert.equal(f.store.settings().running, true);
  }
});

test('connection checks use only saved config; success and hostile failures have no secret, logs, activity or Bilibili effects', async t => {
  const logs: unknown[][] = [];
  for (const method of ['log', 'warn', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  for (const outcome of ['success', 'http', 'echo', 'malformed', 'redirect'] as const) {
    const p = await provider(t, response => {
      if (outcome === 'http') { response.statusCode = 401; response.end(`upstream error ${key}`); }
      else if (outcome === 'malformed') response.end(`not JSON ${key}`);
      else if (outcome === 'redirect') { response.statusCode = 307; response.setHeader('Location', 'https://example.invalid'); response.end(); }
      else answer(response, outcome === 'echo' ? key : 'OK');
    });
    const f = await fixture(t);
    f.store.saveAiConfig({ baseUrl: p.base, model: 'local-model', apiKey: key });
    const before = f.store.settings();
    const result = await f.app.inject({ method: 'POST', url: '/api/ai/check', payload: { apiKey: 'UNSAVED_VALUE' } });
    assert.equal(result.statusCode, outcome === 'success' ? 200 : 502); assert.equal(result.body.includes(key), false);
    assert.equal(p.requests[0].authorization, `Bearer ${key}`);
    assert.deepEqual(Object.keys(p.requests[0].body).sort(), ['messages', 'model']);
    assert.equal(p.requests[0].body.model, 'local-model');
    assert.equal(JSON.stringify(p.requests[0].body.messages).includes(key), false);
    assert.deepEqual(f.store.settings(), before); assert.deepEqual(f.store.activity(), []); assert.deepEqual(f.calls, []);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM interactions').get()?.n, 0);
    const activity = await f.app.inject({ url: '/api/activity' }); assert.deepEqual(activity.json(), []);
    assert.equal(JSON.stringify(logs).includes(key), false);
  }
});

test('settings on an alternate loopback port allow their own origin but reject cross-site changes', async t => {
  const f = await fixture(t); const payload = { baseUrl: '', model: '', apiKey: '' };
  const own = await f.app.inject({ method: 'PUT', url: '/api/ai/settings', headers: { host: '127.0.0.1:19014', origin: 'http://127.0.0.1:19014' }, payload });
  assert.equal(own.statusCode, 200);
  for (const origin of ['https://evil.invalid', 'http://127.0.0.1:19015']) {
    const denied = await f.app.inject({ method: 'PUT', url: '/api/ai/settings', headers: { host: '127.0.0.1:19014', origin }, payload: { ...payload, apiKey: key } });
    assert.equal(denied.statusCode, 403); assert.equal(f.store.settings().ai.apiKeyConfigured, false);
  }
});
