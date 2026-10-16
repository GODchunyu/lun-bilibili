import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dayStart, topicSchema, videoSchema } from '../server/model.js';
import { Store } from '../server/store.js';

const video = videoSchema.parse({ bvid: 'BV1234567890', aid: 123, title: '测试视频', author: 'UP主', play: 1, pubdate: 1 });
const day = Date.UTC(2026, 9, 14) - 8 * 60 * 60 * 1000;

test('new plan creation binds UID, atomically deduplicates BV/AV, and claim freezes accounting facts', () => {
  const store = new Store(':memory:');
  try {
    const topicId = store.saveTopic(topicSchema.parse({ name: '测试频道', enabled: true, keywords: ['测试'] }));
    assert.equal(store.bindAccount('10001', true).ok, true);
    const create = {
      video, topicId, ownerUid: '10001', topicName: '测试频道', keyword: '测试', matchedField: 'title', plannedAction: 'reply' as const,
      commentTemplates: ['评论候选'], replyTemplates: ['回复候选'], createdAt: day, dueAt: day, cycleStartDay: dayStart(day), cycleDeadlineDay: dayStart(day) + 30 * 86400000, overflow: false,
    };
    const plan = store.createInteractionPlan(create);
    assert.ok(plan); assert.equal(plan?.plannedAction, 'reply'); assert.deepEqual(plan?.commentTemplates, ['评论候选']);
    assert.equal(store.createInteractionPlan(create), undefined, 'same BV is a duplicate');
    assert.equal(store.createInteractionPlan({ ...create, video: { ...video, bvid: 'BV0987654321' } }), undefined, 'same aid is a duplicate');

    const attempt = store.claimInteractionPlan({ planId: plan!.id, expectedVersion: plan!.version, now: day, quotaDay: dayStart(day), dispatchClass: 'ordinary', billingTopicId: topicId, billingTopicName: '测试频道', senderUid: '10001', effectiveAction: 'comment', fallbackReason: '没有合格评论对象', content: '快照评论', target: '', targetUid: '' });
    assert.ok(attempt); assert.equal(attempt?.effectiveAction, 'comment');
    assert.equal(attempt?.dispatchClass, 'ordinary'); assert.equal(attempt?.senderUid, '10001');
    assert.equal(store.attemptCount(day, topicId, 'comment'), 1);
    assert.throws(() => store.db.prepare("UPDATE interaction_attempts SET dispatch_class='ordinary' WHERE id=?").run(attempt!.id), /immutable/);
  } finally { store.close(); }
});

test('confirmed failures append an attempt, keep the original action and template snapshots, and use the next cycle', () => {
  const store = new Store(':memory:');
  try {
    const topicId = store.saveTopic(topicSchema.parse({ name: '测试频道', enabled: true, keywords: ['测试'] }));
    store.bindAccount('10001', true);
    const plan = store.createInteractionPlan({ video, topicId, ownerUid: '10001', topicName: '测试频道', keyword: '测试', matchedField: 'author', plannedAction: 'reply', commentTemplates: ['评论快照'], replyTemplates: ['回复快照'], createdAt: day, dueAt: day, cycleStartDay: dayStart(day), cycleDeadlineDay: dayStart(day) + 30 * 86400000 });
    assert.ok(plan);
    const attempt = store.claimInteractionPlan({ planId: plan.id, expectedVersion: plan.version, now: day, quotaDay: dayStart(day), dispatchClass: 'ordinary', billingTopicId: topicId, billingTopicName: '测试频道', senderUid: '10001', effectiveAction: 'reply', content: '回复快照', target: '评论 22', targetUid: '20002' });
    assert.ok(attempt);
    const retryAt = dayStart(day + 4 * 86400000) + 36 * 60 * 60 * 1000;
    const finished = store.finishInteractionAttempt({ attemptId: attempt.id, outcome: 'confirmed_failure', finishedAt: day + 4 * 86400000, retryAt, errorCode: 'temporary_api', evidence: '平台明确拒绝，未提交' });
    const updated = store.interactionPlan(plan.id)!;
    assert.equal(finished.status, 'failed'); assert.equal(updated.state, 'scheduled'); assert.equal(updated.plannedAction, 'reply');
    assert.deepEqual(updated.commentTemplates, ['评论快照']); assert.deepEqual(updated.replyTemplates, ['回复快照']);
    assert.equal(updated.cycleCount, 1); assert.equal(updated.cycleStartDay, dayStart(day + 4 * 86400000)); assert.equal(updated.dueAt, retryAt);
    assert.equal(store.interactionAttempts(plan.id).length, 1);
    assert.equal(store.interactionEvents(plan.id).at(-1)?.eventType, 'attempt_result');
  } finally { store.close(); }
});

test('restart converts a persisted claim to uncertain without resetting its accounting row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lun-store-recovery-'));
  const path = join(directory, 'recover.sqlite');
  let store = new Store(path);
  try {
    const topicId = store.saveTopic(topicSchema.parse({ name: '测试频道', enabled: true, keywords: ['测试'] }));
    store.bindAccount('10001', true);
    const plan = store.createInteractionPlan({ video, topicId, ownerUid: '10001', topicName: '测试频道', keyword: '测试', matchedField: 'title', plannedAction: 'comment', commentTemplates: ['评论快照'], replyTemplates: ['回复快照'], createdAt: day, dueAt: day, cycleStartDay: dayStart(day), cycleDeadlineDay: dayStart(day) + 30 * 86400000 });
    assert.ok(plan);
    const attempt = store.claimInteractionPlan({ planId: plan.id, expectedVersion: plan.version, now: day, quotaDay: dayStart(day), dispatchClass: 'ordinary', billingTopicId: topicId, billingTopicName: '测试频道', senderUid: '10001', effectiveAction: 'comment', content: '评论快照' });
    assert.ok(attempt); store.close();
    store = new Store(path);
    assert.equal(store.interactionPlan(plan.id)?.state, 'uncertain');
    assert.equal(store.interactionAttempts(plan.id)[0]?.status, 'uncertain');
    assert.equal(store.interactionAttempts(plan.id)[0]?.requestUncertain, true);
    assert.equal(store.claimInteractionPlan({ planId: plan.id, expectedVersion: 1, now: day + 1000, quotaDay: dayStart(day), dispatchClass: 'ordinary', billingTopicId: topicId, billingTopicName: '测试频道', senderUid: '10001', effectiveAction: 'comment', content: '重试不得发生' }), undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy migration keeps successful and uncertain sends, unknown account/class, and does not replay queued work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lun-store-migration-'));
  const path = join(directory, 'legacy.sqlite');
  let store = new Store(path);
  try {
    const topicId = store.saveTopic(topicSchema.parse({ name: '旧频道', enabled: true, keywords: ['旧'] }));
    const discovery = { ...video, bvid: 'BV1111111111', aid: 321 };
    store.discover(discovery, topicId, '旧', day);
    store.db.prepare("INSERT INTO interactions(bvid,topic_id,action,state,due,attempted,content,target,receipt) VALUES(?,?,?,'succeeded',?,?,?, ?,?)").run(discovery.bvid,topicId,'comment',day,day,'已发送','',JSON.stringify({}));
    const queued = { ...video, bvid: 'BV2222222222', aid: 322 };
    store.discover(queued, topicId, '旧', day);
    store.db.prepare("INSERT INTO interactions(bvid,topic_id,action,state,due) VALUES(?,?,?,'queued',?)").run(queued.bvid,topicId,'reply',day);
    const uncertain = { ...video, bvid: 'BV3333333333', aid: 323 };
    store.discover(uncertain, topicId, '旧', day);
    store.db.prepare("INSERT INTO interactions(bvid,topic_id,action,state,due,attempted,content) VALUES(?,?,?,'claimed',?,?,?)").run(uncertain.bvid,topicId,'reply',day,day,'待确认');
    store.db.prepare('DELETE FROM schema_migrations WHERE version=1').run();
    store.close();
    store = new Store(path);
    const migrated = store.interactionPlans();
    assert.equal(migrated.find(p => p.bvid === discovery.bvid)?.state, 'succeeded');
    assert.equal(migrated.find(p => p.bvid === queued.bvid)?.state, 'manual_review');
    assert.equal(migrated.find(p => p.bvid === uncertain.bvid)?.state, 'uncertain');
    assert.ok(migrated.every(p => p.ownerUid === 'unknown' && p.snapshotSource === 'legacy_snapshot'));
    const successAttempt = store.interactionAttempts(migrated.find(p => p.bvid === discovery.bvid)!.id)[0];
    assert.equal(successAttempt.dispatchClass, 'legacy_unknown'); assert.equal(successAttempt.senderUid, 'unknown');
    assert.equal(store.accountBinding(), undefined, 'migration must not assign legacy records to the current account');
    assert.equal(store.bindAccount('10001', true).ok, false, 'legacy ownership confirmation is required');
    assert.equal(store.bindAccount('10001', true, true).ok, true);
    assert.equal(store.attemptCount(day, topicId), 2, 'known historical send attempts remain charged after migration');
    store.close();
    store = new Store(path);
    assert.equal(store.interactionPlans().length, 3, 'migration is idempotent after restart');
    assert.equal(store.interactionAttempts(migrated[0].id).length, 1);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a second Store instance for the same database is refused before it can mutate data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lun-store-lock-')); const path = join(directory, 'locked.sqlite');
  const first = new Store(path);
  try {
    assert.throws(() => new Store(path), /数据库已由进程|数据库实例锁/);
  } finally { first.close(); await rm(directory, { recursive: true, force: true }); }
});

const oldTemplateWaitReason='没有可用且不重复的模板';
function blockedTemplatePlan(store:Store,topicId:number,number:number) {
  const plan=store.createInteractionPlan({video:{...video,bvid:`BV${String(number).padStart(10,'0')}`,aid:number},topicId,ownerUid:'10001',topicName:'模板测试',keyword:'测试',matchedField:'title',plannedAction:'comment',commentTemplates:['共用模板'],replyTemplates:['共用模板'],createdAt:day,dueAt:day,cycleStartDay:dayStart(day),cycleDeadlineDay:dayStart(day)+30*86400000});
  assert.ok(plan);assert.equal(store.setPlanWaitingTemplate(plan.id,plan.version,day+1000,oldTemplateWaitReason),true);
  return store.interactionPlan(plan.id)!;
}

test('template migration recovers only eligible snapshots, preserving all scheduling fields and paused channels',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lun-template-migration-'));const path=join(directory,'patrol.sqlite');let store:Store|undefined=new Store(path);
  try {
    const topicId=store.saveTopic(topicSchema.parse({name:'模板测试',enabled:true,keywords:['测试']}));store.bindAccount('10001',true);
    const active=blockedTemplatePlan(store,topicId,501);
    store.db.prepare('UPDATE interaction_plans SET deferred=1,overflow=1,cycle_count=2,failure_count=3,due_at=?,read_day=?,read_count=2,next_prepare_at=? WHERE id=?').run(day+2*86400000,day,day+3600000,active.id);
    const pausedTopic=store.saveTopic(topicSchema.parse({name:'暂停频道',enabled:true,keywords:['测试']}));
    const paused=blockedTemplatePlan(store,pausedTopic,502);store.saveTopic({...store.topic(pausedTopic)!,enabled:false},pausedTopic);
    const before=store.db.prepare('SELECT * FROM interaction_plans ORDER BY id').all();
    const settings=store.settings();settings.lastContent='共用模板';settings.running=true;store.saveSettings(settings);
    const discoveries=store.db.prepare('SELECT * FROM discoveries ORDER BY bvid').all();
    store.db.prepare('DELETE FROM schema_migrations WHERE version=2').run();store.close();store=undefined;
    store=new Store(path);
    const after=store.db.prepare('SELECT * FROM interaction_plans ORDER BY id').all();
    assert.deepEqual(after.map(row=>({...row})),before.map(row=>({...row,state:row.id===active.id?'scheduled':'paused_channel',resume_state:row.id===active.id?null:'scheduled',version:Number(row.version)+1})));
    assert.equal(store.settings().running,false);assert.equal(store.settings().lastContent,'共用模板');
    assert.deepEqual(store.db.prepare('SELECT * FROM discoveries ORDER BY bvid').all(),discoveries);
    assert.equal(store.db.prepare('SELECT count(*) n FROM interaction_attempts').get()?.n,0);
    assert.equal(store.interactionEvents(active.id).at(-1)?.eventType,'template_repeat_recovered');
    assert.equal(store.interactionEvents(paused.id).at(-1)?.toState,'paused_channel');
    assert.equal(store.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=2').get()?.n,1);
    const events=store.db.prepare('SELECT * FROM interaction_events ORDER BY id').all();
    store.close();store=undefined;store=new Store(path);
    assert.deepEqual(store.db.prepare('SELECT * FROM interaction_plans ORDER BY id').all(),after);
    assert.deepEqual(store.db.prepare('SELECT * FROM interaction_events ORDER BY id').all(),events,'migration is idempotent');
  } finally {store?.close();await rm(directory,{recursive:true,force:true});}
});

test('template migration leaves terminal, unsafe, invalid and unrelated waiting plans untouched',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lun-template-exclusions-'));const path=join(directory,'patrol.sqlite');let store:Store|undefined=new Store(path);
  try {
    const topicId=store.saveTopic(topicSchema.parse({name:'模板测试',enabled:true,keywords:['测试']}));store.bindAccount('10001',true);
    let number=601;
    const keep:number[]=[];
    for(const snapshot of ['[]','["  "]','not-json','[123]']){
      const plan=blockedTemplatePlan(store,topicId,number++);keep.push(plan.id);
      store.db.prepare('UPDATE interaction_plans SET comment_templates=? WHERE id=?').run(snapshot,plan.id);
    }
    const noReply=blockedTemplatePlan(store,topicId,number++);keep.push(noReply.id);store.db.prepare("UPDATE interaction_plans SET reply_templates='[]' WHERE id=?").run(noReply.id);
    const cancelled=blockedTemplatePlan(store,topicId,number++);keep.push(cancelled.id);store.cancelInteractionPlan(cancelled.id,cancelled.version,day+2000);
    const manual=blockedTemplatePlan(store,topicId,number++);keep.push(manual.id);store.db.prepare("UPDATE interaction_plans SET state='manual_review' WHERE id=?").run(manual.id);
    const orphan=blockedTemplatePlan(store,topicId,number++);keep.push(orphan.id);store.db.prepare('UPDATE interaction_plans SET orphaned=1 WHERE id=?').run(orphan.id);
    const cancelFlag=blockedTemplatePlan(store,topicId,number++);keep.push(cancelFlag.id);store.db.prepare('UPDATE interaction_plans SET cancel_requested=1 WHERE id=?').run(cancelFlag.id);
    const unknown=blockedTemplatePlan(store,topicId,number++);keep.push(unknown.id);store.db.prepare("UPDATE interaction_plans SET owner_uid='unknown' WHERE id=?").run(unknown.id);
    const unrelated=blockedTemplatePlan(store,topicId,number++);keep.push(unrelated.id);
    store.db.prepare("INSERT INTO interaction_events(plan_id,event_type,at,cycle,from_state,to_state,reason) VALUES(?,'template_wait',?,0,'scheduled','waiting_template','没有可用模板')").run(unrelated.id,day+2000);
    for(const outcome of ['succeeded','uncertain'] as const){
      const plan=blockedTemplatePlan(store,topicId,number++);keep.push(plan.id);
      store.db.prepare("UPDATE interaction_plans SET state='scheduled',due_at=? WHERE id=?").run(day,plan.id);
      const attempt=store.claimInteractionPlan({planId:plan.id,expectedVersion:plan.version,now:day,quotaDay:dayStart(day),dispatchClass:'ordinary',billingTopicId:topicId,billingTopicName:'模板测试',senderUid:'10001',effectiveAction:'comment',content:'共用模板'});assert.ok(attempt);
      store.finishInteractionAttempt({attemptId:attempt.id,outcome,finishedAt:day+1000,requestInFlight:outcome==='uncertain'});
      // Even a damaged waiting state must not revive a potentially sent request.
      if(outcome==='uncertain')store.db.prepare("UPDATE interaction_plans SET state='waiting_template' WHERE id=?").run(plan.id);
    }
    const before=keep.map(id=>store!.db.prepare('SELECT * FROM interaction_plans WHERE id=?').get(id));
    const attempts=store.db.prepare('SELECT * FROM interaction_attempts ORDER BY id').all();
    store.db.prepare('DELETE FROM schema_migrations WHERE version=2').run();store.close();store=undefined;store=new Store(path);
    assert.deepEqual(keep.map(id=>store!.db.prepare('SELECT * FROM interaction_plans WHERE id=?').get(id)),before);
    assert.deepEqual(store.db.prepare('SELECT * FROM interaction_attempts ORDER BY id').all(),attempts);
    assert.equal(store.db.prepare('SELECT count(*) n FROM interaction_events WHERE event_type=?').get('template_repeat_recovered')?.n,0);
  } finally {store?.close();await rm(directory,{recursive:true,force:true});}
});

test('template migration rolls back state, versions, events and marker together and can retry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lun-template-rollback-'));const path=join(directory,'patrol.sqlite');let store:Store|undefined=new Store(path);
  try {
    const topicId=store.saveTopic(topicSchema.parse({name:'模板测试',enabled:true,keywords:['测试']}));store.bindAccount('10001',true);
    const first=blockedTemplatePlan(store,topicId,701);const second=blockedTemplatePlan(store,topicId,702);
    const before=store.db.prepare('SELECT * FROM interaction_plans ORDER BY id').all();
    store.db.exec(`CREATE TRIGGER fail_template_recovery BEFORE INSERT ON interaction_events WHEN NEW.event_type='template_repeat_recovered' AND NEW.plan_id=${second.id} BEGIN SELECT RAISE(ABORT,'test recovery rollback'); END`);
    store.db.prepare('DELETE FROM schema_migrations WHERE version=2').run();store.close();store=undefined;
    assert.throws(()=>new Store(path),/test recovery rollback/);
    const db=new DatabaseSync(path);
    try {
      assert.deepEqual(db.prepare('SELECT * FROM interaction_plans ORDER BY id').all(),before);
      assert.equal(db.prepare('SELECT count(*) n FROM interaction_events WHERE event_type=?').get('template_repeat_recovered')?.n,0);
      assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=2').get()?.n,0);
      db.exec('DROP TRIGGER fail_template_recovery');
    } finally {db.close();}
    store=new Store(path);assert.equal(store.interactionPlan(first.id)?.state,'scheduled');assert.equal(store.interactionPlan(second.id)?.state,'scheduled');
    assert.equal(store.db.prepare('SELECT count(*) n FROM interaction_events WHERE event_type=?').get('template_repeat_recovered')?.n,2);
  } finally {store?.close();await rm(directory,{recursive:true,force:true});}
});
