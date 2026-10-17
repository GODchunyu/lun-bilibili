# UI 运行状态显示改进：独立评审报告

评审对象：Git `2763740` 当前代码，以及本组开发计划/测试与验收/代码约束 v1、v2。
评审方式：本会话中的独立评审代理 `ui_logic_plan_review`。它不是外部评审机构；报告由主代理整理，问题与复核结论来自独立代理。
范围：本机源码与草案；未读真实数据库/凭据，未调用B站，未启动/暂停/修改服务，未修改源代码或提交代码。
结论：v1有条件可开发；v2复核通过，方案层面无未处置阻塞问题。获准后可先执行S0a安全前置项，再逐阶段开发。

## 1. 取证范围

- `server/scheduler.ts`：setStatus/waitingStatus、run/pause/cycle、discover/interact/pollUncertain。
- `server/store.ts`：queueSummary、dueInteractionPlans、读取预算/冷却、额度、全局在途屏障、attempt恢复与人工确认。
- `server/model.ts`：现有runtime、计划/attempt契约。
- `server/app.ts`：状态响应、启动写锁、成功统计、人工操作接口。
- `server/bilibili.ts`：connect在先、tool超时在后的调用事实。
- `web/main.tsx`：轮询与校时、Dashboard、Plans筛选/选择/详情/核查入口、入口副作用。
- `tests/runtime-status.test.ts`、`tests/patrol.test.ts`等现有测试及package依赖。

独立评审另外运行了两项最小取证：只用内存SQLite和FakeBilibili复现启动/暂停竞态，不创建真实桥接或调用真实平台。第二轮复核只读文档，没有再次运行测试。

## 2. v1发现与处置

未发现方案新增P0；发现两项必须在实施前补清的P1，以及三项P2澄清。这个结论不代表现有程序不存在严重缺陷。

### P1-01：真实启动/暂停竞态不能用显示修复替代

代码证据：`server/scheduler.ts:47-59`。run先await内部pause，再捕获generation；外部pause可以在该await窗口增加generation，旧run随后把新generation误认为自己的。

评审的内存Fake复现：先调用 `const run=scheduler.run()`，立即 `const pause=scheduler.pause('手动暂停')`，等待两者结束，得到 `running=true`、pauseReason空、runtime为idle。最后发出的暂停指令被旧启动过程越过。

另一个复现：run进入登录等待后手动暂停，再令旧登录Promise失败，得到settings仍手动暂停，但runtime变成manual_review/auth_required；旧失败回调覆盖了较新的暂停显示。

v1矛盾：要求完全不改控制语义，却承诺并发run/pause也正确。仅加前端busy或operation计时不能解决第一个真实控制问题。

v2处置：单列S0a控制安全修复、C34和O04a/b/c：控制入口顺序在await前确立，所有await后及修改running前复核；旧callback只操作自己的状态；防自等待死锁。独立提交，先测控制安全再做UI。该例外明确提交用户审阅，不再静默夹入展示范围。

状态：文档缺口已关闭；现有源码缺陷尚未修复。若用户后续排除S0a，不能宣称完整并发控制验收通过。

### P1-02：真实写锁关闭与完整Fake HTTP验收需要分层装配

代码证据：`server/app.ts:134-138`。createApp(...,false)的POST /api/scheduler在running=true时直接拒绝，因此原草案“全程关写但从生产启动按钮完整走到发送”无法原样实现。

v2处置：明确三类结果：
1. 生产HTTP关写拒绝测试，必须拒绝且不启动调度。
2. 直接调用Fake Scheduler.run，仅证明调度流程。
3. 专用纯Fake应用内部传createApp(...,true)模拟HTTP允许态，真实环境BILIBILI_WRITES_ENABLED始终false。工厂不接受McpBilibili、不启动Python、不读真实凭据、不访问外网，post只写内存Fake日志。先验证隔离再走浏览器流程。

状态：方案缺口已关闭；未执行浏览器完整链路，不把Fake允许态说成生产关写启动成功。

### P2-01：所谓“原计划时间”不是现有不可变事实

代码证据：`server/store.ts:528-531`、`586-592`会因失败新周期/容量等待改写due_at；契约没有独立的首次排程字段。

v2处置：统一currentDueAt=当前持久化dueAt，文案使用“当前安排/计划时间”；需要历史安排时只能使用已有证据，否则未知。本次不为显示追溯而新增SQLite迁移。

状态：文档已澄清。

### P2-02：今日成功要区分发起日与确认日

代码证据：`server/app.ts:62`按started_at与status=succeeded计数，迟到回执/人工确认可发生在次日。

v2处置：沿用startedAt的Asia/Shanghai自然日、succeeded和effectiveAction，不改额度日；增加A10跨日迟到确认测试，不按finishedAt重复计算。

状态：文档已澄清。

### P2-03：SSR不能直接导入现有浏览器入口

代码证据：`web/main.tsx:5`导入CSS，第34行使用localStorage，文件末尾访问document并createRoot；现有依赖无完整DOM测试环境。

v2处置：S3先抽取无CSS/浏览器顶层副作用的纯展示TSX，可用react-dom/server验证静态结构；路由、计时器、失联和Hooks交互仍需浏览器验证，工具不具备就列未验收。

状态：文档已澄清。

## 3. 非阻塞建议与v2落实

| 建议 | 处置 |
|---|---|
| 真实写屏障查所有attempt，而非只查最新一条 | 与Store.anyRequestInFlight()完全一致，C36和屏障夹具覆盖 |
| 保持首页简洁，不能把所有原因堆给用户 | API保留原因列表；首页主原因/必要补充，其他放详情，C21明确 |
| 主状态冲突必须有严格优先级 | v2第4节列出连接失效、暂停中、实际操作、控制暂停、通道阻塞、时间等待和空闲的优先级 |
| 100条真实执行窗口与200条旧展示窗口不同 | 保留100条执行选择；独立全队列摘要，不能承诺第101条本轮执行 |
| 统计与近期条数不因分页截断 | 全局计数独立计算；最多3条近期计划只是展示限制 |
| 随机测试可能偶发失败 | Store容量分配和Scheduler随机源分别固定，不能只固定一个 |

## 4. v2复核结论

独立评审复核原文摘录：

> 此前两个 P1 已在计划层面关闭，未发现新的阻塞性矛盾。可以提交用户审阅，获准后按阶段实施。

复核确认：控制竞态被单列且边界明确；Fake验收装配可落地；当前排程时间、跨日统计、SSR入口已明确；全局屏障与执行器同源；首页原因层次简洁；100/200条窗口边界一致。

实施建议：S0a作为首个独立代码提交，先通过O04a/b/c、正常顺序与在途回归，再进入观察层开发。此轮没有修改源码，不得把复核通过表述为实际竞态已经修复。

## 5. 验证边界与交付

- 三份方案已经过初审、修订和复核，测试清单为53条编号用例，含11条P0安全回归。
- 完整测试、lint/build、性能基准、真实浏览器/窄屏/深色验收尚未执行；本轮仅文档结构/链接/差异校验及独立代理两项内存Fake取证。
- 本轮没有更改生产数据或运行状态，没有进行Git提交/推送。
- 后续开发继续按用户要求逐阶段同步仓库，不能将本轮文档完成冒充代码实施完成。

相关交付：
- [开发计划](UI运行状态-开发计划.md)
- [测试与验收](UI运行状态-测试与验收.md)
- [代码约束](UI运行状态-代码约束.md)
