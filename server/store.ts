import type { RuntimeFacts, RuntimeTopic } from './runtime-view.js';
import { quotaDecision } from './eligibility.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, chmodSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { dayStart, limitsSchema, topicSchema, accountSchema, settingsSchema, aiConfigSchema, activitySchema, videoSchema, postReceiptSchema, interactionActionSchema, interactionStateSchema, dispatchClassSchema, attemptStatusSchema, failureStageSchema, queueSummarySchema, type AiConfig, type Topic, type TopicConfig, type Template, type Settings, type Activity, type Video, type RecentComment, type InteractionState, type AttemptStatus, type InteractionPlan, type InteractionAttempt, type QueueSummary } from './model.js';
const dataRow = z.object({ data: z.string() });
const countRow = z.object({ n: z.number() });
const queueSchema = z.object({ id: z.number(), bvid: z.string(), topic_id: z.number(), action: z.enum(['comment','reply']), state: z.string(), due: z.number(), video: z.string(), keyword: z.string() });
const claimedSchema = activitySchema.pick({ topicId: true, bvid: true, content: true, target: true, keyword: true }).extend({ time: z.number().nullable(), video: z.string(), config: z.string().nullable() });
const topicNameSchema = topicSchema.innerType().pick({ name: true });
export const STARTUP_PAUSE = '启动后暂停，请检查登录状态';
const recentRowSchema = z.object({ id: z.number(), action: z.enum(['comment','reply']), attempted: z.number(), content: z.string(), target: z.string(), receipt: z.string(), video: z.string(), keyword: z.string(), config: z.string().nullable() });
const planRowSchema = z.object({
  id: z.number(), bvid: z.string(), aid: z.number().nullable(), topic_id: z.number().nullable(), owner_uid: z.string(), topic_name: z.string(), keyword: z.string(), matched_field: z.string(), video: z.string(), planned_action: z.string(), comment_templates: z.string(), reply_templates: z.string(), snapshot_source: z.string(), first_enqueued_at: z.number(), cycle_start_day: z.number(), cycle_deadline_day: z.number(), due_at: z.number(), deferred: z.number().default(0), overflow: z.number(), cycle_count: z.number(), failure_count: z.number(), state: z.string(), version: z.number(), next_prepare_at: z.number().nullable(), read_day: z.number().nullable(), read_count: z.number(), channel_disabled: z.number(), orphaned: z.number(), cancel_requested: z.number(), resume_state: z.string().nullable(),
});
const attemptRowSchema = z.object({
  id: z.number(), plan_id: z.number(), attempt_no: z.number(), operation_id: z.string(), quota_day: z.number(), dispatch_class: z.string(), billing_topic_id: z.number().nullable(), billing_topic_name: z.string(), sender_uid: z.string(), started_at: z.number(), finished_at: z.number().nullable(), effective_action: z.string(), fallback_reason: z.string(), content: z.string(), target: z.string(), target_id: z.number(), target_uid: z.string(), status: z.string(), failure_stage: z.string(), error_code: z.string(), receipt: z.string(), request_uncertain: z.number(), request_in_flight: z.number().default(0),
});
const eventRowSchema = z.object({ id: z.number(), plan_id: z.number(), event_type: z.string(), at: z.number(), cycle: z.number(), from_state: z.string(), to_state: z.string(), reason: z.string(), error_code: z.string() });
const accountBindingRowSchema = z.object({ uid: z.string(), bound_at: z.number(), verified: z.number() });
const createPlanInputSchema = z.object({
  video: videoSchema, topicId: z.number().int().positive(), ownerUid: z.string().trim().min(1), topicName: z.string().min(1), keyword: z.string().min(1), matchedField: z.string().min(1),
  plannedAction: interactionActionSchema, commentTemplates: z.array(z.string().trim().min(1)).min(1), replyTemplates: z.array(z.string().trim().min(1)).min(1), createdAt: z.number().int(), dueAt: z.number().int(), cycleStartDay: z.number().int(), cycleDeadlineDay: z.number().int(), overflow: z.boolean().default(false), deferred: z.boolean().default(false),
});
const claimPlanInputSchema = z.object({ planId: z.number().int().positive(), expectedVersion: z.number().int().nonnegative(), now: z.number().int(), quotaDay: z.number().int(), dispatchClass: dispatchClassSchema.exclude(['legacy_unknown']), billingTopicId: z.number().int().positive().nullable(), billingTopicName: z.string(), senderUid: z.string().min(1), effectiveAction: interactionActionSchema, fallbackReason: z.string().default(''), content: z.string(), target: z.string().default(''), targetId: z.number().int().nonnegative().default(0), targetUid: z.string().default(''), nextInteractionAt: z.number().int().default(0), limits: limitsSchema.default(limitsSchema.parse({})) });
const finishAttemptInputSchema = z.object({ attemptId: z.number().int().positive(), outcome: z.enum(['succeeded','confirmed_failure','uncertain','manual_review']), finishedAt: z.number().int(), receipt: z.string().default(''), failureStage: failureStageSchema.default('unknown'), errorCode: z.string().default(''), requestInFlight: z.boolean().default(false), retryAt: z.number().int().optional(), retryOverflow: z.boolean().default(false), evidence: z.string().trim().max(500).default('') });
const entities: Record<string,string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Search titles arrive HTML-escaped (for example &amp;); decode them for plain-text display.
function plainTitle(title: string) {
  return title.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (match, decimal?: string, hex?: string, name?: string) => {
    if (name) return entities[name.toLowerCase()];
    const code = decimal ? Number(decimal) : parseInt(hex ?? '', 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
function acquireDatabaseLock(databasePath: string) {
  const absolute = resolve(databasePath);
  const directory = realpathSync(dirname(absolute));
  const canonicalPath = resolve(directory, basename(absolute));
  const identity = process.platform === 'win32' ? canonicalPath.toLocaleLowerCase('en-US') : canonicalPath;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const lockPath = resolve(directory, `.${basename(absolute)}.${digest}.instance-lock`);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      const record = JSON.stringify({ pid: process.pid, token, database: identity });
      writeFileSync(fd, record, 'utf8');
      fsyncSync(fd);
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string };
          if (current.token === token) unlinkSync(lockPath);
        } catch { /* A replaced or removed lock is not ours to clear. */ }
        try { closeSync(fd); } catch { /* Already closed. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number; token?: string; database?: string };
      try { owner = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof owner; }
      catch { throw new Error('数据库实例锁存在但无法验证拥有者；为保护数据，拒绝启动'); }
      if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.database !== identity) throw new Error('数据库实例锁无效；为保护数据，拒绝启动');
      try {
        process.kill(owner.pid, 0);
        throw new Error(`数据库已由进程 ${owner.pid} 使用；第二个实例不能启动`);
      } catch (probeError) {
        if (probeError instanceof Error && probeError.message.startsWith('数据库已由进程')) throw probeError;
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`不能确认数据库锁拥有者 ${owner.pid} 已退出；拒绝接管`);
      }
      try { unlinkSync(lockPath); } catch { throw new Error('无法清理已退出进程的数据库锁；拒绝启动'); }
    }
  }
  throw new Error('无法取得数据库实例锁');
}
export class Store {
  readonly db: DatabaseSync;
  private releaseLock?: () => void;
  private readonly random: () => number;
  constructor(path: string, random = Math.random) {
    this.random = random;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (path !== ':memory:') this.releaseLock = acquireDatabaseLock(path);
    try { this.db = new DatabaseSync(path); }
    catch (error) { this.releaseLock?.(); this.releaseLock=undefined; throw error; }
    try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY, config TEXT NOT NULL, next_search INTEGER NOT NULL, last_run INTEGER);
      CREATE TABLE IF NOT EXISTS keywords(topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, keyword TEXT NOT NULL, PRIMARY KEY(topic_id,keyword));
      CREATE TABLE IF NOT EXISTS templates(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS discoveries(bvid TEXT PRIMARY KEY, aid INTEGER NOT NULL UNIQUE, topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, video TEXT NOT NULL, keyword TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions(id INTEGER PRIMARY KEY, bvid TEXT NOT NULL UNIQUE REFERENCES discoveries(bvid), topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, action TEXT NOT NULL, state TEXT NOT NULL, due INTEGER NOT NULL, attempted INTEGER, content TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', receipt TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, time INTEGER NOT NULL, topic_id INTEGER, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_time ON activity(time);
      CREATE INDEX IF NOT EXISTS interactions_due ON interactions(state,due);
      CREATE TABLE IF NOT EXISTS interaction_plans(
        id INTEGER PRIMARY KEY, bvid TEXT NOT NULL UNIQUE REFERENCES discoveries(bvid), aid INTEGER,
        topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, owner_uid TEXT NOT NULL DEFAULT 'unknown',
        topic_name TEXT NOT NULL DEFAULT '', keyword TEXT NOT NULL DEFAULT '', matched_field TEXT NOT NULL DEFAULT '', video TEXT NOT NULL,
        planned_action TEXT NOT NULL, comment_templates TEXT NOT NULL DEFAULT '[]', reply_templates TEXT NOT NULL DEFAULT '[]', snapshot_source TEXT NOT NULL DEFAULT 'native',
        first_enqueued_at INTEGER NOT NULL, cycle_start_day INTEGER NOT NULL, cycle_deadline_day INTEGER NOT NULL, due_at INTEGER NOT NULL, deferred INTEGER NOT NULL DEFAULT 0,
        overflow INTEGER NOT NULL DEFAULT 0, cycle_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'scheduled', version INTEGER NOT NULL DEFAULT 0, next_prepare_at INTEGER,
        read_day INTEGER, read_count INTEGER NOT NULL DEFAULT 0, channel_disabled INTEGER NOT NULL DEFAULT 0,
        orphaned INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, resume_state TEXT
      );
      CREATE INDEX IF NOT EXISTS interaction_plans_due ON interaction_plans(state,due_at);
      CREATE INDEX IF NOT EXISTS interaction_plans_owner ON interaction_plans(owner_uid,state);
      CREATE TABLE IF NOT EXISTS interaction_attempts(
        id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES interaction_plans(id) ON DELETE CASCADE, attempt_no INTEGER NOT NULL,
        operation_id TEXT NOT NULL UNIQUE, quota_day INTEGER NOT NULL, dispatch_class TEXT NOT NULL,
        billing_topic_id INTEGER, billing_topic_name TEXT NOT NULL DEFAULT '', sender_uid TEXT NOT NULL DEFAULT 'unknown',
        started_at INTEGER NOT NULL, finished_at INTEGER, effective_action TEXT NOT NULL, fallback_reason TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', target_id INTEGER NOT NULL DEFAULT 0, target_uid TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        failure_stage TEXT NOT NULL DEFAULT 'unknown', error_code TEXT NOT NULL DEFAULT '', receipt TEXT NOT NULL DEFAULT '', request_uncertain INTEGER NOT NULL DEFAULT 0, request_in_flight INTEGER NOT NULL DEFAULT 0,
        UNIQUE(plan_id,attempt_no)
      );
      CREATE INDEX IF NOT EXISTS interaction_attempts_day ON interaction_attempts(quota_day,dispatch_class,status);
      CREATE INDEX IF NOT EXISTS interaction_attempts_plan ON interaction_attempts(plan_id,attempt_no);
      CREATE TABLE IF NOT EXISTS interaction_events(
        id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES interaction_plans(id) ON DELETE CASCADE, event_type TEXT NOT NULL,
        at INTEGER NOT NULL, cycle INTEGER NOT NULL DEFAULT 0, from_state TEXT NOT NULL DEFAULT '', to_state TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS interaction_events_plan ON interaction_events(plan_id,at,id);
      CREATE TABLE IF NOT EXISTS account_binding(id INTEGER PRIMARY KEY CHECK(id=1), uid TEXT NOT NULL, bound_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS topic_id_sequence(id INTEGER PRIMARY KEY CHECK(id=1), last_id INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS interaction_attempt_billing_immutable
      BEFORE UPDATE OF plan_id,attempt_no,operation_id,quota_day,dispatch_class,billing_topic_id,billing_topic_name,sender_uid,started_at,effective_action,target_id
      ON interaction_attempts
      BEGIN SELECT RAISE(ABORT,'interaction attempt accounting and identity fields are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS interaction_plan_no_delete
      BEFORE DELETE ON interaction_plans
      BEGIN SELECT RAISE(ABORT,'interaction plans are permanent deduplication history'); END;
      CREATE TABLE IF NOT EXISTS app_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_metadata(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    `);
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interactions') WHERE name='target'").get()).n) this.db.exec("ALTER TABLE interactions ADD COLUMN target TEXT NOT NULL DEFAULT ''");
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interactions') WHERE name='receipt'").get()).n) this.db.exec("ALTER TABLE interactions ADD COLUMN receipt TEXT NOT NULL DEFAULT ''");
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interaction_attempts') WHERE name='target_id'").get()).n) this.db.exec('ALTER TABLE interaction_attempts ADD COLUMN target_id INTEGER NOT NULL DEFAULT 0');
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interaction_attempts') WHERE name='request_in_flight'").get()).n) this.db.exec('ALTER TABLE interaction_attempts ADD COLUMN request_in_flight INTEGER NOT NULL DEFAULT 0');
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interaction_plans') WHERE name='resume_state'").get()).n) this.db.exec('ALTER TABLE interaction_plans ADD COLUMN resume_state TEXT');
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interaction_plans') WHERE name='deferred'").get()).n) this.db.exec('ALTER TABLE interaction_plans ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0');
    this.migrateInteractionTables();
    this.db.prepare('INSERT OR IGNORE INTO topic_id_sequence(id,last_id) VALUES(1,0)').run();
    this.db.prepare('UPDATE topic_id_sequence SET last_id=max(last_id,coalesce((SELECT max(id) FROM topics),0),coalesce((SELECT max(billing_topic_id) FROM interaction_attempts),0)) WHERE id=1').run();
    if (!countRow.parse(this.db.prepare('SELECT count(*) AS n FROM app_settings').get()).n) this.saveSettings(settingsSchema.parse({ limits: limitsSchema.parse({}), running: false, pauseReason: '默认暂停', failures: 0, retryAt: 0, nextInteraction: 0, lastContent: '', account: { loggedIn: false, message: '未登录' } }));
    // Never resume writes after restart. A claimed request may already have reached Bilibili.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.db.prepare("SELECT i.topic_id AS topicId,i.bvid,i.attempted AS time,i.content,i.target,d.keyword,d.video,t.config FROM interactions i JOIN discoveries d USING(bvid) LEFT JOIN topics t ON t.id=i.topic_id WHERE i.state='claimed'").all();
      this.db.prepare("UPDATE interactions SET state='uncertain' WHERE state='claimed'").run();
      for (const raw of claimed) {
        const row = claimedSchema.parse(raw); const video = videoSchema.parse(JSON.parse(row.video));
        this.log({ time: row.time ?? Date.now(), topicId: row.topicId, topic: row.config === null ? '系统' : topicNameSchema.parse(JSON.parse(row.config)).name, keyword: row.keyword, bvid: row.bvid, title: video.title, author: video.author, action: 'error', content: row.content, target: row.target, result: '发送结果不确定', error: '服务在发送结果确认前停止；不会重试此视频' });
      }
      const newClaims=this.db.prepare("SELECT p.id,p.cycle_count,p.state,a.id AS attempt_id,a.started_at FROM interaction_plans p JOIN interaction_attempts a ON a.plan_id=p.id WHERE p.state='claimed' AND a.status='started'").all();
      const recoveryRow=z.object({id:z.number(),cycle_count:z.number(),state:z.string(),attempt_id:z.number(),started_at:z.number()});
      for (const raw of newClaims) {
        const row=recoveryRow.parse(raw);
        this.db.prepare("UPDATE interaction_attempts SET status='uncertain',finished_at=NULL,request_uncertain=1,request_in_flight=1,error_code='process_stopped_before_result' WHERE id=? AND status='started'").run(row.attempt_id);
        this.db.prepare("UPDATE interaction_plans SET state='uncertain',version=version+1 WHERE id=? AND state='claimed'").run(row.id);
        this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'restart_recovery',?,?,'claimed','uncertain','服务在请求结果确认前停止；禁止自动重试','process_stopped_before_result')").run(row.id,row.started_at,row.cycle_count);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const settings = this.settings();
    settings.running = false; settings.pauseReason = STARTUP_PAUSE; settings.account = { loggedIn: false, message: '登录状态待检查' };
    this.saveSettings(settings);
    this.recoverRepeatedTemplatePlans();
    } catch (error) {
      try { this.db.close(); } catch { /* Initialization may have failed before SQLite opened fully. */ }
      this.releaseLock?.(); this.releaseLock=undefined;
      throw error;
    }
  }
  /** One-time recovery of valid snapshots blocked only by the removed last-content rule. */
  private recoverRepeatedTemplatePlans() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) {
        this.db.exec('COMMIT'); return;
      }
      const candidates=this.db.prepare(`SELECT p.* FROM interaction_plans p
        JOIN account_binding b ON b.id=1 AND b.verified=1 AND b.uid=p.owner_uid
        JOIN topics t ON t.id=p.topic_id
        JOIN interaction_events e ON e.id=(SELECT max(e2.id) FROM interaction_events e2 WHERE e2.plan_id=p.id AND e2.event_type='template_wait')
        WHERE (p.state='waiting_template' OR (p.state='paused_channel' AND p.resume_state='waiting_template'))
          AND p.orphaned=0 AND p.cancel_requested=0 AND e.reason='没有可用且不重复的模板'
          AND NOT EXISTS(SELECT 1 FROM interaction_attempts a WHERE a.plan_id=p.id
            AND (a.status IN ('started','uncertain','manual_review','succeeded') OR a.request_in_flight=1 OR a.request_uncertain=1))
        ORDER BY p.id`).all();
      const validSnapshots=z.array(z.string().trim().min(1).max(300)).min(1).max(100);
      const now=Date.now();
      for (const raw of candidates) {
        const plan=planRowSchema.parse(raw);
        // Malformed or genuinely missing snapshots still require manual template repair.
        let snapshotsValid=false;
        try {
          snapshotsValid=validSnapshots.safeParse(JSON.parse(plan.comment_templates)).success
            && validSnapshots.safeParse(JSON.parse(plan.reply_templates)).success;
        } catch { /* Invalid JSON is not evidence that this plan can be sent. */ }
        if (!snapshotsValid) continue;
        const paused=plan.state==='paused_channel';
        const nextState=paused?'paused_channel':'scheduled';
        const updated=this.db.prepare('UPDATE interaction_plans SET state=?,resume_state=?,version=version+1 WHERE id=? AND version=?')
          .run(nextState,paused?'scheduled':null,plan.id,plan.version);
        if (updated.changes!==1) throw new Error('模板重复规则迁移发生计划版本冲突');
        this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'template_repeat_recovered',?,?,?,?,?,'')")
          .run(plan.id,now,plan.cycle_count,plan.state,nextState,paused?'取消模板文字防重复；频道继续暂停，待恢复状态改为待执行':'取消模板文字防重复；恢复待执行，保留原日期、模板快照和读取冷却');
      }
      this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)').run(now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private migrateInteractionTables() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      const applied = countRow.parse(this.db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=1').get()).n;
      if (!applied) {
        const legacy = this.db.prepare(`SELECT i.id,i.bvid,i.topic_id,i.action,i.state,i.due,i.attempted,i.content,i.target,i.receipt,
          d.aid,d.video,d.keyword,d.time AS discovered_at,t.config FROM interactions i
          JOIN discoveries d USING(bvid) LEFT JOIN topics t ON t.id=i.topic_id ORDER BY i.id`).all();
        const insertPlan = this.db.prepare(`INSERT OR IGNORE INTO interaction_plans(
          bvid,aid,topic_id,owner_uid,topic_name,keyword,matched_field,video,planned_action,comment_templates,reply_templates,snapshot_source,
          first_enqueued_at,cycle_start_day,cycle_deadline_day,due_at,overflow,cycle_count,failure_count,state,version,next_prepare_at,read_day,read_count,channel_disabled,orphaned,cancel_requested
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const insertAttempt = this.db.prepare(`INSERT OR IGNORE INTO interaction_attempts(
          plan_id,attempt_no,operation_id,quota_day,dispatch_class,billing_topic_id,billing_topic_name,sender_uid,started_at,finished_at,
          effective_action,fallback_reason,content,target,target_uid,status,failure_stage,error_code,receipt,request_uncertain
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const event = this.db.prepare('INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,?,?,?,?,?,?,?)');
        for (const raw of legacy) {
          const row = z.object({ id: z.number(), bvid: z.string(), topic_id: z.number().nullable(), action: z.string(), state: z.string(), due: z.number(), attempted: z.number().nullable(), content: z.string(), target: z.string(), receipt: z.string(), aid: z.number(), video: z.string(), keyword: z.string(), discovered_at: z.number(), config: z.string().nullable() }).parse(raw);
          // Legacy skipped rows remain discovery-only records; never convert them to sendable plans.
          if (row.state === 'skipped') continue;
          const action = interactionActionSchema.safeParse(row.action);
          if (!action.success) continue;
          const planState: InteractionState = row.state === 'succeeded' ? 'succeeded' : ['claimed','uncertain'].includes(row.state) ? 'uncertain' : 'manual_review';
          const topicConfig = row.config === null ? null : z.record(z.unknown()).safeParse(JSON.parse(row.config));
          const topicName = topicConfig?.success && typeof topicConfig.data.name === 'string' ? topicConfig.data.name : '已删除频道';
          const comments: string[] = []; const replies: string[] = [];
          if (row.topic_id !== null) {
            const templates = this.db.prepare('SELECT kind,text FROM templates WHERE topic_id=? AND enabled=1 ORDER BY id').all(row.topic_id);
            for (const item of templates) {
              const parsed = z.object({ kind: z.enum(['comment','reply']), text: z.string() }).safeParse(item);
              if (parsed.success) (parsed.data.kind === 'comment' ? comments : replies).push(parsed.data.text);
            }
          }
          const first = row.attempted ?? row.discovered_at;
          const startDay = dayStart(first);
          const planResult = insertPlan.run(row.bvid,row.aid,row.topic_id,'unknown',topicName,row.keyword,'',row.video,action.data,JSON.stringify(comments),JSON.stringify(replies),'legacy_snapshot',first,startDay,startDay+30*86400000,row.due,0,0,row.state==='failed'?1:0,planState,0,null,null,0,0,row.topic_id===null?1:0,0);
          const planId = planResult.changes ? Number(planResult.lastInsertRowid) : z.object({ id: z.number() }).parse(this.db.prepare('SELECT id FROM interaction_plans WHERE bvid=?').get(row.bvid)).id;
          event.run(planId,'legacy_migration',first,0,row.state,planState,'旧 interactions 队列迁移；账号、模板原始快照及发送确定性未知','legacy_unknown');
          if (row.attempted !== null) {
            const status: AttemptStatus = row.state === 'succeeded' ? 'succeeded' : row.state === 'failed' ? 'manual_review' : 'uncertain';
            const operationId = `legacy:${row.id}`;
            insertAttempt.run(planId,1,operationId,dayStart(row.attempted),'legacy_unknown',row.topic_id,topicName,'unknown',row.attempted,row.state==='succeeded'?row.attempted:null,action.data,'',row.content,row.target,'',status,'unknown',row.state==='failed'?'legacy_failed_unknown_send_result':'legacy_send_result_unknown',row.receipt,['claimed','uncertain'].includes(row.state)?1:0);
          }
        }
        this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(Date.now());
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  accountBinding(): { uid: string; boundAt: number; verified: boolean } | undefined {
    const raw = this.db.prepare('SELECT uid,bound_at,verified FROM account_binding WHERE id=1').get();
    if (!raw) return undefined;
    const row = accountBindingRowSchema.parse(raw);
    return { uid: row.uid, boundAt: row.bound_at, verified: row.verified === 1 };
  }
  /** Bind the database to a verified account. Legacy ownership must be explicitly confirmed. */
  bindAccount(uid: string, verified: boolean, confirmLegacyOwnership = false, now = Date.now()): { ok: boolean; reason: string; binding?: { uid: string; boundAt: number; verified: boolean } } {
    const normalizedUid = z.string().trim().min(1).parse(uid);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.accountBinding();
      if (current && current.uid !== normalizedUid) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: '数据库已绑定其他 UID；更换账号需使用独立数据目录' };
      }
      if (!current) {
        const unknownLegacy = countRow.parse(this.db.prepare("SELECT count(*) AS n FROM interaction_plans WHERE owner_uid='unknown' AND snapshot_source='legacy_snapshot'").get()).n;
        if (unknownLegacy > 0 && !confirmLegacyOwnership) {
          this.db.exec('ROLLBACK');
          return { ok: false, reason: '存在账号归属未知的旧任务，需要人工确认其账号归属' };
        }
        this.db.prepare('INSERT INTO account_binding(id,uid,bound_at,verified) VALUES(1,?,?,?)').run(normalizedUid,now,Number(verified));
      } else this.db.prepare('UPDATE account_binding SET verified=? WHERE id=1 AND uid=?').run(Number(verified),normalizedUid);
      this.db.exec('COMMIT');
      return { ok: true, reason: '', binding: this.accountBinding() };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  adoptLegacyPlan(planId:number,expectedVersion:number,ownerUid:string,now=Date.now()) {
    const uid=z.string().trim().min(1).parse(ownerUid);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const plan=this.interactionPlan(planId);const binding=this.accountBinding();
      if(!plan||plan.version!==expectedVersion||plan.snapshotSource!=='legacy_snapshot'||plan.ownerUid!=='unknown'||plan.state!=='manual_review'||this.latestInteractionAttempt(planId))throw new Error('计划已变化或不符合旧任务确认条件');
      if(!binding?.verified||binding.uid!==uid)throw new Error('当前账号尚未确认或与本机绑定不一致');
      if(!plan.commentTemplates.length||!plan.replyTemplates.length)throw new Error('旧计划缺少模板快照，需先人工补齐模板');
      const topic=plan.topicId===null?undefined:this.topic(plan.topicId);if(!topic)throw new Error('旧计划所属频道已删除，不能自动恢复');
      const state:InteractionState=topic.enabled?'scheduled':'paused_channel';
      this.db.prepare('UPDATE interaction_plans SET owner_uid=?,state=?,channel_disabled=?,version=version+1 WHERE id=? AND version=?').run(uid,state,Number(!topic.enabled),planId,expectedVersion);
      this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'legacy_adopted',?,?, 'manual_review',?,?, 'explicit_owner_confirmation')").run(planId,now,plan.cycleCount,state,'用户核对旧排队记录并确认其后续执行账号');
      this.db.exec('COMMIT');return this.interactionPlan(planId)!;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private mapPlan(raw: unknown): InteractionPlan {
    const r = planRowSchema.parse(raw);
    return {
      id:r.id,bvid:r.bvid,aid:r.aid ?? undefined,topicId:r.topic_id,ownerUid:r.owner_uid,topicName:r.topic_name,keyword:r.keyword,matchedField:r.matched_field,video:r.video,
      plannedAction:interactionActionSchema.parse(r.planned_action),commentTemplates:z.array(z.string()).parse(JSON.parse(r.comment_templates)),replyTemplates:z.array(z.string()).parse(JSON.parse(r.reply_templates)),snapshotSource:z.enum(['native','legacy_snapshot']).parse(r.snapshot_source),
      firstEnqueuedAt:r.first_enqueued_at,cycleStartDay:r.cycle_start_day,cycleDeadlineDay:r.cycle_deadline_day,dueAt:r.due_at,overflow:r.overflow===1,cycleCount:r.cycle_count,failureCount:r.failure_count,
      deferred:r.deferred===1,state:interactionStateSchema.parse(r.state),version:r.version,nextPrepareAt:r.next_prepare_at,readDay:r.read_day,readCount:r.read_count,channelDisabled:r.channel_disabled===1,orphaned:r.orphaned===1,cancelRequested:r.cancel_requested===1,resumeState:r.resume_state===null?null:interactionStateSchema.parse(r.resume_state),
    };
  }
  private mapAttempt(raw: unknown): InteractionAttempt {
    const r = attemptRowSchema.parse(raw);
    return { id:r.id,planId:r.plan_id,attemptNo:r.attempt_no,operationId:r.operation_id,quotaDay:r.quota_day,dispatchClass:dispatchClassSchema.parse(r.dispatch_class),billingTopicId:r.billing_topic_id,billingTopicName:r.billing_topic_name,senderUid:r.sender_uid,startedAt:r.started_at,finishedAt:r.finished_at,effectiveAction:interactionActionSchema.parse(r.effective_action),fallbackReason:r.fallback_reason,content:r.content,target:r.target,targetId:r.target_id,targetUid:r.target_uid,status:attemptStatusSchema.parse(r.status),failureStage:failureStageSchema.parse(r.failure_stage),errorCode:r.error_code,receipt:r.receipt,requestUncertain:r.request_uncertain===1,requestInFlight:r.request_in_flight===1 };
  }
  interactionPlan(id: number): InteractionPlan | undefined {
    const row=this.db.prepare('SELECT * FROM interaction_plans WHERE id=?').get(id); return row ? this.mapPlan(row) : undefined;
  }
  interactionPlanForVideo(bvid: string): InteractionPlan | undefined {
    const row=this.db.prepare('SELECT * FROM interaction_plans WHERE bvid=?').get(bvid); return row ? this.mapPlan(row) : undefined;
  }
  interactionPlans(options: { state?: InteractionState; limit?: number; offset?: number } = {}): InteractionPlan[] {
    const state=options.state ? interactionStateSchema.parse(options.state) : null;
    const limit=z.number().int().min(1).max(500).default(100).parse(options.limit);
    const offset=z.number().int().nonnegative().default(0).parse(options.offset);
    return this.db.prepare('SELECT * FROM interaction_plans WHERE (? IS NULL OR state=?) ORDER BY due_at,id LIMIT ? OFFSET ?').all(state,state,limit,offset).map(row=>this.mapPlan(row));
  }
  interactionPlanCount(state?:InteractionState) {
    const value=state?interactionStateSchema.parse(state):null;
    return countRow.parse(this.db.prepare('SELECT count(*) AS n FROM interaction_plans WHERE (? IS NULL OR state=?)').get(value,value)).n;
  }
  queueSummary(now=Date.now()): QueueSummary {
    const today=dayStart(now);
    const row=this.db.prepare(`SELECT
      coalesce(sum(CASE WHEN state IN ('scheduled','waiting_template','paused_channel') THEN 1 ELSE 0 END),0) AS pending,
      coalesce(sum(CASE WHEN state='scheduled' AND due_at<=? THEN 1 ELSE 0 END),0) AS due,
      min(CASE WHEN state='scheduled' THEN due_at END) AS next_due_at,
      coalesce(sum(CASE WHEN state='scheduled' THEN 1 ELSE 0 END),0) AS scheduled,
      coalesce(sum(CASE WHEN state='waiting_template' THEN 1 ELSE 0 END),0) AS waiting_template,
      coalesce(sum(CASE WHEN state='paused_channel' THEN 1 ELSE 0 END),0) AS paused_channel,
      coalesce(sum(CASE WHEN state='claimed' THEN 1 ELSE 0 END),0) AS claimed,
      coalesce(sum(CASE WHEN state='uncertain' THEN 1 ELSE 0 END),0) AS uncertain,
      coalesce(sum(CASE WHEN state='manual_review' THEN 1 ELSE 0 END),0) AS manual_review,
      coalesce(sum(CASE WHEN state='scheduled' AND (cycle_deadline_day<? OR (overflow=1 AND cycle_deadline_day<=?)) THEN 1 ELSE 0 END),0) AS overdue,
      min(CASE WHEN state='scheduled' AND (cycle_deadline_day<? OR (overflow=1 AND cycle_deadline_day<=?)) THEN cycle_deadline_day END) AS earliest_overdue_at
      FROM interaction_plans`).get(now,today,today,today,today);
    const parsed=z.object({
      pending:z.number(),due:z.number(),next_due_at:z.number().nullable(),scheduled:z.number(),waiting_template:z.number(),paused_channel:z.number(),claimed:z.number(),uncertain:z.number(),manual_review:z.number(),overdue:z.number(),earliest_overdue_at:z.number().nullable(),
    }).parse(row);
    return queueSummarySchema.parse({pending:parsed.pending,due:parsed.due,nextDueAt:parsed.next_due_at,scheduled:parsed.scheduled,waitingTemplate:parsed.waiting_template,pausedChannel:parsed.paused_channel,claimed:parsed.claimed,uncertain:parsed.uncertain,manualReview:parsed.manual_review,overdue:parsed.overdue,earliestOverdueAt:parsed.earliest_overdue_at});
  }
  /** A single synchronous, read-only projection; never prepares, claims or reschedules work. */
  runtimeFacts(now:number):RuntimeFacts {
    const settings=this.settings();const today=dayStart(now);const tomorrow=today+86400000;
    const words=new Map<number,string[]>();
    for(const raw of this.db.prepare('SELECT topic_id,keyword FROM keywords ORDER BY rowid').all()){
      const r=z.object({topic_id:z.number(),keyword:z.string()}).parse(raw);words.set(r.topic_id,[...(words.get(r.topic_id)??[]),r.keyword]);
    }
    const topics:RuntimeTopic[]=this.db.prepare('SELECT id,config,next_search FROM topics ORDER BY id').all().map(raw=>{
      const r=z.object({id:z.number(),config:z.string(),next_search:z.number()}).parse(raw);
      const config=topicSchema.parse({...JSON.parse(r.config),keywords:words.get(r.id)??[]});
      return {...config,id:r.id,nextSearch:r.next_search};
    });
    const usage:RuntimeFacts['usage']={total:0,comment:0,reply:0,overdue:0,topic:{},readCount:0,searches:0,topicSearches:{}};
    const rows=this.db.prepare(`SELECT billing_topic_id AS topic_id,effective_action AS action,dispatch_class AS class,count(*) AS n FROM interaction_attempts WHERE quota_day=? GROUP BY billing_topic_id,effective_action,dispatch_class
      UNION ALL SELECT i.topic_id,i.action,'ordinary',count(*) FROM interactions i WHERE i.attempted>=? AND i.attempted<? AND NOT EXISTS(SELECT 1 FROM interaction_plans p WHERE p.bvid=i.bvid) GROUP BY i.topic_id,i.action`).all(today,today,tomorrow);
    for(const raw of rows){
      const r=z.object({topic_id:z.number().nullable(),action:interactionActionSchema,class:z.string(),n:z.number()}).parse(raw);
      usage.total+=r.n;usage[r.action]+=r.n;if(['overdue','legacy_unknown'].includes(r.class))usage.overdue+=r.n;
      if(r.topic_id!==null){usage.topic[r.topic_id]??={comment:0,reply:0};usage.topic[r.topic_id][r.action]+=r.n;}
    }
    usage.readCount=countRow.parse(this.db.prepare('SELECT coalesce(sum(read_count),0) n FROM interaction_plans WHERE read_day=?').get(today)).n;
    for(const raw of this.db.prepare("SELECT topic_id,count(*) n FROM activity WHERE action='search' AND time>=? GROUP BY topic_id").all(today)){
      const r=z.object({topic_id:z.number().nullable(),n:z.number()}).parse(raw);usage.searches+=r.n;if(r.topic_id!==null)usage.topicSearches[r.topic_id]=r.n;
    }
    const success={comment:0,reply:0};
    for(const raw of this.db.prepare(`SELECT effective_action AS action,count(*) n FROM interaction_attempts WHERE started_at>=? AND started_at<? AND status='succeeded' GROUP BY effective_action
      UNION ALL SELECT i.action,count(*) n FROM interactions i WHERE i.attempted>=? AND i.attempted<? AND i.state='succeeded' AND NOT EXISTS(SELECT 1 FROM interaction_plans p WHERE p.bvid=i.bvid) GROUP BY i.action`).all(today,tomorrow,today,tomorrow)){
      const r=z.object({action:interactionActionSchema,n:z.number()}).parse(raw);success[r.action]+=r.n;
    }
    const due=this.dueInteractionPlans(now,101);
    const future=this.db.prepare("SELECT * FROM interaction_plans WHERE state='scheduled' AND due_at>? ORDER BY due_at,id LIMIT 3").all(now).map(r=>this.mapPlan(r));
    const review=this.db.prepare(`SELECT p.*,a.status AS latest_status,a.request_in_flight AS latest_in_flight FROM interaction_plans p LEFT JOIN interaction_attempts a ON a.id=(SELECT a2.id FROM interaction_attempts a2 WHERE a2.plan_id=p.id ORDER BY a2.attempt_no DESC LIMIT 1)
      WHERE p.state IN ('uncertain','manual_review','waiting_template') ORDER BY CASE p.state WHEN 'uncertain' THEN 0 WHEN 'manual_review' THEN 1 ELSE 2 END,p.id LIMIT 8`).all().map(raw=>{
        const r=z.object({latest_status:z.string().nullable(),latest_in_flight:z.number().nullable()}).parse(raw);
        return {plan:this.mapPlan(raw),requestInFlight:r.latest_in_flight===1,canResolve:['uncertain','manual_review'].includes(r.latest_status??'')&&r.latest_in_flight===0};
      });
    const poll=this.db.prepare("SELECT min(coalesce(p.next_prepare_at,?)) AS at FROM interaction_plans p JOIN interaction_attempts a ON a.plan_id=p.id WHERE p.state='uncertain' AND a.request_in_flight=1").get(now);
    return {now,settings,topics,queue:this.queueSummary(now),binding:this.accountBinding(),due,future,inFlightCount:countRow.parse(this.db.prepare('SELECT count(*) n FROM interaction_attempts WHERE request_in_flight=1').get()).n,pollAt:z.object({at:z.number().nullable()}).parse(poll).at,review,usage,success};
  }
  legacyOwnershipPending() {
    return countRow.parse(this.db.prepare("SELECT count(*) AS n FROM interaction_plans WHERE owner_uid='unknown' AND snapshot_source='legacy_snapshot'").get()).n>0;
  }
  dueInteractionPlans(now: number, limit = 100): InteractionPlan[] {
    const size=z.number().int().min(1).max(500).parse(limit);
    return this.db.prepare("SELECT * FROM interaction_plans WHERE state='scheduled' AND due_at<=? ORDER BY CASE WHEN overflow=1 AND due_at=cycle_deadline_day AND ?<=cycle_deadline_day THEN 0 WHEN ?>cycle_deadline_day THEN 0 ELSE 1 END,cycle_deadline_day,due_at,id LIMIT ?").all(now,dayStart(now),dayStart(now),size).map(row=>this.mapPlan(row));
  }
  uncertainInteractionPlans(limit = 50): InteractionPlan[] {
    return this.db.prepare("SELECT * FROM interaction_plans WHERE state='uncertain' ORDER BY id LIMIT ?").all(z.number().int().min(1).max(500).parse(limit)).map(row=>this.mapPlan(row));
  }
  dueUncertainInteractionPlans(now:number,limit=20):InteractionPlan[]{
    return this.db.prepare("SELECT p.* FROM interaction_plans p JOIN interaction_attempts a ON a.plan_id=p.id AND a.attempt_no=(SELECT max(a2.attempt_no) FROM interaction_attempts a2 WHERE a2.plan_id=p.id) WHERE p.state='uncertain' AND a.status='uncertain' AND a.request_in_flight=1 AND (p.next_prepare_at IS NULL OR p.next_prepare_at<=?) ORDER BY p.id LIMIT ?").all(now,z.number().int().min(1).max(100).parse(limit)).map(row=>this.mapPlan(row));
  }
  deferUncertainPoll(planId:number,now:number,delayMs=60000){
    this.db.prepare("UPDATE interaction_plans SET next_prepare_at=? WHERE id=? AND state='uncertain'").run(now+delayMs,planId);
  }
  markRequestInFlight(attemptId:number,inFlight:boolean,now=Date.now(),reason='桥接操作状态查询') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const raw=this.db.prepare('SELECT * FROM interaction_attempts WHERE id=?').get(attemptId);
      if(!raw){this.db.exec('ROLLBACK');return false;}
      const attempt=this.mapAttempt(raw);
      if(attempt.status!=='uncertain'){this.db.exec('ROLLBACK');return false;}
      if(attempt.requestInFlight===inFlight){this.db.exec('COMMIT');return true;}
      this.db.prepare('UPDATE interaction_attempts SET request_in_flight=? WHERE id=? AND status=\'uncertain\'').run(Number(inFlight),attemptId);
      this.db.prepare('INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,\'request_state\',?,? ,\'uncertain\',\'uncertain\',?,?)').run(attempt.planId,now,this.interactionPlan(attempt.planId)?.cycleCount??0,reason,inFlight?'bridge_request_running':'bridge_request_ended');
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  anyRequestInFlight() {
    return countRow.parse(this.db.prepare('SELECT count(*) AS n FROM interaction_attempts WHERE request_in_flight=1').get()).n>0;
  }
  latestInteractionAttempt(planId: number): InteractionAttempt | undefined {
    const row=this.db.prepare('SELECT * FROM interaction_attempts WHERE plan_id=? ORDER BY attempt_no DESC LIMIT 1').get(planId);
    return row ? this.mapAttempt(row) : undefined;
  }
  interactionAttempts(planId: number): InteractionAttempt[] {
    return this.db.prepare('SELECT * FROM interaction_attempts WHERE plan_id=? ORDER BY attempt_no').all(planId).map(row=>this.mapAttempt(row));
  }
  interactionEvents(planId: number) {
    return this.db.prepare('SELECT * FROM interaction_events WHERE plan_id=? ORDER BY at,id').all(planId).map(raw=>{
      const r=eventRowSchema.parse(raw); return { id:r.id,planId:r.plan_id,eventType:r.event_type,at:r.at,cycle:r.cycle,fromState:r.from_state,toState:r.to_state,reason:r.reason,errorCode:r.error_code };
    });
  }
  cancelInteractionPlan(planId:number,expectedVersion:number,now=Date.now(),reason='用户取消') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const plan=this.interactionPlan(planId);
      if(!plan||plan.version!==expectedVersion||plan.state==='succeeded'||plan.state==='cancelled'){this.db.exec('ROLLBACK');return false;}
      const inFlight=['claimed','uncertain'].includes(plan.state);
      const state=inFlight?plan.state:'cancelled';
      this.db.prepare('UPDATE interaction_plans SET state=?,cancel_requested=1,version=version+1 WHERE id=? AND version=?').run(state,planId,expectedVersion);
      this.db.prepare('INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,?,?,?,?,?,?,?)').run(planId,'cancel',now,plan.cycleCount,plan.state,state,reason,inFlight?'request_may_be_in_flight':'');
      this.db.exec('COMMIT');return true;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  resolveUncertainAttempt(attemptId:number,action:'succeeded'|'not_sent',now:number,evidence:string) {
    const raw=this.db.prepare('SELECT * FROM interaction_attempts WHERE id=?').get(attemptId);
    if(!raw)throw new Error('发送尝试不存在');
    const attempt=this.mapAttempt(raw);
    if(!['uncertain','manual_review'].includes(attempt.status))throw new Error('此尝试不是待人工核查状态');
    if(action==='not_sent'&&attempt.requestInFlight)throw new Error('桥接仍报告原请求在途；不能安排重试');
    const plan=this.interactionPlan(attempt.planId);if(!plan)throw new Error('互动计划不存在');
    const allocation=action==='not_sent'?this.rescheduleFailedPlan(plan,now):undefined;
    return this.finishInteractionAttempt({attemptId,outcome:action==='succeeded'?'succeeded':'confirmed_failure',finishedAt:now,evidence:action==='not_sent'?`人工确认未发送：${evidence}`:`人工确认已发送：${evidence}`,retryAt:allocation?.dueAt,retryOverflow:allocation?.overflow??false,errorCode:action==='succeeded'?'manual_confirmed_sent':'manual_confirmed_not_sent',failureStage:'recovery'});
  }
  recordLateReceipt(attemptId:number,receipt:string,now=Date.now(),evidence='迟到的可信成功回执') {
    const raw=this.db.prepare('SELECT * FROM interaction_attempts WHERE id=?').get(attemptId);
    if(!raw)throw new Error('发送尝试不存在');
    const attempt=this.mapAttempt(raw);
    if(attempt.status==='succeeded')return attempt;
    if(!['uncertain','manual_review','started'].includes(attempt.status))throw new Error('此尝试已归档，不能追加回执');
    return this.finishInteractionAttempt({attemptId,outcome:'succeeded',finishedAt:now,receipt,failureStage:'receipt',errorCode:'late_receipt',evidence});
  }
  updatePlanTemplates(planId:number,expectedVersion:number,commentTemplates:string[],replyTemplates:string[],now=Date.now()) {
    const comments=z.array(z.string().trim().min(1).max(300)).min(1).max(100).parse(commentTemplates);
    const replies=z.array(z.string().trim().min(1).max(300)).min(1).max(100).parse(replyTemplates);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const plan=this.interactionPlan(planId);
      if(!plan||plan.version!==expectedVersion||plan.orphaned||!['scheduled','waiting_template','paused_channel','manual_review'].includes(plan.state))throw new Error('计划已变化或当前状态不允许修改模板');
      const nextState:InteractionState=plan.state==='waiting_template'?'scheduled':plan.state;
      this.db.prepare('UPDATE interaction_plans SET comment_templates=?,reply_templates=?,state=?,version=version+1 WHERE id=? AND version=?').run(JSON.stringify([...new Set(comments)]),JSON.stringify([...new Set(replies)]),nextState,planId,expectedVersion);
      this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'templates_updated',?,?,?,?,?,'')").run(planId,now,plan.cycleCount,plan.state,nextState,'用户更新本计划模板快照');
      this.db.exec('COMMIT');return this.interactionPlan(planId)!;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Atomic BV/AV dedup + discovery + plan + event insertion. */
  createInteractionPlan(input: z.input<typeof createPlanInputSchema>): InteractionPlan | undefined {
    const data=createPlanInputSchema.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const binding=this.accountBinding();
      if (!binding || !binding.verified || binding.uid!==data.ownerUid) throw new Error('账号 UID 未验证或与数据库绑定不一致');
      const topic=this.db.prepare('SELECT config FROM topics WHERE id=?').get(data.topicId);
      if (!topic) throw new Error('频道不存在');
      const config=z.record(z.unknown()).parse(JSON.parse(z.object({config:z.string()}).parse(topic).config));
      if (config.enabled!==true) throw new Error('频道已停用，不能创建互动计划');
      if (!data.commentTemplates.length || !data.replyTemplates.length) throw new Error('评论和回复模板都必须至少有一个');
      const duplicate=this.db.prepare('SELECT bvid FROM discoveries WHERE bvid=? OR aid=?').get(data.video.bvid,data.video.aid);
      if (duplicate) { this.db.exec('ROLLBACK'); return undefined; }
      const start=dayStart(data.createdAt); const deadline=start+30*86400000;
      const allocation=this.allocateCapacityDay(data.topicId,data.plannedAction,start,data.deferred?start+86400000:start,deadline);
      const due=allocation.dueAt===start?Math.max(allocation.dueAt,data.dueAt):allocation.dueAt;
      this.db.prepare('INSERT INTO discoveries(bvid,aid,topic_id,video,keyword,time) VALUES(?,?,?,?,?,?)').run(data.video.bvid,data.video.aid,data.topicId,JSON.stringify(data.video),data.keyword,data.createdAt);
      const result=this.db.prepare(`INSERT INTO interaction_plans(bvid,aid,topic_id,owner_uid,topic_name,keyword,matched_field,video,planned_action,comment_templates,reply_templates,snapshot_source,first_enqueued_at,cycle_start_day,cycle_deadline_day,due_at,deferred,overflow,cycle_count,failure_count,state,version,next_prepare_at,read_day,read_count,channel_disabled,orphaned,cancel_requested)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'scheduled',0,NULL,NULL,0,0,0,0)`).run(data.video.bvid,data.video.aid,data.topicId,data.ownerUid,data.topicName,data.keyword,data.matchedField,JSON.stringify(data.video),data.plannedAction,JSON.stringify(data.commentTemplates),JSON.stringify(data.replyTemplates),'native',data.createdAt,start,deadline,due,Number(data.deferred),Number(allocation.overflow));
      const id=Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'created',?,0,'','scheduled',?,'')").run(id,data.createdAt,allocation.overflow?'计划与模板快照已保存；30日容量不足，安排至截止日并标记溢出':'分流计划、模板快照与预留容量已原子保存');
      this.db.exec('COMMIT');
      return this.interactionPlan(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Claim and create its immutable accounting row in one transaction before any network write. */
  claimInteractionPlan(input: z.input<typeof claimPlanInputSchema>): InteractionAttempt | undefined {
    const data=claimPlanInputSchema.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const plan=this.interactionPlan(data.planId);
      const binding=this.accountBinding();
      if (!plan || plan.state!=='scheduled' || plan.version!==data.expectedVersion || plan.dueAt>data.now || plan.orphaned || plan.cancelRequested || plan.channelDisabled) { this.db.exec('ROLLBACK'); return undefined; }
      if (!binding || !binding.verified || binding.uid!==data.senderUid || plan.ownerUid!==data.senderUid) throw new Error('发送账号 UID 与计划绑定不一致');
      const currentSettings=this.settings();
      if (data.quotaDay!==dayStart(data.now) || JSON.stringify(data.limits)!==JSON.stringify(currentSettings.limits) || data.now<currentSettings.nextInteraction) throw new Error('发送额度或互动间隔发生变化，请重新读取最新状态');
      const topic=plan.topicId===null?undefined:this.topic(plan.topicId);
      if (!topic?.enabled || plan.state!=='scheduled') { this.db.exec('ROLLBACK'); return undefined; }
      const overdue=dayStart(data.now)>plan.cycleDeadlineDay||(plan.overflow&&dayStart(data.now)>=plan.cycleDeadlineDay);
      if ((data.dispatchClass==='overdue')!==overdue) { this.db.exec('ROLLBACK'); return undefined; }
      const total=this.attemptCount(data.now); const actionCount=this.attemptCount(data.now,undefined,data.effectiveAction); const topicActionCount=this.attemptCount(data.now,plan.topicId ?? undefined,data.effectiveAction);
      const actionLimit=data.effectiveAction==='comment'?data.limits.dailyComment:data.limits.dailyReply;
      const topicActionLimit=data.effectiveAction==='comment'?topic.dailyComment:topic.dailyReply;
      if (total>=data.limits.dailyTotal || actionCount>=actionLimit || topicActionCount>=topicActionLimit) { this.db.exec('ROLLBACK'); return undefined; }
      if (data.dispatchClass==='overdue') {
        const used=countRow.parse(this.db.prepare("SELECT count(*) AS n FROM interaction_attempts WHERE quota_day=? AND dispatch_class IN ('overdue','legacy_unknown')").get(data.quotaDay)).n;
        const dayIndex=Math.floor((data.quotaDay+8*3600000)/86400000);
        const overdueLimit=Math.floor(data.limits.dailyTotal/2)+(data.limits.dailyTotal%2 && dayIndex%2===0 ? 1 : 0);
        if (used>=overdueLimit) { this.db.exec('ROLLBACK'); return undefined; }
      }
      const inFlight=countRow.parse(this.db.prepare("SELECT count(*) AS n FROM interaction_attempts WHERE plan_id=? AND status IN ('started','uncertain')").get(data.planId)).n;
      if (inFlight) { this.db.exec('ROLLBACK'); return undefined; }
      const attemptNo=countRow.parse(this.db.prepare('SELECT coalesce(max(attempt_no),0)+1 AS n FROM interaction_attempts WHERE plan_id=?').get(data.planId)).n;
      const operationId=randomUUID();
      const inserted=this.db.prepare(`INSERT INTO interaction_attempts(plan_id,attempt_no,operation_id,quota_day,dispatch_class,billing_topic_id,billing_topic_name,sender_uid,started_at,effective_action,fallback_reason,content,target,target_id,target_uid,status,failure_stage,error_code,receipt,request_uncertain,request_in_flight)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'started','send','', '',0,1)`).run(data.planId,attemptNo,operationId,data.quotaDay,data.dispatchClass,data.billingTopicId,data.billingTopicName,data.senderUid,data.now,data.effectiveAction,data.fallbackReason,data.content,data.target,data.targetId,data.targetUid);
      const updated=this.db.prepare("UPDATE interaction_plans SET state='claimed',version=version+1 WHERE id=? AND version=? AND state='scheduled'").run(data.planId,data.expectedVersion);
      if (!updated.changes) throw new Error('计划版本冲突，未创建发送尝试');
      this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'claim',?,?,'scheduled','claimed','发送前持久化 claim 与计费快照','')").run(data.planId,data.now,plan.cycleCount);
      this.db.prepare("UPDATE app_settings SET data=json_set(data,'$.nextInteraction',?,'$.lastContent',?) WHERE id=1").run(data.nextInteractionAt,data.content);
      const attempt=this.db.prepare('SELECT * FROM interaction_attempts WHERE id=?').get(Number(inserted.lastInsertRowid));
      this.db.exec('COMMIT'); return attempt ? this.mapAttempt(attempt) : undefined;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Archive a send result without changing its immutable quota, action, account, or channel facts. */
  finishInteractionAttempt(input: z.input<typeof finishAttemptInputSchema>): InteractionAttempt {
    const data=finishAttemptInputSchema.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const raw=this.db.prepare('SELECT * FROM interaction_attempts WHERE id=?').get(data.attemptId);
      if (!raw) throw new Error('发送尝试不存在');
      const attempt=this.mapAttempt(raw);
      const plan=this.interactionPlan(attempt.planId);
      if (!plan) throw new Error('互动计划不存在');
      if (attempt.status==='succeeded') { this.db.exec('COMMIT'); return attempt; }
      if (!['started','uncertain','manual_review'].includes(attempt.status)) throw new Error('此发送尝试已归档，不能覆盖结果');
      const status: AttemptStatus=data.outcome==='succeeded'?'succeeded':data.outcome==='confirmed_failure'?'failed':data.outcome==='uncertain'?'uncertain':'manual_review';
      const nextState: InteractionState=data.outcome==='succeeded'?'succeeded':data.outcome==='confirmed_failure'?'scheduled':data.outcome==='uncertain'?'uncertain':'manual_review';
      this.db.prepare('UPDATE interaction_attempts SET status=?,finished_at=?,receipt=?,failure_stage=?,error_code=?,request_uncertain=?,request_in_flight=? WHERE id=?').run(status,data.finishedAt,data.receipt,data.failureStage,data.errorCode,Number(data.outcome==='uncertain'),Number(data.outcome==='uncertain'&&data.requestInFlight),data.attemptId);
      if (data.outcome==='confirmed_failure') {
        const start=dayStart(data.finishedAt); const allocation=data.retryAt!==undefined?{dueAt:data.retryAt,overflow:data.retryOverflow}:plan.topicId===null?{dueAt:start+30*86400000,overflow:true}:this.allocateCapacityDay(plan.topicId,plan.plannedAction,start,start+86400000,start+30*86400000,plan.id);
        const due=Math.max(allocation.dueAt,start+86400000);
        const finalState=plan.cancelRequested?'cancelled':plan.orphaned?'manual_review':plan.channelDisabled?'paused_channel':'scheduled';
        this.db.prepare("UPDATE interaction_plans SET state=?,resume_state=CASE WHEN ?='paused_channel' THEN 'scheduled' ELSE NULL END,version=version+1,cycle_start_day=?,cycle_deadline_day=?,due_at=?,cycle_count=cycle_count+1,failure_count=failure_count+1,overflow=? WHERE id=?").run(finalState,finalState,start,start+30*86400000,due,Number(allocation.overflow||data.retryOverflow),attempt.planId);
      } else {
        const finalState=data.outcome==='succeeded'?'succeeded':nextState;
        this.db.prepare('UPDATE interaction_plans SET state=?,version=version+1 WHERE id=?').run(finalState,attempt.planId);
      }
      const latest=this.interactionPlan(attempt.planId)!;
      this.db.prepare('INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,?,?,?,?,?,?,?)').run(attempt.planId,'attempt_result',data.finishedAt,latest.cycleCount,plan.state,latest.state,data.evidence || ({succeeded:'收到可信发送成功结果',confirmed_failure:'确认未发送，安排进入下一周期',uncertain:'发送结果不能确定，禁止自动重试',manual_review:'转人工核查'}[data.outcome]),data.errorCode);
      const updated=this.db.prepare('SELECT * FROM interaction_attempts WHERE id=?').get(data.attemptId);
      this.db.exec('COMMIT'); return this.mapAttempt(updated);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Preparation/read failures consume no send attempt but advance the cycle and are auditable. */
  recordPlanPreparationFailure(planId: number, expectedVersion: number, now: number, retryAt: number, errorCode: string, reason: string) {
    return this.recordPlanFailure(planId,expectedVersion,now,retryAt,errorCode,reason,'prepare_failure');
  }
  recordPlanPreflightFailure(planId:number,expectedVersion:number,now:number,retryAt:number,errorCode:string,reason:string) {
    return this.recordPlanFailure(planId,expectedVersion,now,retryAt,errorCode,reason,'preflight_failure');
  }
  private recordPlanFailure(planId:number,expectedVersion:number,now:number,retryAt:number,errorCode:string,reason:string,eventType:'prepare_failure'|'preflight_failure') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const plan=this.interactionPlan(planId);
      if (!plan || plan.state!=='scheduled' || plan.version!==expectedVersion) { this.db.exec('ROLLBACK'); return undefined; }
      const start=dayStart(now); const allocation=plan.topicId===null?{dueAt:start+30*86400000,overflow:true}:this.allocateCapacityDay(plan.topicId,plan.plannedAction,start,start+86400000,start+30*86400000,plan.id); const due=Math.max(retryAt,allocation.dueAt);
      this.db.prepare("UPDATE interaction_plans SET version=version+1,cycle_start_day=?,cycle_deadline_day=?,due_at=?,cycle_count=cycle_count+1,failure_count=failure_count+1,overflow=? WHERE id=? AND version=? AND state='scheduled'").run(start,start+30*86400000,due,Number(allocation.overflow),planId,expectedVersion);
      this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,?,?,?,'scheduled','scheduled',?,?)").run(planId,eventType,now,plan.cycleCount+1,reason,errorCode);
      const updated=this.interactionPlan(planId); this.db.exec('COMMIT'); return updated;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  beginPlanPreparation(planId: number, expectedVersion: number, now: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const plan=this.interactionPlan(planId);
      if (!plan || plan.state!=='scheduled' || plan.version!==expectedVersion || plan.dueAt>now || (plan.nextPrepareAt!==null && plan.nextPrepareAt>now)) { this.db.exec('ROLLBACK'); return false; }
      const today=dayStart(now); const settings=this.settings();
      if (settings.limits.dailyTotal===0) { this.db.exec('ROLLBACK'); return false; }
      const planCount=plan.readDay===today?plan.readCount:0;
      if (planCount>=3) {
        this.db.prepare('UPDATE interaction_plans SET read_day=?,read_count=?,next_prepare_at=? WHERE id=? AND version=?').run(today,planCount,today+86400000,planId,expectedVersion);
        this.db.exec('COMMIT'); return false;
      }
      const used=countRow.parse(this.db.prepare('SELECT coalesce(sum(read_count),0) AS n FROM interaction_plans WHERE read_day=?').get(today)).n;
      if (used>=settings.limits.dailyTotal*3) {
        this.db.prepare('UPDATE interaction_plans SET read_day=?,read_count=?,next_prepare_at=? WHERE id=? AND version=?').run(today,planCount,today+86400000,planId,expectedVersion);
        this.db.exec('COMMIT'); return false;
      }
      const next=now+Math.max(settings.limits.waitMin,5)*60000;
      this.db.prepare('UPDATE interaction_plans SET read_day=?,read_count=?,next_prepare_at=? WHERE id=? AND version=?').run(today,planCount+1,next,planId,expectedVersion);
      this.db.exec('COMMIT'); return true;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deferPlanPreparation(planId: number, expectedVersion: number, now: number) {
    const tomorrow=dayStart(now)+86400000;
    this.db.prepare('UPDATE interaction_plans SET next_prepare_at=? WHERE id=? AND version=? AND state=\'scheduled\'').run(tomorrow,planId,expectedVersion);
  }
  deferPlanForCapacity(planId:number,expectedVersion:number,now:number,reason='当前日互动额度已满') {
    const tomorrow=dayStart(now)+86400000;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const plan=this.interactionPlan(planId);if(!plan||plan.state!=='scheduled'||plan.version!==expectedVersion){this.db.exec('ROLLBACK');return false;}
      this.db.prepare("UPDATE interaction_plans SET due_at=?,overflow=CASE WHEN ?>cycle_deadline_day THEN 1 ELSE overflow END,version=version+1 WHERE id=? AND version=?").run(tomorrow,tomorrow,planId,expectedVersion);
      this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'capacity_wait',?,?,'scheduled','scheduled',?,'quota_full')").run(planId,now,plan.cycleCount,reason);
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  setPlanWaitingTemplate(planId: number, expectedVersion: number, now: number, reason: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const plan=this.interactionPlan(planId);
      if (!plan || plan.state!=='scheduled' || plan.version!==expectedVersion) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare("UPDATE interaction_plans SET state='waiting_template',version=version+1 WHERE id=? AND version=?").run(planId,expectedVersion);
      this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'template_wait',?,?,'scheduled','waiting_template',?,'')").run(planId,now,plan.cycleCount,reason);
      this.db.exec('COMMIT'); return true;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  wakeWaitingPlans(topicId: number, now = Date.now()) {
    this.db.prepare("UPDATE interaction_plans SET state='scheduled',version=version+1,next_prepare_at=NULL,due_at=min(due_at,?) WHERE topic_id=? AND state='waiting_template'").run(now,topicId);
  }
  private capacityUsage(day: number, topicId: number, action: 'comment'|'reply', excludePlanId?: number) {
    const attemptTotal=this.attemptCount(day);
    const attemptAction=this.attemptCount(day,undefined,action);
    const attemptTopic=this.attemptCount(day,topicId,action);
    const reserved=(sql: string, params: (string|number|null)[])=>countRow.parse(this.db.prepare(sql).get(...params)).n;
    const base="SELECT count(*) AS n FROM interaction_plans WHERE due_at>=? AND due_at<? AND state IN ('scheduled','waiting_template','paused_channel') AND (? IS NULL OR id<>?)";
    const totalReserve=reserved(base,[day,day+86400000,excludePlanId??null,excludePlanId??null]);
    const actionReserve=reserved(`${base} AND planned_action=?`,[day,day+86400000,excludePlanId??null,excludePlanId??null,action]);
    const topicReserve=reserved(`${base} AND topic_id=? AND planned_action=?`,[day,day+86400000,excludePlanId??null,excludePlanId??null,topicId,action]);
    return { total:attemptTotal+totalReserve, action:attemptAction+actionReserve, topicAction:attemptTopic+topicReserve };
  }
  private allocateCapacityDay(topicId: number, action: 'comment'|'reply', cycleStart: number, earliest: number, deadline: number, excludePlanId?: number): { dueAt: number; overflow: boolean } {
    const settings=this.settings(); const topic=this.topic(topicId);
    if (!topic) throw new Error('频道不存在');
    // Immediate plans and newly failed retries retain their earliest eligible day when it has room;
    // only deferred plans (which pass a later earliest day) use balancing across the 30-day window.
    if (earliest===cycleStart) {
      const used=this.capacityUsage(dayStart(earliest),topicId,action,excludePlanId);
      const actionLimit=action==='comment'?settings.limits.dailyComment:settings.limits.dailyReply;
      const topicLimit=action==='comment'?topic.dailyComment:topic.dailyReply;
      if (used.total<settings.limits.dailyTotal&&used.action<actionLimit&&used.topicAction<topicLimit) return {dueAt:earliest,overflow:false};
    }
    const totalLimit=settings.limits.dailyTotal;
    const actionLimit=action==='comment'?settings.limits.dailyComment:settings.limits.dailyReply;
    const topicLimit=action==='comment'?topic.dailyComment:topic.dailyReply;
    const first=dayStart(earliest); const days:number[]=[]; const scores:number[]=[];
    for (let day=first;day<=deadline;day+=86400000) {
      if (day<cycleStart) continue;
      const used=this.capacityUsage(day,topicId,action,excludePlanId);
      if (used.total>=totalLimit || used.action>=actionLimit || used.topicAction>=topicLimit) continue;
      days.push(day);
      scores.push(Math.max(used.total/Math.max(1,totalLimit),used.action/Math.max(1,actionLimit),used.topicAction/Math.max(1,topicLimit)));
    }
    if (!days.length) return { dueAt:deadline, overflow:true };
    const lowest=Math.min(...scores); const ties=days.filter((_,i)=>Math.abs(scores[i]-lowest)<1e-9);
    const index=Math.min(ties.length-1,Math.max(0,Math.floor(this.random()*ties.length)));
    const picked=ties[index];
    return { dueAt:picked===dayStart(earliest)?Math.max(picked,earliest):picked,overflow:false };
  }
  /** Keep future reservations within changed global/action/channel quotas without moving earlier plans. */
  rebalanceCapacity(now=Date.now()) {
    const plans=this.db.prepare("SELECT * FROM interaction_plans WHERE state IN ('scheduled','waiting_template','paused_channel') ORDER BY due_at,id").all().map(row=>this.mapPlan(row));
    const today=dayStart(now); const usage=new Map<number,{total:number;comment:number;reply:number;topics:Map<number,{comment:number;reply:number}>}>();
    const dayUsage=(day:number)=>{
      let value=usage.get(day);if(value)return value;
      value={total:this.attemptCount(day),comment:this.attemptCount(day,undefined,'comment'),reply:this.attemptCount(day,undefined,'reply'),topics:new Map()};
      usage.set(day,value);return value;
    };
    const topicUsage=(day:number,topicId:number)=>{
      const value=dayUsage(day);let topic=value.topics.get(topicId);if(topic)return topic;
      topic={comment:this.attemptCount(day,topicId,'comment'),reply:this.attemptCount(day,topicId,'reply')};value.topics.set(topicId,topic);return topic;
    };
    const canReserve=(day:number,plan:InteractionPlan,topic:Topic)=>{
      const used=dayUsage(day),byTopic=topicUsage(day,topic.id),action=plan.plannedAction;
      const actionUsed=action==='comment'?used.comment:used.reply;const topicUsed=action==='comment'?byTopic.comment:byTopic.reply;
      const actionLimit=action==='comment'?this.settings().limits.dailyComment:this.settings().limits.dailyReply;
      const topicLimit=action==='comment'?topic.dailyComment:topic.dailyReply;
      return used.total<this.settings().limits.dailyTotal&&actionUsed<actionLimit&&topicUsed<topicLimit;
    };
    const reserve=(day:number,plan:InteractionPlan,topic:Topic)=>{
      const used=dayUsage(day),byTopic=topicUsage(day,topic.id),action=plan.plannedAction;
      used.total++;if(action==='comment'){used.comment++;byTopic.comment++;}else{used.reply++;byTopic.reply++;}
    };
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const plan of plans){
        if(plan.topicId===null||plan.dueAt<today||today>plan.cycleDeadlineDay)continue;
        const topic=this.topic(plan.topicId);if(!topic)continue;
        const earliest=Math.max(today,plan.cycleStartDay,dayStart(plan.dueAt));const current=Math.min(plan.cycleDeadlineDay,dayStart(earliest));
        let target=current;let overflow=false;
        if(!canReserve(current,plan,topic)){
          const candidates:number[]=[];const scores:number[]=[];
          for(let day=current+86400000;day<=plan.cycleDeadlineDay;day+=86400000){
            if(canReserve(day,plan,topic)){
              const used=dayUsage(day),byTopic=topicUsage(day,topic.id),action=plan.plannedAction;
              const score=Math.max(used.total/Math.max(1,this.settings().limits.dailyTotal),(action==='comment'?used.comment:used.reply)/Math.max(1,action==='comment'?this.settings().limits.dailyComment:this.settings().limits.dailyReply),(action==='comment'?byTopic.comment:byTopic.reply)/Math.max(1,action==='comment'?topic.dailyComment:topic.dailyReply));
              candidates.push(day);scores.push(score);
            }
          }
          if(candidates.length){const lowest=Math.min(...scores);const ties=candidates.filter((_,index)=>Math.abs(scores[index]-lowest)<1e-9);target=ties[Math.min(ties.length-1,Math.max(0,Math.floor(this.random()*ties.length)))];}
          else {target=plan.cycleDeadlineDay;overflow=true;}
        }
        const dueAt=target===current&&target===dayStart(plan.dueAt)?plan.dueAt:target;
        if(dueAt!==plan.dueAt||overflow!==plan.overflow){
          this.db.prepare('UPDATE interaction_plans SET due_at=?,overflow=?,version=version+1 WHERE id=? AND version=?').run(dueAt,Number(overflow),plan.id,plan.version);
          this.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,'capacity_rebalanced',?,?,?, ?,?,'quota_changed')").run(plan.id,now,plan.cycleCount,plan.state,plan.state,overflow?'额度变化后无空闲日，保留在本周期截止日并标记溢出':`额度变化后重新安排为 ${new Date(dueAt).toISOString()}`);
        }
        reserve(target,plan,topic);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  rescheduleFailedPlan(plan: InteractionPlan, failedAt: number): { dueAt: number; overflow: boolean } {
    const start=dayStart(failedAt); return plan.topicId===null?{dueAt:start+30*86400000,overflow:true}:this.allocateCapacityDay(plan.topicId,plan.plannedAction,start,start+86400000,start+30*86400000,plan.id);
  }
  settings(): Settings {
    const row = dataRow.parse(this.db.prepare('SELECT data FROM app_settings WHERE id=1').get());
    const config = z.record(z.unknown()).parse(JSON.parse(row.data));
    const { baseUrl, model, apiKey } = aiConfigSchema.parse(config.ai ?? {});
    return settingsSchema.parse({ ...config, ai: { baseUrl, model, apiKeyConfigured: !!apiKey }, account: this.account() });
  }
  saveSettings(s: Settings) {
    const { account, ...config } = s;
    // Public snapshots must never overwrite or clear the private key.
    this.db.prepare('INSERT OR REPLACE INTO app_settings VALUES(1,?)').run(JSON.stringify({ ...config, ai: this.aiConfig() }));
    this.db.prepare('INSERT OR REPLACE INTO auth_metadata VALUES(1,?)').run(JSON.stringify(account));
  }
  aiConfig(): AiConfig {
    const row = this.db.prepare('SELECT data FROM app_settings WHERE id=1').get();
    const config = row ? z.record(z.unknown()).parse(JSON.parse(dataRow.parse(row).data)) : {};
    return aiConfigSchema.parse(config.ai ?? {});
  }
  saveAiConfig(config: AiConfig) {
    this.db.prepare("UPDATE app_settings SET data=json_set(data,'$.ai',json(?)) WHERE id=1").run(JSON.stringify(aiConfigSchema.parse(config)));
  }
  // Auth metadata is deliberately separate from configuration and contains no Cookie values.
  account(): Settings['account'] {
    const row = this.db.prepare('SELECT data FROM auth_metadata WHERE id=1').get();
    return row ? accountSchema.parse(JSON.parse(dataRow.parse(row).data)) : { loggedIn: false, message: '未登录' };
  }
  topics(now = Date.now()): Topic[] {
    return this.db.prepare('SELECT * FROM topics ORDER BY id').all().map(raw => {
      const row = z.object({ id: z.number(), config: z.string(), next_search: z.number(), last_run: z.number().nullable() }).parse(raw);
      const keywords = this.db.prepare('SELECT keyword FROM keywords WHERE topic_id=? ORDER BY rowid').all(row.id).map(k => z.object({ keyword: z.string() }).parse(k).keyword);
      const config = topicSchema.parse({ ...z.record(z.unknown()).parse(JSON.parse(row.config)), keywords });
      return { ...config, id: row.id, nextSearch: row.next_search, lastRun: row.last_run, todayDiscovered: this.count('discover', now, row.id), todayInteractions: this.attemptCount(now, row.id) };
    });
  }
  topic(id: number): Topic | undefined { return this.topics().find(t => t.id === id); }
  saveTopic(config: TopicConfig, id?: number): number {
    const before=id?this.topic(id):undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { keywords, ...rest } = config;
      let topicId = id;
      if (topicId) {
        const previous = this.topic(topicId);
        const result = this.db.prepare('UPDATE topics SET config=? WHERE id=?').run(JSON.stringify(rest), topicId);
        if (!result.changes) throw new Error('Topic 不存在');
        if (previous?.enabled && !config.enabled) {
          this.db.prepare("UPDATE interaction_plans SET state='paused_channel',resume_state=state,channel_disabled=1,version=version+1 WHERE topic_id=? AND state IN ('scheduled','waiting_template')").run(topicId);
          this.db.prepare("UPDATE interaction_plans SET channel_disabled=1,version=version+1 WHERE topic_id=? AND state IN ('claimed','uncertain','manual_review')").run(topicId);
        } else if (!previous?.enabled && config.enabled) {
          this.db.prepare("UPDATE interaction_plans SET state=coalesce(resume_state,'scheduled'),resume_state=NULL,channel_disabled=0,version=version+1 WHERE topic_id=? AND state='paused_channel'").run(topicId);
          this.db.prepare("UPDATE interaction_plans SET channel_disabled=0,version=version+1 WHERE topic_id=? AND state IN ('claimed','uncertain','manual_review') AND orphaned=0").run(topicId);
        }
        this.db.prepare('DELETE FROM keywords WHERE topic_id=?').run(topicId);
      } else {
        const sequence=countRow.parse(this.db.prepare('SELECT last_id AS n FROM topic_id_sequence WHERE id=1').get()).n;
        const topicMax=countRow.parse(this.db.prepare('SELECT coalesce(max(id),0) AS n FROM topics').get()).n;
        const billingMax=countRow.parse(this.db.prepare('SELECT coalesce(max(billing_topic_id),0) AS n FROM interaction_attempts').get()).n;
        topicId=Math.max(sequence,topicMax,billingMax)+1;
        this.db.prepare('INSERT INTO topics(id,config,next_search) VALUES(?,?,0)').run(topicId,JSON.stringify(rest));
        this.db.prepare('UPDATE topic_id_sequence SET last_id=? WHERE id=1').run(topicId);
      }
      for (const word of new Set(keywords)) this.db.prepare('INSERT INTO keywords VALUES(?,?)').run(topicId, word);
      this.db.exec('COMMIT');
      if(before&&(before.dailyComment!==config.dailyComment||before.dailyReply!==config.dailyReply))this.rebalanceCapacity();
      return topicId;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  deleteTopic(id: number) {
    const plans=this.db.prepare('SELECT * FROM interaction_plans WHERE topic_id=?').all(id).map(row=>this.mapPlan(row)).filter(p=>!['succeeded','cancelled'].includes(p.state));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const plan of plans) {
        const state:InteractionState=['claimed','uncertain'].includes(plan.state)?plan.state:'manual_review';
        this.db.prepare('UPDATE interaction_plans SET state=?,orphaned=1,channel_disabled=1,version=version+1 WHERE id=?').run(state,plan.id);
        this.db.prepare('INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason,error_code) VALUES(?,?,?,?,?,?,?,?)').run(plan.id,'channel_deleted',Date.now(),plan.cycleCount,plan.state,state,'频道已删除；保留任务快照和去重记录，需人工处理','channel_deleted');
      }
      this.db.prepare('DELETE FROM topics WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  templates(): Template[] {
    return this.db.prepare('SELECT * FROM templates ORDER BY id').all().map(raw => {
      const r = z.object({ id: z.number(), topic_id: z.number(), kind: z.enum(['comment','reply']), text: z.string(), enabled: z.number() }).parse(raw);
      return { id: r.id, topicId: r.topic_id, kind: r.kind, text: r.text, enabled: !!r.enabled };
    });
  }
  saveTemplate(t: Omit<Template,'id'>, id?: number) {
    if (!this.topic(t.topicId)) throw new Error('Topic 不存在');
    if (id) {
      if (!this.db.prepare('UPDATE templates SET topic_id=?,kind=?,text=?,enabled=? WHERE id=?').run(t.topicId,t.kind,t.text,Number(t.enabled),id).changes) throw new Error('模板不存在');
      if(t.enabled)this.wakeWaitingPlans(t.topicId);
      return id;
    }
    const saved=Number(this.db.prepare('INSERT INTO templates(topic_id,kind,text,enabled) VALUES(?,?,?,?)').run(t.topicId,t.kind,t.text,Number(t.enabled)).lastInsertRowid);
    if(t.enabled)this.wakeWaitingPlans(t.topicId);
    return saved;
  }
  log(data: Activity) { this.db.prepare('INSERT INTO activity(time,topic_id,action,data) VALUES(?,?,?,?)').run(data.time,data.topicId,data.action,JSON.stringify(data)); }
  activity(action = 'all', limit = 200, offset = 0): Activity[] {
    return this.db.prepare('SELECT id,data FROM activity WHERE (?=\'all\' OR action=?) ORDER BY id DESC LIMIT ? OFFSET ?').all(action,action,limit,offset).map(raw => {
      const row = dataRow.extend({ id: z.number() }).parse(raw);
      return { ...activitySchema.parse(JSON.parse(row.data)), id: row.id };
    });
  }
  recentComments(limit = 10): RecentComment[] {
    const legacy=this.db.prepare("SELECT i.id,i.action,i.attempted,i.content,i.target,i.receipt,d.video,d.keyword,t.config FROM interactions i JOIN discoveries d USING(bvid) LEFT JOIN topics t ON t.id=i.topic_id WHERE i.state='succeeded' AND NOT EXISTS(SELECT 1 FROM interaction_plans p WHERE p.bvid=i.bvid) ORDER BY i.attempted DESC,i.id DESC LIMIT ?").all(limit).map(raw => {
      const row = recentRowSchema.parse(raw); const video = videoSchema.parse(JSON.parse(row.video));
      const receipt = postReceiptSchema.catch({}).parse(row.receipt ? JSON.parse(row.receipt) : {});
      return { id: row.id, time: row.attempted, action: row.action, bvid: video.bvid, title: plainTitle(video.title), author: video.author, topic: row.config === null ? '已删除频道' : topicNameSchema.parse(JSON.parse(row.config)).name, keyword: row.keyword, content: row.content, target: row.target, cover: receipt.cover ?? null, rpid: receipt.rpid ?? null, stats: receipt.stats ?? { view: video.play }, statsAt: receipt.stats ? 'post' : 'discover' } as RecentComment;
    });
    const native=this.db.prepare("SELECT a.id,a.effective_action AS action,a.started_at AS attempted,a.content,a.target,a.receipt,p.video,p.keyword,p.topic_name AS topic FROM interaction_attempts a JOIN interaction_plans p ON p.id=a.plan_id WHERE a.status='succeeded' ORDER BY a.started_at DESC,a.id DESC LIMIT ?").all(limit).map(raw=>{
      const row=z.object({id:z.number(),action:z.enum(['comment','reply']),attempted:z.number(),content:z.string(),target:z.string(),receipt:z.string(),video:z.string(),keyword:z.string(),topic:z.string()}).parse(raw);
      const video=videoSchema.parse(JSON.parse(row.video));const receipt=postReceiptSchema.catch({}).parse(row.receipt?JSON.parse(row.receipt):{});
      return {id:-row.id,time:row.attempted,action:row.action,bvid:video.bvid,title:plainTitle(video.title),author:video.author,topic:row.topic,keyword:row.keyword,content:row.content,target:row.target,cover:receipt.cover??null,rpid:receipt.rpid??null,stats:receipt.stats??{view:video.play},statsAt:receipt.stats?'post' as const:'discover' as const};
    });
    return [...legacy,...native].sort((a,b)=>b.time-a.time||b.id-a.id).slice(0,limit);
  }
  count(action: string, now: number, topicId?: number) {
    return countRow.parse(this.db.prepare('SELECT count(*) AS n FROM activity WHERE time>=? AND action=? AND (? IS NULL OR topic_id=?)').get(dayStart(now),action,topicId ?? null,topicId ?? null)).n;
  }
  attemptCount(now: number, topicId?: number, action?: string) {
    const day=dayStart(now);
    return countRow.parse(this.db.prepare(`SELECT
      (SELECT count(*) FROM interaction_attempts WHERE quota_day=? AND (? IS NULL OR billing_topic_id=?) AND (? IS NULL OR effective_action=?)) +
      (SELECT count(*) FROM interactions i WHERE i.attempted>=? AND i.attempted<? AND (? IS NULL OR i.topic_id=?) AND (? IS NULL OR i.action=?)
        AND NOT EXISTS(SELECT 1 FROM interaction_plans p WHERE p.bvid=i.bvid)) AS n`).get(day,topicId ?? null,topicId ?? null,action ?? null,action ?? null,day,day+86400000,topicId ?? null,topicId ?? null,action ?? null,action ?? null)).n;
  }
  canClaimNow(now:number,topicId:number,action:'comment'|'reply',dispatchClass:'ordinary'|'overdue') {
    const settings=this.settings();const topic=this.topic(topicId);if(!topic?.enabled)return false;
    const day=dayStart(now);const overdue=countRow.parse(this.db.prepare("SELECT count(*) AS n FROM interaction_attempts WHERE quota_day=? AND dispatch_class IN ('overdue','legacy_unknown')").get(day)).n;
    return quotaDecision(now,settings.limits,topic,action,dispatchClass==='overdue',{total:this.attemptCount(now),action:this.attemptCount(now,undefined,action),topicAction:this.attemptCount(now,topicId,action),overdue}).length===0;
  }
  discover(video: Video, topicId: number, keyword: string, now: number): boolean {
    return !!this.db.prepare('INSERT OR IGNORE INTO discoveries VALUES(?,?,?,?,?,?)').run(video.bvid,video.aid,topicId,JSON.stringify(video),keyword,now).changes;
  }
  queue(bvid: string, topicId: number, action: 'comment'|'reply', due: number) { this.db.prepare("INSERT INTO interactions(bvid,topic_id,action,state,due) VALUES(?,?,?,'queued',?)").run(bvid,topicId,action,due); }
  nextQueue(now: number) {
    const row = this.db.prepare("SELECT i.*,d.video,d.keyword FROM interactions i JOIN discoveries d USING(bvid) JOIN topics t ON t.id=i.topic_id WHERE i.state='queued' AND i.due<=? AND json_extract(t.config,'$.enabled')=1 ORDER BY i.due,i.id LIMIT 1").get(now);
    return row ? queueSchema.parse(row) : undefined;
  }
  close() { try { this.db.close(); } finally { this.releaseLock?.(); this.releaseLock=undefined; } }
}
