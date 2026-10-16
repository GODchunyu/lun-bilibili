import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { createApp, type ApplicationBilibili } from '../server/app.js';
import { parseCookie } from '../server/auth.js';
test('Cookie login is private, validates, pauses, supports expiration and logout without returning credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(),'yui-account-'));
  const path = join(directory,'config/bili_credential.json'); const store = new Store(':memory:');
  let valid = true;
  const bili: ApplicationBilibili = {
    async checkLogin() { return { loggedIn:valid,username:'测试账号',uid:'100',message:valid?'已登录':'登录失效' }; },
    async search() { throw new Error('This account test never searches'); }, async comments() { throw new Error('This account test never reads comments'); },
    async post() { throw new Error('This account test never writes to Bilibili'); }, async tools() { throw new Error('Not used'); }, async qrStart() { throw new Error('Not used'); }, async qrCheck() { throw new Error('Not used'); },
    async resetSession() { valid = true; },
  };
  const scheduler = new Scheduler(store,bili); const app = await createApp(store,bili,scheduler,path,true);
  // Synthetic values only. Never use a real account credential in tests or snapshots.
  const marker = 'LOCAL_TEST_ONLY_NOT_A_CREDENTIAL';
  const cookie = `SESSDATA=${marker}=encoded; bili_jct=${marker}; DedeUserID=100; buvid3=local-test`;
  try {
    const response = await app.inject({ method:'POST',url:'/api/account/cookie',payload:{ cookie } });
    assert.equal(response.statusCode,200); assert.equal(store.account().username,'测试账号'); assert.equal(response.body.includes(marker),false);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777,0o600);
    const saved = z.object({ sessdata:z.string() }).parse(JSON.parse(await readFile(path,'utf8')));
    assert.equal(saved.sessdata,`${marker}=encoded`);
    await scheduler.run(); assert.equal(store.settings().running,true);
    valid = false;
    const expired = await app.inject({ method:'POST',url:'/api/account/check' }); assert.equal(expired.statusCode,200); assert.equal(store.settings().running,false); assert.equal(store.account().loggedIn,false);
    const invalid = await app.inject({ method:'POST',url:'/api/account/cookie',payload:{ cookie:'invalid' } }); assert.equal(invalid.statusCode,400);
    const logout = await app.inject({ method:'DELETE',url:'/api/account' }); assert.equal(logout.statusCode,200);
    await assert.rejects(stat(path),{ code:'ENOENT' }); assert.equal(store.account().loggedIn,false);
    assert.throws(() => parseCookie('SESSDATA=missing-other-fields'));
  } finally { await scheduler.close(); await app.close(); store.close(); await rm(directory,{recursive:true}); }
});
test('Cookie login keeps an optional refresh token; a malformed token changes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(),'yui-token-'));
  const path = join(directory,'config/bili_credential.json'); const store = new Store(':memory:'); let resets = 0;
  const bili: ApplicationBilibili = {
    async checkLogin() { return { loggedIn:true,username:'测试账号',uid:'100',message:'已登录' }; }, async search() { throw new Error('Not used'); }, async comments() { throw new Error('Not used'); }, async post() { throw new Error('Not used'); }, async tools() { throw new Error('Not used'); }, async qrStart() { throw new Error('Not used'); }, async qrCheck() { throw new Error('Not used'); },
    async resetSession() { resets++; },
  };
  const scheduler = new Scheduler(store,bili); const app = await createApp(store,bili,scheduler,path,true);
  const cookie = 'SESSDATA=LOCAL_TEST_ONLY; bili_jct=LOCAL_TEST_ONLY; DedeUserID=100';
  try {
    assert.equal((await app.inject({ method:'POST',url:'/api/account/cookie',payload:{ cookie,refreshToken:'0123456789abcdef0123456789abcdef' } })).statusCode,200);
    assert.equal(JSON.parse(await readFile(path,'utf8')).ac_time_value,'0123456789abcdef0123456789abcdef');
    const saved = await readFile(path,'utf8'); await scheduler.run(); const resetsBefore = resets;
    const invalid = await app.inject({ method:'POST',url:'/api/account/cookie',payload:{ cookie,refreshToken:'not a token' } });
    assert.equal(invalid.statusCode,400); assert.equal(await readFile(path,'utf8'),saved);
    assert.equal(store.settings().running,true); assert.equal(resets,resetsBefore);
    assert.equal((await app.inject({ method:'POST',url:'/api/account/cookie',payload:{ cookie } })).statusCode,200);
    assert.equal('ac_time_value' in JSON.parse(await readFile(path,'utf8')),false);
    assert.equal(parseCookie(`${cookie}; ac_time_value=fedcba9876543210fedcba9876543210`).ac_time_value,'fedcba9876543210fedcba9876543210');
  } finally { await scheduler.close(); await app.close(); store.close(); await rm(directory,{recursive:true}); }
});
test('a completed QR scan re-verifies the account and never keeps showing the previous login', async () => {
  const store = new Store(':memory:'); let verify: () => Promise<{ loggedIn: boolean; username?: string; message: string }> = async () => ({ loggedIn:true,username:'新账号',message:'已登录' });
  const bili: ApplicationBilibili = {
    checkLogin: () => verify(), async search() { throw new Error('Not used'); }, async comments() { throw new Error('Not used'); }, async post() { throw new Error('Not used'); }, async tools() { throw new Error('Not used'); }, async qrStart() { throw new Error('Not used'); },
    async qrCheck() { return { status:'done',message:'登录完成' }; }, async resetSession() { throw new Error('Not used'); },
  };
  const scheduler = new Scheduler(store,bili); const app = await createApp(store,bili,scheduler,'unused.json',false);
  try {
    const ok = await app.inject({ method:'POST',url:'/api/account/qr/check' }); assert.equal(ok.statusCode,200); assert.equal(store.account().username,'新账号');
    verify = async () => { throw new Error('LOCAL_VERIFY_FAILURE'); };
    const failed = await app.inject({ method:'POST',url:'/api/account/qr/check' });
    assert.equal(failed.statusCode,400); assert.equal(failed.body.includes('LOCAL_VERIFY_FAILURE'),false);
    assert.equal(store.account().loggedIn,false); assert.match(store.account().message,/扫码完成但登录验证失败/);
  } finally { await scheduler.close(); await app.close(); store.close(); }
});
test('cross-site mutations and host rebinding are rejected before saving account or configuration', async () => {
  const store = new Store(':memory:');
  const bili: ApplicationBilibili = {
    async checkLogin() { return { loggedIn:false,message:'未登录' }; }, async search() { throw new Error('Not used'); }, async comments() { throw new Error('Not used'); }, async post() { throw new Error('Not used'); }, async tools() { throw new Error('Not used'); }, async qrStart() { throw new Error('Not used'); }, async qrCheck() { throw new Error('Not used'); },
    async resetSession() { throw new Error('Not used'); },
  };
  const scheduler = new Scheduler(store,bili); const app = await createApp(store,bili,scheduler,'unused.json',false);
  try {
    const crossSite = await app.inject({ method:'POST',url:'/api/scheduler',headers:{ origin:'https://evil.invalid' },payload:{ running:true } }); assert.equal(crossSite.statusCode,403);
    const rebound = await app.inject({ url:'/api/state',headers:{ host:'evil.invalid' } }); assert.equal(rebound.statusCode,403); assert.equal(store.settings().running,false);
  } finally { await app.close(); store.close(); }
});
