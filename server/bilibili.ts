import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BiliError, accountSchema, renewalSchema, videoSchema, commentSchema, postStatsSchema, operationStatusSchema, normalizeKeywordText, type Account, type Bilibili, type PostReceipt, type OperationStatus } from './model.js';
const errorResult = z.object({ error_type: z.enum(['risk','auth','api','disabled']), stage:z.enum(['prepare','send','receipt','unknown']).optional(), send_state:z.enum(['confirmed_not_sent','uncertain','not_applicable']).optional(), error_code:z.string().optional() });
export function normalizeSearchText(value:string) {
  return normalizeKeywordText(decodeSearchHtml(value));
}
function decodeSearchHtml(value:string) {
  return value.replace(/<[^>]*>/g,'').replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi,(match,decimal?:string,hex?:string,name?:string)=>{
    if(name)return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name.toLowerCase()]??match);
    const code=decimal?Number(decimal):parseInt(hex??'',16);return code>0&&code<=0x10ffff?String.fromCodePoint(code):match;
  });
}
function containsAsciiToken(text:string, token:string) {
  let start=0;
  while(true) {
    const at=text.indexOf(token,start);
    if(at<0)return false;
    const before=at?text[at-1]:''; const after=text[at+token.length]??'';
    if(!/[\p{Script=Latin}\p{N}]/u.test(before)&&!/[\p{Script=Latin}\p{N}]/u.test(after))return true;
    start=at+1;
  }
}
export function keywordMatchesTitle(keyword:string,title:string) {
  const normalized=normalizeSearchText(keyword);
  if(!normalized)return false;
  const ascii=/^[a-z0-9]+$/.test(normalized);
  const text=normalizeSearchText(title);
  return ascii?containsAsciiToken(text,normalized):text.includes(normalized);
}
// Covers render as <img>, so only Bilibili's image CDN is kept, always over HTTPS.
export function coverUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (!['http:','https:'].includes(url.protocol) || !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) return undefined;
    url.protocol = 'https:';
    return url.href;
  } catch { return undefined; }
}
export function loginAccount(data: unknown): Account {
  const value = z.object({ logged_in: z.boolean(), username: z.string().optional(), uid: z.string().optional(), message: z.string(), renewal: z.unknown() }).parse(data);
  // Renewal is display-only; a malformed report must not fail the login check itself.
  const renewal = renewalSchema.safeParse(value.renewal);
  return accountSchema.parse({ loggedIn: value.logged_in, username: value.username, uid: value.uid, message: value.message, ...(renewal.success ? { renewal: renewal.data } : {}) });
}
// The send already succeeded; malformed display metadata only drops the affected field.
export function postReceipt(data: unknown): PostReceipt {
  const value = z.object({ rpid: z.unknown(), cover: z.unknown(), stat: z.unknown() }).partial().catch({}).parse(data);
  const rpid = z.number().int().positive().safeParse(value.rpid);
  const cover = typeof value.cover === 'string' ? coverUrl(value.cover) : undefined;
  const stats = postStatsSchema.safeParse(value.stat);
  return { ...(rpid.success ? { rpid: rpid.data } : {}), ...(cover ? { cover } : {}), ...(stats.success ? { stats: stats.data } : {}) };
}
export class McpBilibili implements Bilibili {
  private client = new Client({ name: 'yui-bilibili', version: '1.0.0' });
  private connected?: Promise<void>;
  constructor(private python: string, private credentialFile: string) {}
  private connect() {
    if (!this.connected) {
      const env: Record<string,string> = {};
      for (const [key,value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
      env.BILI_CREDENTIAL_FILE = this.credentialFile;
      const python = this.python.endsWith('/bin/python') && process.platform === 'win32' && existsSync(join(dirname(dirname(this.python)), 'Scripts', 'python.exe')) ? join(dirname(dirname(this.python)), 'Scripts', 'python.exe') : this.python;
      this.connected = this.client.connect(new StdioClientTransport({ command: python, args: ['bridge/server.py'], cwd: process.cwd(), env, stderr: 'ignore' }));
    }
    return this.connected;
  }
  private async call(name: string, args: Record<string,unknown> = {}): Promise<unknown> {
    try {
      await this.connect();
      const response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
      const parsed = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(response);
      if (parsed.isError) throw new BiliError('api',name==='bili_reply'?'send':'unknown',name==='bili_reply'?'uncertain':'not_applicable','mcp_tool_error');
      const text = parsed.content.find(c => c.type === 'text')?.text;
      if (!text) throw new BiliError('api');
      const data: unknown = JSON.parse(text);
      const error = errorResult.safeParse(data);
      if (error.success) throw new BiliError(error.data.error_type,error.data.stage??'unknown',error.data.send_state??(name==='bili_reply'?'uncertain':'not_applicable'),error.data.error_code??'');
      return data;
    } catch (error) {
      if (error instanceof BiliError) throw error;
      throw new BiliError('api',name==='bili_reply'?'send':'unknown',name==='bili_reply'?'uncertain':'not_applicable','mcp_call_failed');
    }
  }
  async checkLogin() {
    try {
      return loginAccount(await this.call('bili_check_credential'));
    } catch (e) {
      if (e instanceof BiliError && e.kind === 'auth') return { loggedIn: false, message: '登录失效，请重新登录' };
      throw e;
    }
  }
  async search(keyword: string) {
    const result = z.object({ videos: z.array(z.unknown()) }).parse(await this.call('bili_search', { keyword, num: 50, order: 'click' }));
    const videos = [];
    for (const value of result.videos) {
      const parsed = videoSchema.safeParse(value);
      if (parsed.success) videos.push({ ...parsed.data,title:decodeSearchHtml(parsed.data.title).replace(/\s+/g,' ').trim(),author:decodeSearchHtml(parsed.data.author).replace(/\s+/g,' ').trim() });
    }
    return videos;
  }
  async comments(bvid: string) {
    const result = z.object({ comments: z.array(z.unknown()) }).parse(await this.call('bili_comments', { bvid, num: 30 }));
    const comments = [];
    for (const value of result.comments) {
      const parsed = commentSchema.safeParse(value);
      if (!parsed.success) throw new BiliError('api','prepare','confirmed_not_sent','malformed_comments');
      comments.push(parsed.data);
    }
    return comments;
  }
  async post(bvid: string, text: string, rpid = 0, operationId = '') {
    const data = await this.call('bili_reply', { bvid, text, rpid, root: rpid, operation_id:operationId });
    const result = z.object({ success: z.literal(true) }).safeParse(data);
    if (!result.success) throw new BiliError('api','send','uncertain','malformed_send_receipt');
    return postReceipt(data);
  }
  async operationStatus(bvid: string, text: string, rpid: number, operationId: string): Promise<OperationStatus> {
    const value = await this.call('bili_reply', { bvid, text, rpid, root: rpid, operation_id:`lookup:${operationId}` });
    return operationStatusSchema.parse(value);
  }
  async tools() {
    await this.connect();
    return (await this.client.listTools()).tools;
  }
  async qrStart() { return z.object({ status: z.string(), message: z.string(), qrcode_image: z.string() }).parse(await this.call('bili_login')); }
  async qrCheck() { return z.object({ status: z.string().optional(), message: z.string() }).parse(await this.call('bili_login_check')); }
  async resetSession() {
    await this.client.close();
    this.client = new Client({ name: 'yui-bilibili', version: '1.0.0' });
    this.connected = undefined;
  }
  async close() { await this.client.close(); }
}
