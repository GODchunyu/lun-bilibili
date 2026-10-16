> 本文保留旧版 AI/热度行为的兼容说明。当前自动巡逻以 `docs/开发计划.md` 与 `docs/开发约束.md` 为准：只匹配视频标题；不使用发布时间、播放量或简介过滤；固定 70% 延后、20% 评论、10% 回复；计划、尝试和桥接 operation journal 持久化。

# 详细行为与边界

本页描述当前实现；安装和首次使用见 [README](../README.md)。安全默认值与限额不能保证账号安全，也不替代平台规则。

## 调度、额度与去重

```text
- 搜索排序仍使用平台播放量排序，但发布时间、播放量和简介不参与资格过滤。
  → 固定 70% 延后 / 20% 评论 / 10% 回复 → 持久化互动计划 → 随机等待
  → 从入池模板快照选正文 → 当前状态复核 → 持久化 claim → 发送 → 记录结果
```

Discovery 与 Interaction Queue 分开存储，删除频道不会删除全局发现记录。

- 默认每频道搜索 30–90 分钟一次；每日搜索 20 / 评论 5 / 回复 3；新匹配固定按延后 / 评论 / 回复 70 / 20 / 10 分流。
- 搜索固定使用播放量排序的第一页（最多 50 条）；不传发布时间限制，也不按发布时间、播放量或简介过滤。
- 全局每日搜索 200 / 评论 10 / 回复 5 / 总互动 15；两次互动等待 5–30 分钟。
- 全局和频道额度同时生效，日界固定为 **Asia/Shanghai**，不依赖宿主机时区。发送额度按尝试计数，失败也占额度。
- 所有异步准备完成后复核最新运行状态；claim 前再检查登录、频道、限额、最短间隔、模板和 AI 模式。调高等待下限后，尚未 claim 的队列继续等待，不提前占额度。
- 每次启动保持暂停；暂停等待在途请求完成，不启动下一次互动。已发送到网络的请求不能撤回。
- 读取与互动有独立失败计数和指数退避，退避从 1 分钟增加到最多 1 小时，任一达到默认 3 次连续失败即暂停。成功读取不会清除互动失败。
- 未登录、验证码、风控和 HTTP 403/412 失败关闭并暂停；桥接层也识别 SDK 被上游转成字符串的风险错误。

### 防重复发送

网络发送前，将 claim、实际发送文本、已知回复对象和尝试时间一并持久化。已尝试的视频无论成功、失败、超时还是进程崩溃，都不自动重发。

启动时将未确认的 `claimed` 转为 `uncertain`，在同一事务内补记不确定活动。它不代表发送失败或成功；本项目选择宁可漏发，不重复发。旧 SQLite 会补齐 `target`、`receipt` 等字段；旧版本没有存下来的回复对象和回执无法追溯。

## 模板与回复对象

关闭 AI 判断时，保持概率分流、发送前抽模板与短反应白名单回复路径。模板绑定频道，评论和回复分别管理；没有有效模板或只能选到与上一条完全相同的发送文本时跳过。

`bili_reply` 的 `rpid=0` 表示视频评论，`rpid>0` 回复普通根评论。自动回复不选择置顶、非普通或缺少可靠元数据的对象。默认白名单只接收少量温和短反应，并非语义理解。

## AI 判断与撰写

频道配置：`aiJudgment` 默认关闭；`writingMode` 默认 `template`，可选 `ai`；`style` 最多 300 字符，仅用于 AI 撰写。关闭 AI 判断时写法和风格不生效。

### 模型配置与连接检查

一份全局配置保存在 SQLite `app_settings`，不再读取旧 `YUI_AI_*` 环境变量。模型 key 是本机私有明文，不在状态 API、活动或日志中回显。

- 根地址接受 HTTP / HTTPS，去掉末尾斜杠后只补一次 `/chat/completions`；不强插 `/v1`，拒绝 URL 中的账号密码、查询参数和片段。除本机假服务外应使用 HTTPS，以免 key 通过明文网络传输。
- 地址、模型名留空可清空；key 留空保留旧值，输入新值替换，勾选清空后删除旧 key。
- 表单保存期间禁用相关字段，避免迟到响应覆盖新输入；成功后按共用 schema 去除地址和模型名首尾空白并清空密码框，失败保留草稿。
- 连接检查使用已保存配置，仅发 `model` / `messages` 的最短请求；不调用 Bilibili、不写巡逻 Activity，不回传供应商正文。检查会产生服务商网络请求，可能计费。

### 配置变化的失败关闭

- 保存开启 AI 的频道前检查根地址、模型名和 key；缺项返回 **HTTP 409**，整次保存不创建、更新或禁用频道，不改变队列、全局设置或 Activity。
- 启动检查所有打开 AI 判断的频道（包括暂停频道）；缺配置则保持总调度器暂停。
- 已启用 AI 的频道运行中丢失配置时，在空闲 / 退避、异步返回和 claim 前复核；禁用该频道并跳过其队列，其他非 AI 频道继续运行。补齐后需手动重新启用。
- 成功切换 AI 判断开关时，同一 SQLite 事务将该频道旧待发队列标为 `skipped`，保留发现去重，不重新判断旧视频。被拒绝的保存不触发取消。

### 模型输入与输出

发现过滤和全局去重之后，对每个新视频最多判断一次。模型得到标题、UP 主、关键词和频道名，不读取字幕、弹幕或视频。返回 `action` / `reason`；不确定、失败或跳过仍持久去重，不补判、不回退概率分流。

正文在队列到期并通过初次额度和间隔检查之后才决定：

- 固定模板避开上一条完全相同的文本。
- AI 撰写不要求模板；回复时从安全候选选择 rpid。候选需普通、非置顶、有效 rpid、明确 UID 且不是自己，并通过本地文本检查；模型只收到候选 rpid 和正文，不收到 UID。
- 输出正文不合格、选择候选外对象、与上一条相同或无法选择时终结为 `skipped`；不重试、不留下 claim。

巡逻 Chat Completions 使用 `model` / `messages`、`temperature: 0.2`、`max_tokens: 4096`、`response_format: {"type":"json_object"}`；不发送供应商专用 `thinking` 字段。只读取 `choices[0].message.content`，忽略 `reasoning_content`。服务商与具体模型必须支持 JSON mode。

4096 是有界工程预算，不是短评长度或成功保证；有些模型将思考 token 计入该预算。供应商语义需按当前文档核查，参考 [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode) 和 [硅基流动 Chat Completions](https://docs.siliconflow.cn/docs/api/chat-completions-post)。

- 单次超时 **12 秒**，包括读响应；上限 **16 KiB**，不重试、不跟随重定向。
- 原因最多 80、正文最多 120 个 UTF-16 字符；`finish_reason` 非 `stop` 即跳过。
- 非 JSON、截断、无效 action / rpid、撰写对象多余字段均失败关闭；判断对象只取 action / reason，丢弃模型附带的草稿等字段。
- 提示词将标题、风格和评论视为不可信数据；模型没有额度、暂停、间隔、claim 或写锁权限。
- 本地 NFKC 词法检查拒绝控制 / 隐藏字符、链接 / 域名 / IP、邮箱、常见联系方式、广告、明显辱骂、危险内容和疑似凭据；检查原始输出及 JSON 解码后的字符串，阻断本次 key 的转义回显。规则保守但不是完整语义审核。

### 活动中的判断原因

原因仅本机显示，不发往 Bilibili。跳过原因没通过文本检查时，仍正常跳过并隐藏原原因；评论 / 回复决策的原因不过检，则按跳过处理。

只原样显示不超过 8 字的中文 / 英文词表命中词；数字、链接、@ 和长词组只显示类别。模型错误记录固定脱敏原因：HTTP 状态、超限、非 JSON、结构不符、未正常结束、空内容、疑似凭据、格式不符、超时或连接失败，不记录供应商正文或被拒文本。

## 登录保持与续期

推荐给本工具独立登录。若与日常浏览器共用同一登录会话，一方续期后可能让另一方失效。

- 扫码确认后同时读取 Set-Cookie 与轮询 URL；仅 `SESSDATA`、`bili_jct`、`DedeUserID` 齐全且 UID 合格时原子替换凭证，缺项保留原登录。二维码在内存生成。
- 扫码自动保存 `refresh_token` 为 `ac_time_value`；Cookie 登录可选填写该刷新令牌。格式无效时返回 400，不暂停或改动原登录。
- 登录有效性检查使用登录用户自身端点，而不是公开用户信息。
- 有刷新令牌时，桥接进程首次 / 新登录后、之后每 12 小时最多查询一次是否需刷新；需要时调用 SDK `check_refresh()` / `refresh()` 并原子保存新凭证。全局锁串行化续期与工具调用。
- 续期失败保留当前 Cookie，之后重试；状态只有 `current` / `renewed` / `failed` / `unsupported` 与时间，不含秘密。
- 调度器暂停时也在启动后及每 12 小时检查登录；检查失败 5 分钟后重试，但不会自动启动巡逻。
- 退出或重新登录先暂停并关闭旧 MCP 会话。强制下线、改密码和风控可能需要重新登录，不能保证自动续期一直成功。

扫码与续期依赖非官方 SDK 17.4.2 及平台接口；假服务回归不是真人确认或平台可用性保证。

## 最近评论与回执

总览只列最近 10 条 `succeeded` 评论 / 回复，不展示失败、不确定、排队或跳过。卡片含实际发送内容、已知回复对象和发现信息。

发送时已有的视频信息及返回响应提供封面、新 rpid 和播放 / 点赞 / 评论 / 收藏数据，不额外请求 Bilibili。可选回执字段异常只丢弃该字段，不将已成功发送判成失败。封面只接受 `*.hdslb.com` 并转换为 HTTPS，以 no-referrer 加载；有 rpid 时链接加 `#reply<rpid>`。旧记录缺回执时显示占位封面和发现时播放量，只链接到视频。

失败尝试和不确定结果可在活动页查看保存的发送内容、回复对象及脱敏原因。它们同样属于本机私有运行数据。

## Agent / MCP

Agent 使用 `bridge/server.py`，不要运行 vendored 原始入口或登录脚本。示例路径需换成自己的隔离 checkout，不要指向日常账号数据：

```json
{
  "mcpServers": {
    "yui-bilibili": {
      "command": "/your/isolated/checkout/.venv/bin/python",
      "args": ["/your/isolated/checkout/bridge/server.py"],
      "env": {
        "BILI_CREDENTIAL_FILE": "/your/isolated/checkout/data/config/bili_credential.json",
        "BILIBILI_WRITES_ENABLED": "false"
      }
    }
  }
}
```

注册工具如下；WebUI `/api/tools` 可检查实际列表：

`bili_login`、`bili_login_check`、`bili_check_credential`、`bili_search`、`bili_comments`、`bili_subtitle`、`bili_danmaku`、`bili_video_info`、`bili_reply`、`bili_crawl`、`bili_send_dynamic`、`bili_upload_video`、`bili_upload_video_multi`、`bili_send_opus`、`bili_video_zones`、`bili_hot_videos`、`bili_hot_buzzwords`、`bili_weekly_hot`、`bili_rank`、`bili_user_info`、`bili_user_videos`、`bili_favorite_lists`、`bili_favorite_content`、`bili_send_message`、`bili_unread_messages`、`bili_received_replies`、`bili_received_at_and_likes`。

自动队列仅使用 `bili_check_credential`、`bili_search`、`bili_comments`、`bili_reply`。其他工具用于手动 Agent；**手动调用不经过巡逻额度和队列**，所有写工具仍受桥接写开关约束。不要把启用真实写操作的 MCP 服务交给不可信 Agent。


## 模板文字复用（2026-10-15）

计划从入池时保存的模板快照中选择正文，不再排除与 `lastContent` 相同的候选。不同视频可使用同一文字，评论和回复可共享文字；只剩空模板或空白文字时，任务进入 `waiting_template`，事件原因为“没有可用模板”。`lastContent` 为兼容旧设置继续保存，但不参与发送放行判断。视频去重、发送前 claim、额度和互动间隔继续生效。

启动先持久化暂停状态，再以迁移版本 2 恢复旧规则阻塞的有效快照：最近一条 `template_wait` 原因为“没有可用且不重复的模板”，账号已绑定且归属一致，频道仍存在，计划未取消或孤立，且无已成功、在途、结果不确定或人工核查的发送尝试。评论和回复快照均通过非空文本校验后才恢复；损坏或缺失的快照仍需人工修复。

恢复只改变计划状态、必要的频道恢复状态和版本号，并追加 `template_repeat_recovered` 事件；原日期、周期、动作、快照、失败历史及 `next_prepare_at` 不变。频道暂停的计划仍保持 `paused_channel`，只将 `resume_state` 改为 `scheduled`。更新、事件与迁移标记在同一事务内提交，重复启动不再次恢复。迁移本身不发网络请求。


## 运行状态与倒计时（2026-10-16）

`/api/state` 返回 `serverNow`、`runtime` 和 `queue`。`runtime` 描述当前调度阶段、阶段开始时间、下一步动作、当前对象、请求是否在途、请求最长等待时间和暂停原因；`queue` 区分待处理、已到期、逾期、等待模板、频道暂停、发送中、结果不确定和人工核查计划。它们是只读展示数据，不改变搜索、分流、额度或发送顺序。

明确时间点使用服务端时间戳计算倒计时：频道 `nextSearch`、计划 `dueAt`、全局 `nextInteraction`、`retryAt` 和 `readRetryAt`。前端每秒刷新显示并在状态轮询时重新校准 `serverNow`。时间已过但任务未执行时显示逾期时长和原因，不显示负数倒计时。搜索、读取评论和发送请求没有可靠完成预估，界面显示已运行时间和 45 秒请求超时上限。

启动后的暂停、手动暂停、风控、未登录、写开关关闭和结果不确定均显示人工或暂停原因；暂停请求等待在途操作结束时显示“暂停中”。服务重启保持暂停，`claimed` 和 `uncertain` 计划不会被显示成普通待执行任务。
