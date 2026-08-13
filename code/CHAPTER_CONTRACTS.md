# 逐章验收契约

本文件是每章教程文章与配套代码的验收对照表。每章状态必须在完成 `typecheck`、对应章节测试并阅读文章/源码后更新；不能只凭文件存在或导入成功标记完成。

| 章 | 能力 | 固定入口 | 验收要点 | 状态 |
|----|------|----------|----------|------|
| 1 | LOOP、POWERSHELL | `code/chapters/ch01/src/chapters/ch01.ts` | 有限回合 Agent Loop；PowerShell 工具；超时/截断/非零退出/审批拒绝回填为配对 tool result；length/content_filter 明确失败 | ✅ 审查通过 |
| 2 | TOOL_REGISTRY、FILES | `code/chapters/ch02/src/chapters/ch02.ts` | 四个文件工具；workspace 路径边界；原子写入；shell 保留 | ✅ 审查通过 |
| 3 | POLICY | `code/chapters/ch03/src/chapters/ch03.ts` | 结构化权限策略；显式审批；审计 | ✅ 审查通过 |
| 4 | HOOKS | `code/chapters/ch04/src/chapters/ch04.ts` | 生命周期 Hook；系统 deny 优先；结构化事件 | ✅ 审查通过 |
| 5 | TODO | `code/chapters/ch05/src/chapters/ch05.ts` | 会话 TODO；可恢复状态；工具依赖 | ✅ 审查通过 |
| 6 | SUBAGENT | `code/chapters/ch06/src/chapters/ch06.ts` | 子智能体入口；父/子上下文；一次性运行 | ✅ 审查通过 |
| 7 | SKILLS | `code/chapters/ch07/src/chapters/ch07.ts` | 受限 Skill 目录；按需加载；frontmatter | ✅ 审查通过 |
| 8 | ARTIFACTS、COMPACTION | `code/chapters/ch08/src/chapters/ch08.ts` | 完整消息组压缩；产物落盘；原子发布 | ✅ 审查通过 |
| 9 | MEMORY | `code/chapters/ch09/src/chapters/ch09.ts` | manifest 文件记忆；相关性选择；原子整理 | ✅ 审查通过 |
| 10 | DYNAMIC_PROMPT | `code/chapters/ch10/src/chapters/ch10.ts` | 动态系统提示；严格 JSON；完整缓存键 | ✅ 审查通过 |
| 11 | RECOVERY | `code/chapters/ch11/src/chapters/ch11.ts` | 截断恢复；prompt too long；429/529；fallback；取消与总时限 | ✅ 审查通过 |
| 12 | TASK_DAG_JSON | `code/chapters/ch12/src/chapters/ch12.ts` | JSON Task DAG；依赖校验；跨会话重建；原子认领 | ✅ 审查通过 |
| 13 | BACKGROUND、EVENT_INBOX | `code/chapters/ch13/src/chapters/ch13.ts` | 受管后台进程；持久终态；typed 事件；统一关闭 | ✅ 审查通过 |
| 14 | CRON | `code/chapters/ch14/src/chapters/ch14.ts` | 五段 Cron；显式时区；原子 outbox；触发重新授权 | ✅ 审查通过 |
| 15 | TEAMMATE、MAILBOX | `code/chapters/ch15/src/chapters/ch15.ts` | 持续队友；逐消息文件 mailbox；事件轮询；共享关闭 | ✅ 审查通过 |
| 16 | PROTOCOL、PLAN_GATE | `code/chapters/ch16/src/chapters/ch16.ts` | typed request/response；持久单次消费；优雅 shutdown；计划门控 | ✅ 审查通过 |
| 17 | TASK_DAG_SQLITE、WORK_STEALING | `code/chapters/ch17/src/chapters/ch17.ts` | 独立 SQLite store；稳定顺序；原子认领；claim token；半开 lease | ✅ 审查通过 |
| 18 | WORKTREE | `code/chapters/ch18/src/chapters/ch18.ts` | SQLite binding；统一 claim service；动态 cwd；安全清理；append-only 审计 | ✅ 审查通过 |
| 19 | MCP | `code/chapters/ch19/src/chapters/ch19.ts` | 本地 allowlist；Stdio client；原子注册/撤销；Registry Snapshot；故障清理 | ✅ 审查通过 |
| 20 | full_harness | `code/chapters/ch20/src/chapters/ch20.ts` | 同一组合根交叉验收；P1-P19 回归并集；动态上下文/MCP/资源关闭 | ✅ 审查通过 |

## 第 1 章验收记录

- 能力：`loop`、`powershell`
- 源码：`code/chapters/ch01/src/`
- 测试：`rtk npm run test:ch01`，6 个测试文件、29 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：文章中的 Loop 信号、消息配对、工具 schema、PowerShell 默认限制、审批 fail-closed、length/content_filter 失败路径均与实现一致

## 第 2 章验收记录

- 能力：`tool_registry`、`files`
- 源码：`code/chapters/ch02/src/`
- 测试：`rtk npm run test:ch02`，8 个测试文件、45 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：`shell, read_file, write_file, edit_file, glob` 顺序、严格输入 schema、workspace 路径边界、读文件体积上限、写文件 UTF-8 字节数、编辑只替换第一处、glob 相对路径均与实现一致

## 第 3 章验收记录

- 能力：`policy`
- 源码：`code/chapters/ch03/src/`
- 测试：`rtk npm run test:ch03`，10 个测试文件、60 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：权限四态 `allow/deny/ask/passthrough`、`deny > ask > allow > passthrough` 优先级合并、Shell 一律 `ask`、工作区硬边界优先、`confirm-file-write` 规则、仅 `y`/`yes` 审批、审计记录最终决定、审计失败拒绝执行均与实现一致

## 第 4 章验收记录

- 能力：`hooks`
- 源码：`code/chapters/ch04/src/`
- 测试：`rtk npm run test:ch04`，12 个测试文件、93 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：四个 Hook 事件、严格事件字段、注册顺序合并、PreToolUse 改写与阻断、PostToolUse 输出链式改写、`preventContinuation` 保持消息配对、Stop 最多续跑一次、系统 `deny` 优先于 Hook `allow` 均与实现一致

## 第 5 章验收记录

- 能力：`todo`
- 源码：`code/chapters/ch05/src/`
- 测试：`rtk npm run test:ch05`，14 个测试文件、107 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：`TodoTracker` 快照替换、`content` trim 后验证、ASCII 稳定 JSON、三轮陈旧提醒且仅注入当次请求、`todo_write` 不触发文件审批、会话隔离均与实现一致

## 第 6 章验收记录

- 能力：`subagent`
- 源码：`code/chapters/ch06/src/`
- 测试：`rtk npm run test:ch06`，16 个测试文件、117 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：`task` 严格输入、每次委派新 Runner/新工具注册表/新历史、父 history 只收最终结论、子工具无 `task`、30 轮上限与脱敏错误、共享权限/工作区/identity 均与实现一致

## 第 7 章验收记录

- 能力：`skills`
- 源码：`code/chapters/ch07/src/`
- 测试：`rtk npm run test:ch07`，18 个测试文件、143 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：frontmatter 边界、扫描只读元数据、目录排序与 UTF-8 byte 上限、`load_skill` 严格名称输入、加载时重新校验路径、父子工具差异、空目录精确提示语均与实现一致

## 第 8 章验收记录

- 能力：`artifacts`、`compaction`
- 源码：`code/chapters/ch08/src/`
- 测试：`rtk npm run test:ch08`，21 个测试文件、174 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 文章与代码对照：`30_000` bytes 单项落盘且严格 `>`、`200_000` bytes 批量预算、`2_000` bytes 头尾预览、`50_000` bytes 摘要阈值、snip 50 组保留头 3 组/尾 46 组、micro 保留最近 3 个工具组、prompt-too-long 保留最近 5 个完整组均与实现一致；P08 仅新增 `artifacts`/`compaction` 能力，不注册 `compact` 工具，Loop 未接入 prompt-too-long，`finishReason === "length"` 仍抛 `IncompleteModelReplyError`

## 第 9 章验收记录

- 能力：`memory`
- 源码：`code/chapters/ch09/src/`
- 测试：`rtk npm run test:ch09`，23 个测试文件、214 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：`MemoryStore` 使用 `proper-lockfile` 跨进程锁与进程内 Promise 尾链；manifest 是权威指针，`MEMORY.md` 从正文派生；`MemorySession.complete()` 使用完整 canonical history 提取并记录 `lastError`，失败不阻塞主任务；`keywordSelect` 中文 bigram、英文 token 长度不小于 3；manifest 原子发布失败时回滚索引并清理未提交文件

## 第 10 章验收记录

- 能力：`dynamic_prompt`
- 源码：`code/chapters/ch10/src/`
- 测试：`rtk npm run test:ch10`，25 个测试文件、226 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：固定 `identity -> tools -> workspace -> skills -> memory` 顺序；无工具时输出 `(none)`；严格 JSON context、按键排序缓存键；缓存覆盖所有模型可见输入；P10 关闭 `MemorySession` 独立消息注入，由动态 Prompt 单次输出选中记忆

## 第 11 章验收记录

- 能力：`recovery`
- 源码：`code/chapters/ch11/src/`
- 测试：`rtk npm run test:ch11`，28 个测试文件、258 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：结构化错误归一化、length 升级与续写、prompt-too-long 单次快照压缩、429/529/Retry-After/fallback、取消与总时限、未知错误不重试、P01-P10 保留 raw `ModelClient` 路径、subagent/memory/压缩摘要仍使用 raw model 均与实现一致

## 第 12 章验收记录

- 能力：`task_dag_json`
- 源码：`code/chapters/ch12/src/`
- 测试：`rtk npm run test:ch12`，31 个测试文件、271 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：五个严格工具 `create_task/get_task/list_tasks/claim_task/complete_task`、`pending/in_progress/completed` 三态与派生阻塞、canonical UUID 到文件名的单一映射、`blocked_by` 全图 DAG 校验、`JsonTaskStore` 使用 `proper-lockfile` 整图锁并在临界区内重读、claim owner 来自 `ToolContext.identity`、完成时只报告直接解锁集合、临时文件 `sync()` 后 `rename()` 原子发布、重建时校验文件名/ID/字段/依赖/环、Windows junction 逃逸拒绝、P12 必须有 `taskStore` 且 P11 传入 `taskStore` 失败均与实现一致

## 第 13 章验收记录

- 能力：`background`
- 源码：`code/chapters/ch13/src/`
- 测试：`rtk npm run test:ch13`，34 个测试文件、285 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、426 项测试通过（首轮出现一次 P20 worktree 时序 flake，单独重跑与全量复跑均通过），`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build`、`rtk npm run verify:snapshot-drift` 通过
- 文章与代码对照：P13 仅追加 `background`；主 Agent shell 增加 `run_in_background` 三态且标记 `background_eligible`，subagent 与 P01-P12 不暴露；显式标志优先于确定性关键词启发式；`EventInbox` 只接受 typed `RuntimeEvent` 并 FIFO 回传；新增 `query_background_job`、`cancel_background_job`，仅 P13 主 Agent 暴露；`JsonBackgroundJobStore` 位于 `.agent_tutorial/background`、使用 `.background.lock` 锁内读改写、canonical UUID 文件与原子替换；提交顺序为容量检查 -> 持久化 running -> worker；终态先落盘再发事件；超时/取消/关闭/重启中断；Loop 在模型请求前批量 drain/acknowledge 事件、按 `event_id` 去重并以带 `batch` 位置的普通 user 消息注入均与实现一致

## 第 14 章验收记录

- 能力：`cron`
- 源码：`code/chapters/ch14/src/`
- 测试：`rtk npm run test:ch14`，39 个测试文件、318 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：P14 仅追加 `schedule_cron`，无别名/list/cancel；输入严格为 `cron/prompt/timezone/recurring/durable`，`id/identity/nextRunAtUtc/lastSlotAtUtc` 由运行时生成或推进；五段表达式、IANA 时区、步进为零、反向范围和字段越界均显式失败；DOM/DOW 按 OR 语义；纽约 2026 DST gap/fold 的 UTC instant 固定；durable job 与 outbox 位于 `.agent_tutorial/cron/state.json`，session-only 只存内存；`.cron.lock` 保护快照读改写，`leader.lock` 选出唯一 durable scheduler；outbox 满时 job 不推进 `nextRunAtUtc`；one-shot 删除 job 但保留 event；先入 history 再 ack，ack 失败回滚；Cron event 与 background event 共享 `EventInbox` 且每次只消费一个；触发时用保存 identity 构造 `ToolContext` 并重新授权；`startManaged()` 注册受管 scheduler，关闭顺序 Cron -> supervisor -> model 均与实现一致

## 第 15 章验收记录

- 能力：`teammate`、`mailbox`
- 源码：`code/chapters/ch15/src/`
- 测试：`rtk npm run test:ch15`，44 个测试文件、335 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：P15 仅追加 `teammate`、`mailbox`；Lead 工具保留 P14 前缀并只在末尾追加 `spawn_teammate`、`send_message`，无 `check_inbox`；队友 Runner 只注册 `shell/read_file/write_file/send_message`，无 `edit_file`/`glob`/Task/Cron/spawn；每消息一个 `{uuid}.json`，状态 `ready -> processing -> done/quarantine`，数据位于 `.agent_tutorial/mailboxes/<agent>/...`；`(created_at_utc, id)` FIFO、processing 恢复、坏文件隔离、同 UUID 全局唯一、done 幂等 ack 需完整消息一致；TeammateRuntime 状态 `running/idle/failed/shutdown`，idle 复用同一 AgentRunner 且历史延续；Lead mailbox event 由显式 `runEvents()` 消费，普通 user turn 只暂存带 `idempotencyKey` 的事件；先追加 canonical history 再 ack，ack 失败重新发布且不重复 history/model；共享 EventInbox/JobSupervisor，关闭顺序 Teammate -> Cron -> supervisor -> model，失败继续清理并可重试 close；P15 不实现 request/response、计划门控、shutdown 握手和自驱找活均与实现一致

## 第 16 章验收记录

- 能力：`protocol`、`plan_gate`
- 源码：`code/chapters/ch16/src/`
- 测试：`rtk npm run test:ch16`，49 个测试文件、348 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：P16 严格等于 P15 加 `protocol`、`plan_gate`；Lead 工具只在 P15 末尾追加 `request_shutdown`、`review_plan`，队友工具为 `shell/read_file/write_file/send_message/submit_plan`，无 `request_plan` 别名；`ProtocolRequest` 使用规范 UUID、安全 Agent slug、aware UTC、5 分钟 `[created_at_utc, expires_at_utc)` 窗口和唯一 resolution；`ProtocolMailboxMessage` 独立于普通 `task/message/result`，request 的 `approved` 为 null、response 必须为布尔；先登记 `JsonProtocolStore` 再投递 Mailbox，发送失败保留 pending；响应校验 request ID、kind 配对、双方、pending 和有效期，同 transport message ID 幂等、不同 message ID 拒绝；Lead 先只读验证并 append history，再消费 ProtocolStore 并 ack transport；shutdown 在 worker 完成当前消息后不调用模型，发 approved response 后 ack；取消/存储/投递故障 release 可恢复消息，无效协议消息 quarantine；plan gate 作为 deny 规则只追加到队友策略，pending/rejected 时 effectful handler 和后台提交零调用，read/send_message/submit_plan 可用，approved 后仍保留原 approval/audit；最新计划按 store 锁内创建顺序判定，UUID 不参与授权先后；idle 事件驱动不轮询；bootstrap 校验 ProtocolRuntime 与 TeammateRuntime 共享同一 MailboxStore，P15 传 protocol 失败、P16 缺 protocol 失败；关闭顺序 Teammate -> Cron -> JobSupervisor -> model 均与实现一致

## 第 17 章验收记录

- 能力：`task_dag_sqlite`、`work_stealing`
- 源码：`code/chapters/ch17/src/`
- 测试：`rtk npm run test:ch17`，54 个测试文件、368 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：P17 严格等于 P16 加 `task_dag_sqlite`、`work_stealing`；Lead 与一次性 Subagent 注册五个 Task 工具，Teammate 注册四个且无 `create_task`；`complete_task` 必填 `task_id`/`claim_token`；SQLite 独立于 JSON task store，bootstrap 拒绝 P17 传入 JSON task store，CLI 只创建 `SqliteTaskStore`；`claimNext` 在 `BEGIN IMMEDIATE` 事务内先释放过期 lease、再按 `sequence` 选首个 ready 任务并条件 UPDATE 互斥；`completeTask` 校验 `in_progress`、owner、claim token 与半开 lease，过期返回 `TaskLeaseExpiredError`；`task_claim_tokens` 保存历史 token 且冲突整体回滚；Teammate idle loop 顺序为 Mailbox -> Protocol/plan gate -> SQLite claim -> polling，Protocol 未配置时 `configureWorkStealing` 失败；自动 claim 后以 token 作为 `AgentRunner.run()` idempotency key，模型仍需显式 `complete_task`；idle timeout 只增加计数并结束受管 poll，不生成 shutdown request/response/summary；文件 hardlink 逃逸、跨进程单成功认领、pending/rejected plan 零认领均有测试覆盖；文章“TaskClaim 显式携带 owner”按实现理解为 owner 随嵌套 `task.owner` 返回，`TaskClaim` 顶层字段为 `task/claimToken/leaseExpiresAtUtc`，不构成行为偏差

## 第 18 章验收记录

- 能力：`worktree`
- 源码：`code/chapters/ch18/src/`
- 测试：`rtk npm run test:ch18`，59 个测试文件、394 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：P18 严格等于 P17 加 `worktree`；`buildAgent` 强制 `WorktreeRuntime.store === WorkStealingRuntime.store` 且 `claimService === WorktreeRuntime`；手动 `claim_task` 要求 active binding 和 `executionScope`，自动认领只处理 active binding 的 ready task；resolve provider 在参数校验后、PreToolUse/权限/handler 前失败并返回 `tool_context_error`，有 claim 但错误/过期/身份不符时 fail closed；`worktree_events` 拒绝 UPDATE/DELETE，bindings 状态迁移与事件插入同事务；`createWorktree` 先 reserve 后 `git worktree add`，失败保留 reserved binding 和 pending Task；`keepWorktree` 显式保留已完成任务的 active binding；`removeWorktree` 只接受 completed task，且依次证明 registered path、clean status、integration ancestry 后 detach、`branch -d`、非强制 remove；清理失败时 active 转 `needs_review`，原 kept 或 needs_review 保持原状态；Subagent 传播当前 `context.claimToken`
- 审查修复：修正文章“Git add 失败”为“Git worktree add 失败”；为 `#needsReview` 增加 kept 守卫，并增补 kept binding 清理失败不升 `needs_review` 的测试

## 第 19 章验收记录

- 能力：`mcp`
- 源码：`code/chapters/ch19/src/`
- 测试：`rtk npm run test:ch19`，63 个测试文件、414 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、425 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build` 通过
- 文章与代码对照：`connect_mcp`/`disconnect_mcp` 与远程 `terminate` 均为 `EXTERNAL` 且终端行为 `ASK`；P19 权限规则只读取 `ToolDefinition.source` 与 `ToolDefinition.effect`；本地 allowlist、Stdio client、原子注册/撤销、Registry Snapshot、故障清理均与实现一致
- 审查修复：为 P19 profile 增加 `mcp-external-approval` ask 规则，匹配 `source.startsWith("mcp:") === true && effect === "external"`，并增补连接拒绝、远程 terminate 拒绝、断开拒绝三类审批测试

## 第 20 章验收记录

- 能力：`full_harness`
- 源码：`code/chapters/ch20/src/`
- 固定入口：`code/chapters/ch20/src/chapters/ch20.ts`
- 测试：`rtk npm run test:ch20`，65 个测试文件、426 项测试通过
- 静态检查：`rtk npm run typecheck` 通过
- 全仓门禁：`rtk npm test` 65 个测试文件、426 项测试通过，`rtk npm run lint`、`rtk npm run format:check`、`rtk npm run build`、`rtk npm run verify:snapshot-drift` 通过
- 文章与代码对照：`PROFILE_DELTAS` 末尾仅追加 `["full_harness"]`，`export const P20 = profileAt(20)`，`profileForChapter(20)` 返回 P20 固定对象；固定入口为 `runProfile(P20, process.argv.slice(2))`；运行时资源顺序 `JobSupervisor -> CronRuntime -> TeammateRuntime -> McpRuntime`，`AgentRunner.close()` 逆序关闭；`buildAgent(P20, ...)` 校验 Cron/Teammate/Protocol/Work stealing/Worktree/MCP 对象共享关系；P20 聚焦套件覆盖动态上下文、大 MCP 结果、typed Background/Cron event、恢复与单次压缩、Stop 续跑、持久状态重建、Teammate plan gate + Worktree claim 路由；新增固定入口测试覆盖有效配置下非 Git 根目录返回 `1`、关闭 `OpenAIChatModel`、且不创建 `.agent_tutorial`
- 审查修复：修正第 20 章文章固定入口与通用入口的绝对路径；将 P20 Profile 示例改为与实际 `PROFILE_DELTAS` 累计实现一致；快照漂移脚本基线由 P17 调整为 P18，P18 对 work-stealing 文件仅清理注释，P18-P20 源码与测试保持一致
