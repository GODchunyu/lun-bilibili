import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { createApp, type ApplicationBilibili } from '../server/app.js';

test('state API exposes server time, scheduler status and queue summary without secrets', async () => {
  const store = new Store(':memory:');
  const bili: ApplicationBilibili = {
    async checkLogin() { return { loggedIn: true, uid: '100', username: '测试账号', message: '已登录' }; },
    async search() { return []; }, async comments() { return []; }, async post() { return {}; },
    async tools() { return []; }, async qrStart() { return { status: '', message: '', qrcode_image: '' }; }, async qrCheck() { return { message: '' }; }, async resetSession() {},
  };
  const scheduler = new Scheduler(store, bili);
  const app = await createApp(store, bili, scheduler, 'unused-test-credential.json', false);
  try {
    const response = await app.inject({ url: '/api/state' });
    assert.equal(response.statusCode, 200);
    const state = response.json() as { serverNow:number; runtime:{phase:string;reasonCode:string;serverNow:number;nextAction:{kind:string;at:number|null};inFlight:boolean}; queue:Record<string,number|null>; system:{writesEnabled:boolean;queued:number} };
    assert.equal(typeof state.serverNow, 'number'); assert.equal(state.runtime.phase, 'paused'); assert.equal(state.runtime.reasonCode, 'startup_paused');
    assert.equal(typeof state.runtime.serverNow, 'number'); assert.equal(state.runtime.nextAction.kind, 'manual_action'); assert.equal(state.runtime.inFlight, false);
    assert.equal(state.queue.pending, 0); assert.equal(state.queue.due, 0); assert.equal(state.queue.claimed, 0); assert.equal(state.queue.uncertain, 0);
    assert.equal(state.system.queued, state.queue.pending); assert.equal(state.system.writesEnabled, false); assert.equal(response.body.includes('Cookie'), false); assert.equal(response.body.includes('"apiKey":'), false);
  } finally { await scheduler.close(); await app.close(); store.close(); }
});
