import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { BiliError, dayStart, safeComment, topicSchema, limitsSchema, activitySchema, recentCommentSchema, type Bilibili, type Video, type OrdinaryComment, type PostReceipt } from '../server/model.js';
// These pre-plan-ledger queue tests describe the retired interactions table and old heat filters.
// New scheduler coverage lives in patrol.test.ts and store-plans.test.ts.
const initialTime = Date.parse('2026-10-04T08:00:00Z');
class FakeBilibili implements Bilibili {
  loggedIn = true;
  videos: Video[] = [];
  replies: OrdinaryComment[] = [];
  writes: { bvid: string; text: string; rpid: number }[] = [];
  searchError?: BiliError;
  postError?: Error;
  receipt?: PostReceipt;
  searches = 0;
  beforeCheck?: () => void;
  async checkLogin() { this.beforeCheck?.(); return { loggedIn: this.loggedIn, uid: '100', username: '本地假账号', message: this.loggedIn ? '已登录' : '未登录' }; }
  async search() { this.searches++; if (this.searchError) throw this.searchError; return this.videos; }
  async comments() { return this.replies; }
  async post(bvid: string, text: string, rpid = 0) { this.writes.push({ bvid,text,rpid }); if (this.postError) throw this.postError; return this.receipt; }
  async tools(): Promise<never> { throw new Error('Not used'); }
  async qrStart(): Promise<never> { throw new Error('Not used'); }
  async qrCheck(): Promise<never> { throw new Error('Not used'); }
  async resetSession(): Promise<never> { throw new Error('Not used'); }
}
function fixture(action: 'comment'|'reply'|'skip' = 'comment', path = ':memory:') {
  let now = initialTime;
  const store = new Store(path); const bili = new FakeBilibili();
  const settings = store.settings(); settings.limits = limitsSchema.parse({ waitMin: 1,waitMax: 1 }); store.saveSettings(settings);
  const id = store.saveTopic(topicSchema.parse({ name: '任意兴趣',enabled: true,keywords: ['关键词一','关键词二'],minPlay: 0,intervalMin: 1,intervalMax: 1,skipProbability: action === 'skip' ? 100 : 0,commentProbability: action === 'comment' ? 100 : 0,replyProbability: action === 'reply' ? 100 : 0 }));
  store.saveTemplate({ topicId: id,kind: action === 'reply' ? 'reply' : 'comment',text: '好耶',enabled: true });
  store.saveTemplate({ topicId: id,kind: action === 'reply' ? 'reply' : 'comment',text: '路过',enabled: true });
  const scheduler = new Scheduler(store,bili,() => now,() => 0);
  bili.videos = [{ bvid: 'BV1000000001',aid: 1,title: '测试视频',author: '测试UP',play: 100,pubdate: (now-1000)/1000 }];
  return { store,bili,scheduler,id,advance: (ms: number) => { now += ms; },time: () => now };
}
test.skip('Paused and expired login block discovery and queued writes', async () => {
  const f = fixture(); await f.scheduler.tick(); assert.equal(f.bili.searches,0);
  await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); f.bili.loggedIn = false;
  await f.scheduler.tick(); assert.equal(f.bili.writes.length,0); assert.equal(f.store.settings().running,false); assert.equal(f.store.account().loggedIn,false);
  assert.match(f.store.activity('error')[0].error,/登录失效/); f.store.close();
});
test.skip('discovery queues instead of immediate writing; persistent deduplication covers other Topics and restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(),'yui-dedup-')); const path = join(directory,'patrol.sqlite');
  const f = fixture('comment',path);
  await f.scheduler.run(); await f.scheduler.tick(); assert.equal(f.store.count('discover',f.time()),1); assert.equal(f.bili.writes.length,0);
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.store.activity('comment')[0].result,'成功'); assert.equal(f.store.attemptCount(f.time()),1);
  await f.scheduler.close(); f.store.close();
  const restarted = new Store(path); assert.equal(restarted.settings().running,false); assert.equal(restarted.topics()[0].keywords.length,2);
  const second = restarted.saveTopic(topicSchema.parse({ name:'第二频道',keywords:['别的词'],enabled:true,skipProbability:0,commentProbability:100,replyProbability:0 }));
  assert.equal(restarted.discover(f.bili.videos[0],second,'别的词',f.time()),false);
  assert.equal(restarted.db.prepare('SELECT state FROM interactions').get()?.state,'succeeded'); restarted.close(); rmSync(directory,{recursive:true});
});
test.skip('global quota, Topic quota, and spacing jointly prevent excess writes', async () => {
  const f = fixture(); const settings = f.store.settings(); settings.limits.dailyComment = 1; settings.limits.dailyTotal = 1; f.store.saveSettings(settings);
  f.bili.videos.push({ ...f.bili.videos[0],bvid:'BV1000000002',aid:2 }); await f.scheduler.run(); await f.scheduler.tick();
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.store.attemptCount(f.time()),1);
  f.advance(1); await f.scheduler.tick(); assert.equal(f.store.attemptCount(f.time()),1);
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.store.attemptCount(f.time()),1); assert.equal(f.bili.writes.length,1);
  assert.equal(f.store.nextQueue(f.time()),undefined); f.store.close();
  const topicLimited = fixture(); const topic = topicLimited.store.topic(topicLimited.id); assert.ok(topic);
  topic.dailyComment = 0; topicLimited.store.saveTopic(topic,topic.id); await topicLimited.scheduler.run(); await topicLimited.scheduler.tick(); topicLimited.advance(60000); await topicLimited.scheduler.tick();
  assert.equal(topicLimited.store.attemptCount(topicLimited.time()),0); topicLimited.store.close();
});
test.skip('unknown, sensitive and pinned replies are rejected, ordinary harmless reply is selected', async () => {
  const f = fixture('reply');
  f.bili.replies = [{ rpid:1,user:'置顶',content:'好耶',pinned:true,ordinary:true },{ rpid:2,user:'未知',content:'好耶',pinned:false,ordinary:false },{ rpid:3,user:'广告',content:'加微信 12345',pinned:false,ordinary:true },{ rpid:4,user:'普通用户',content:'好耶！',pinned:false,ordinary:true,uid:'200' }];
  await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
  assert.equal(f.store.activity('reply')[0].target,'普通用户'); assert.equal(f.bili.writes[0].rpid,4);
  assert.equal(safeComment({ rpid:5,user:'用户',content:'政治争论',pinned:false,ordinary:true }),false); f.store.close();
});
test.skip('risk immediately pauses all Topics and an ambiguous failed write is never retried', async () => {
  const f = fixture(); f.bili.postError = new BiliError('risk');
  f.bili.videos.push({ ...f.bili.videos[0],bvid:'BV1000000002',aid:2 }); await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
  assert.equal(f.store.settings().running,false); assert.match(f.store.settings().pauseReason,/风控/);
  f.advance(7200000); await f.scheduler.tick(); assert.equal(f.bili.writes.length,1);
  assert.equal(f.store.activity('error')[0].content,f.bili.writes[0].text);
  assert.equal(f.store.db.prepare('SELECT state FROM interactions ORDER BY id LIMIT 1').get()?.state,'failed'); f.store.close();
});
test.skip('failed reply Activity and API retain attempted content and target without raw timeout details', async () => {
  const directory = mkdtempSync(join(tmpdir(),'yui-activity-')); const f = fixture('reply');
  let app: FastifyInstance | undefined;
  try {
    f.bili.replies = [{ rpid:4,user:'普通用户',content:'好耶！',pinned:false,ordinary:true,uid:'200' }];
    const rawDetail = 'LOCAL_UNSAFE_TIMEOUT_DETAIL'; f.bili.postError = new Error(rawDetail);
    await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
    assert.equal(f.bili.writes[0].rpid,4);
    assert.equal(f.store.db.prepare('SELECT state FROM interactions').get()?.state,'failed');
    const failed = f.store.activity('error')[0];
    assert.equal(failed.content,f.bili.writes[0].text); assert.equal(failed.target,'普通用户');
    assert.equal(failed.error,new BiliError('api').message);
    assert.equal(JSON.stringify(f.store.activity()).includes(rawDetail),false);
    app = await createApp(f.store,f.bili,f.scheduler,join(directory,'credential.json'),false);
    const response = await app.inject({ method:'GET',url:'/api/activity?action=error' });
    assert.equal(response.statusCode,200);
    const visible = z.array(activitySchema).parse(response.json())[0];
    assert.equal(visible.content,f.bili.writes[0].text); assert.equal(visible.target,'普通用户');
    assert.equal(visible.error,new BiliError('api').message); assert.equal(response.body.includes(rawDetail),false);
  } finally { await app?.close(); await f.scheduler.close(); f.store.close(); rmSync(directory,{ recursive:true }); }
});
test.skip('recent comments list only confirmed sends, keep the send receipt and fall back for older rows', async () => {
  const directory = mkdtempSync(join(tmpdir(),'yui-recent-')); const f = fixture();
  let app: FastifyInstance | undefined;
  try {
    f.bili.receipt = { rpid: 290501715345,cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',stats: { view: 12345,like: 6,reply: 7,favorite: 8 } };
    f.bili.videos = [{ ...f.bili.videos[0],title: '沙盒&amp;生存 &#39;第一期&#39;' },{ ...f.bili.videos[0],bvid: 'BV1000000002',aid: 2 },{ ...f.bili.videos[0],bvid: 'BV1000000003',aid: 3 }];
    await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
    f.bili.postError = new BiliError('api'); f.advance(60000); await f.scheduler.tick();
    assert.equal(f.bili.writes.length,2);
    assert.equal(f.store.db.prepare('SELECT state FROM interactions WHERE bvid=?').get('BV1000000002')?.state,'failed');
    assert.equal(f.store.db.prepare('SELECT state FROM interactions WHERE bvid=?').get('BV1000000003')?.state,'queued');
    // A row confirmed before receipts existed has no cover/rpid and only the discovery play count.
    const legacy = { ...f.bili.videos[0],bvid: 'BV1000000004',aid: 4,title: '测试视频',play: 42 }; f.store.discover(legacy,f.id,'关键词一',initialTime);
    f.store.db.prepare("INSERT INTO interactions(bvid,topic_id,action,state,due,attempted,content,target) VALUES(?,?,'reply','succeeded',0,?,'好耶','普通用户')").run(legacy.bvid,f.id,initialTime - 1);
    const rows = f.store.recentComments();
    assert.deepEqual(rows.map(row => row.bvid),['BV1000000001','BV1000000004']);
    assert.deepEqual(rows[0],{ id: rows[0].id,time: initialTime + 60000,action: 'comment',bvid: 'BV1000000001',title: "沙盒&生存 '第一期'",author: '测试UP',topic: '任意兴趣',keyword: '关键词一',content: f.bili.writes[0].text,target: '',cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',rpid: 290501715345,stats: { view: 12345,like: 6,reply: 7,favorite: 8 },statsAt: 'post' });
    assert.deepEqual({ ...rows[1],id: 0 },{ id: 0,time: initialTime - 1,action: 'reply',bvid: 'BV1000000004',title: '测试视频',author: '测试UP',topic: '任意兴趣',keyword: '关键词一',content: '好耶',target: '普通用户',cover: null,rpid: null,stats: { view: 42 },statsAt: 'discover' });
    app = await createApp(f.store,f.bili,f.scheduler,join(directory,'credential.json'),false);
    const response = await app.inject({ method:'GET',url:'/api/state' }); assert.equal(response.statusCode,200);
    const body = z.object({ recentComments: z.array(recentCommentSchema) }).passthrough().parse(response.json());
    assert.deepEqual(body.recentComments,rows); assert.equal('recent' in body,false);
  } finally { await app?.close(); await f.scheduler.close(); f.store.close(); rmSync(directory,{ recursive:true }); }
});
test.skip('a paused scheduler verifies login at startup and every 12 hours without patrolling', async () => {
  const f = fixture(); let checks = 0; f.bili.beforeCheck = () => { checks++; };
  assert.equal(f.store.settings().pauseReason,'启动后暂停，请检查登录状态'); assert.equal(f.store.account().loggedIn,false);
  await f.scheduler.tick();
  assert.equal(checks,1); assert.equal(f.store.account().loggedIn,true); assert.equal(f.store.settings().running,false);
  assert.match(f.store.settings().pauseReason,/登录有效，可手动启动巡逻/);
  f.advance(12*3600000 - 1); await f.scheduler.tick(); assert.equal(checks,1);
  f.bili.loggedIn = false; f.advance(1); await f.scheduler.tick();
  assert.equal(checks,2); assert.equal(f.store.account().loggedIn,false);
  assert.equal(f.bili.searches,0); assert.equal(f.bili.writes.length,0); f.store.close();
});
test.skip('a failed idle login check keeps the current state and retries after 5 minutes', async () => {
  const f = fixture(); let checks = 0; f.bili.beforeCheck = () => { checks++; throw new BiliError('risk'); };
  const before = f.store.settings(); await f.scheduler.tick();
  assert.equal(checks,1); assert.deepEqual(f.store.settings(),before); assert.deepEqual(f.store.activity(),[]);
  f.advance(5*60000 - 1); await f.scheduler.tick(); assert.equal(checks,1);
  f.bili.beforeCheck = () => { checks++; }; f.advance(1); await f.scheduler.tick();
  assert.equal(checks,2); assert.equal(f.store.account().loggedIn,true);
  f.advance(5*60000); await f.scheduler.tick(); assert.equal(checks,2); f.store.close();
});
test.skip('existing databases gain the receipt column without losing confirmed comments', async () => {
  const directory = mkdtempSync(join(tmpdir(),'yui-receipt-')); const path = join(directory,'patrol.sqlite');
  const f = fixture('comment',path); await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
  await f.scheduler.close(); f.store.db.exec('ALTER TABLE interactions DROP COLUMN receipt'); f.store.close();
  const upgraded = new Store(path);
  assert.equal(upgraded.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interactions') WHERE name='receipt'").get()?.n,1);
  const [row] = upgraded.recentComments(); assert.equal(row.bvid,'BV1000000001'); assert.equal(row.statsAt,'discover'); assert.equal(row.cover,null);
  upgraded.close(); rmSync(directory,{ recursive:true });
});
test.skip('backoff survives idle login checks and consecutive failed searches auto-pause', async () => {
  const f = fixture(); f.bili.searchError = new BiliError('api'); await f.scheduler.run(); await f.scheduler.tick();
  assert.equal(f.store.settings().readFailures,1); f.advance(59999); await f.scheduler.tick(); assert.equal(f.bili.searches,1);
  f.advance(1); await f.scheduler.tick(); assert.equal(f.store.settings().readFailures,2);
  f.advance(120000); await f.scheduler.tick(); assert.equal(f.store.settings().readFailures,3); assert.equal(f.store.settings().running,false); f.store.close();
});
test.skip('successful discovery cannot reset interaction failures or their exponential backoff', async () => {
  const f = fixture(); f.bili.postError = new BiliError('api');
  f.bili.videos.push({ ...f.bili.videos[0],bvid:'BV1000000002',aid:2 },{ ...f.bili.videos[0],bvid:'BV1000000003',aid:3 });
  await f.scheduler.run(); await f.scheduler.tick();
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.store.settings().failures,1);
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.store.settings().failures,2);
  const retryAt = f.store.settings().retryAt; assert.equal(retryAt,f.time()+120000);
  f.advance(60000); await f.scheduler.tick();
  assert.equal(f.bili.searches,4); assert.equal(f.bili.writes.length,2);
  assert.equal(f.store.settings().failures,2); assert.equal(f.store.settings().retryAt,retryAt);
  assert.equal(f.store.settings().readFailures,0);
  f.advance(60000); await f.scheduler.tick();
  assert.equal(f.bili.writes.length,3); assert.equal(f.store.settings().failures,3);
  assert.equal(f.store.settings().running,false); assert.match(f.store.settings().pauseReason,/连续失败/);
  f.advance(600000); await f.scheduler.tick(); assert.equal(f.bili.writes.length,3); f.store.close();
});
test.skip('latest minimum spacing changed during login check defers claim until the new boundary', async () => {
  const f = fixture(); f.bili.videos.push({ ...f.bili.videos[0],bvid:'BV1000000002',aid:2 });
  await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
  const firstAttempt = f.time(); let checks = 0;
  f.bili.beforeCheck = () => { if (++checks === 2) { const s = f.store.settings(); s.limits.waitMin = 30; s.limits.waitMax = 30; f.store.saveSettings(s); } };
  f.advance(60000); await f.scheduler.tick();
  assert.equal(f.bili.writes.length,1); assert.equal(f.store.attemptCount(f.time()),1);
  assert.equal(f.store.db.prepare('SELECT state FROM interactions WHERE bvid=?').get('BV1000000002')?.state,'queued');
  f.bili.beforeCheck = undefined;
  f.advance(28*60000); await f.scheduler.tick(); assert.equal(f.bili.writes.length,1);
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.bili.writes.length,2);
  assert.equal(f.time()-firstAttempt,30*60000);
  assert.equal(f.store.db.prepare('SELECT attempted FROM interactions WHERE bvid=?').get('BV1000000002')?.attempted,f.time()); f.store.close();
});
test.skip('templates avoid consecutive identical content and disabled templates do not send', async () => {
  const f = fixture(); f.bili.videos.push({ ...f.bili.videos[0],bvid:'BV1000000002',aid:2 }); await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
  assert.equal(f.store.activity('comment').length,2); assert.notEqual(f.bili.writes[0].text,f.bili.writes[1].text);
  const last = f.store.settings().lastContent;
  for (const template of f.store.templates()) if (template.text !== last) f.store.saveTemplate({ ...template,enabled:false },template.id);
  f.bili.videos = [{ ...f.bili.videos[0],bvid:'BV1000000003',aid:3 }]; f.advance(60000); await f.scheduler.tick(); f.advance(60000); await f.scheduler.tick();
  assert.equal(f.bili.writes.length,2); assert.equal(f.store.activity('skip')[0].result,'无可用且不重复的模板'); f.store.close();
});
test.skip('age/playback filtering and 100% Skip never queue an interaction', async () => {
  const f = fixture('skip'); const topic = f.store.topic(f.id); assert.ok(topic); topic.minPlay = 50; topic.maxPlay = 200; f.store.saveTopic(topic,topic.id);
  f.bili.videos.push({ ...f.bili.videos[0],bvid:'BV1000000002',aid:2,play:10 },{ ...f.bili.videos[0],bvid:'BV1000000003',aid:3,pubdate:(initialTime-100*3600000)/1000 });
  await f.scheduler.run(); await f.scheduler.tick(); assert.equal(f.store.count('discover',f.time()),1); assert.equal(f.store.count('skip',f.time()),1); f.advance(60000); await f.scheduler.tick(); assert.equal(f.bili.writes.length,0); f.store.close();
});
test.skip('empty heat threshold rejects low plays before dedup; exact heat and age boundaries queue', async () => {
  const f = fixture();
  try {
    f.store.saveTopic({ ...f.store.topic(f.id)!, minPlay: null, maxPlay: 1500 }, f.id);
    const base = f.bili.videos[0];
    f.bili.videos = [
      { ...base, play: 2 },
      { ...base, bvid: 'BV1000000002', aid: 2, play: 999 },
      { ...base, bvid: 'BV1000000003', aid: 3, play: 1000, pubdate: (initialTime - 72 * 3600000) / 1000 },
      { ...base, bvid: 'BV1000000004', aid: 4, play: 1500 },
      { ...base, bvid: 'BV1000000005', aid: 5, play: 1501 },
      { ...base, bvid: 'BV1000000006', aid: 6, play: 1000, pubdate: (initialTime - 72 * 3600000 - 1000) / 1000 },
      { ...base, bvid: 'BV1000000007', aid: 7, play: 1000, pubdate: (initialTime + 1000) / 1000 },
    ];
    await f.scheduler.run(); await f.scheduler.tick();
    assert.deepEqual(f.store.db.prepare('SELECT bvid FROM discoveries ORDER BY bvid').all().map(r => r.bvid), ['BV1000000003', 'BV1000000004']);
    assert.deepEqual(f.store.db.prepare('SELECT bvid,state FROM interactions ORDER BY bvid').all().map(r => [r.bvid, r.state]), [['BV1000000003', 'queued'], ['BV1000000004', 'queued']]);
    assert.deepEqual(f.bili.writes, []);
    // A filtered video has not consumed global dedup and can grow into eligibility.
    f.bili.videos = [{ ...base, play: 1000 }];
    f.advance(60000); await f.scheduler.tick();
    assert.equal(f.store.db.prepare('SELECT state FROM interactions WHERE bvid=?').get(base.bvid)?.state, 'queued');
  } finally { await f.scheduler.close(); f.store.close(); }
});
test.skip('raising heat threshold during final login prevents claim of an old queue', async () => {
  const f = fixture();
  try {
    f.bili.videos[0].play = 1000;
    f.store.saveTopic({ ...f.store.topic(f.id)!, minPlay: 1000 }, f.id);
    await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000);
    let checks = 0;
    f.bili.beforeCheck = () => {
      if (++checks === 2) f.store.saveTopic({ ...f.store.topic(f.id)!, minPlay: 2000 }, f.id);
    };
    await f.scheduler.tick();
    assert.deepEqual(f.bili.writes, []);
    assert.equal(f.store.attemptCount(f.time()), 0);
    assert.equal(f.store.db.prepare('SELECT state FROM interactions').get()?.state, 'skipped');
    assert.equal(f.store.settings().nextInteraction, 0);
  } finally { await f.scheduler.close(); f.store.close(); }
});
test.skip('configuration edits during login check cannot bypass the latest limits', async () => {
  const f = fixture(); await f.scheduler.run(); await f.scheduler.tick(); f.advance(60000);
  let checks = 0; f.bili.beforeCheck = () => { if (++checks === 2) { const s = f.store.settings(); s.limits.dailyTotal = 0; f.store.saveSettings(s); } };
  await f.scheduler.tick(); assert.equal(f.store.attemptCount(f.time()),0); assert.equal(f.bili.writes.length,0); f.store.close();
});
test.skip('account day boundary is Shanghai midnight, independent of host timezone', () => {
  assert.equal(dayStart(Date.parse('2026-10-04T15:59:59Z')),Date.parse('2026-10-03T16:00:00Z'));
  assert.equal(dayStart(Date.parse('2026-10-04T16:00:00Z')),Date.parse('2026-10-04T16:00:00Z'));
});
