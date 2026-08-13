# 教程智能体架构

> 实现状态：第 1 至第 20 章分别使用 `code/chapters/chNN/src/**/*.ts` 与 `code/chapters/chNN/tests/**/*.test.ts`。每个 `chNN` 是截至该章的完整可运行快照；本文下方的领域契约是语言无关的唯一规格。

## 目标与边界

本目录实现 20 个逐章累进、可独立运行的智能体。每章只增加一个明确能力，后章保留前章全部可观察行为。第 20 章使用同一个循环整合全部能力。

运行时直接使用 OpenAI TypeScript SDK 的 Chat Completions API，不依赖 LangChain、LangGraph 或 Deep Agents。原因不是这些框架能力不足，而是它们会隐藏本教程需要展示的 Agent Loop、OpenAI 工具消息配对、权限、Hook、压缩和协作协议。迁移中的后续章节保持同一领域边界：MCP、Cron、跨平台锁、参数 schema 和 SQLite 均只在对应适配器边界接入。

Shell 不是沙箱。真实命令在执行前必须经过运行时权限和显式审批；工作目录限制只约束起始目录，不能被描述成操作系统隔离。

## TypeScript 与依赖

- Node.js：`>=20.12`
- TypeScript：`7.0.2`
- 模型：`openai@7.0.0`
- 参数模型：`zod@4.4.3`
- Skill 与 Memory frontmatter：`yaml@2.9.0`
- 跨进程文件锁：`proper-lockfile@4.1.2`
- 配置：`dotenv@17.2.3`
- MCP transport/client：`@modelcontextprotocol/sdk@1.30.0`
- MCP JSON Schema 校验：`ajv@8.20.0`
- 测试与静态检查：`vitest@4.1.10`、`@biomejs/biome@2.5.6`

第 1 章的精确版本由 `package-lock.json` 决定；后续章节新增依赖时必须同步更新该锁文件。

## 配置契约

真实运行只接受 `.env` 中的显式 OpenAI 配置：

```dotenv
OPENAI_BASE_URL=
OPENAI_API_KEY=
OPENAI_MODEL=
OPENAI_FALLBACK_MODEL=
```

前三项在所有章节都必填。第 11 章起，`OPENAI_FALLBACK_MODEL` 必填。不得内置模型名、API Key、供应商或请求地址默认值。测试从构造函数注入 `ScriptedModelClient`，不读取真实凭据、不访问网络。

## 目录

```text
code/
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.build.json
  biome.json
  .env.example
  README.md
  ARCHITECTURE.md
  CHAPTER_CONTRACTS.md
  chapters/
    ch01/
      src/
        bootstrap.ts
        cli.ts
        config.ts
        chapters/ch01.ts
        core/
        features/
        adapters/
      tests/
        fakes.ts
        *.test.ts
    ... ch20/
      src/
        bootstrap.ts
        cli.ts
        config.ts
        chapters/ch01.ts ... ch20.ts
        core/
        features/
        adapters/
        mcp-servers/
      tests/
        fakes.ts
        fixtures/
        *.test.ts
```

每个 `chNN` 都是截至该章的完整 TypeScript 快照；后续章节在自己的目录内累计此前能力。快照内依赖方向为 `chapters -> bootstrap -> core/features -> domain contracts`。`adapters` 实现 core/features 定义的接口。core 不导入 OpenAI、MCP、章节模块或具体持久化实现。

## 核心类型

### 模型与消息

- `ChatMessage`：不可变内部消息；只允许合法 role/字段组合。
- `ToolCall`：`id`、`name`、原始 JSON arguments。
- `MessageGroup`：一条普通消息，或一条 assistant tool-call 消息和它的全部 tool results。压缩只能移动或替换完整组。
- `ModelRequest`：消息快照、工具 schema、模型、输出预算。
- `ModelReply`：assistant 消息、`finishReason`、usage。
- `ModelClient.complete(request, signal?) -> Promise<ModelReply>`：唯一模型接口；P11 将同一 `AbortSignal` 传给模型边界，以便取消或总时限触发后等待请求收束。

OpenAI SDK 对象只存在于 `adapters/openai-chat.ts`。适配器立即转成内部类型。模型工具 arguments 先解析为 JSON object，再由 Zod strict schema 验证；失败在副作用前变成相同 `tool_call_id` 的结构化工具错误。

### 工具与执行

- `ToolDefinition`：同一对象持有 name、description、Zod 输入 schema、handler、effect class、并发分类和来源。
- `ToolRegistry`：从 `ToolDefinition` 同时生成 OpenAI schema 与 dispatch snapshot，消除平行表漂移。
- `ToolContext`：不可变 workspace、identity、task/worktree、idempotency key 与 execution scope。
- `ToolResult`：content、error code、artifact、metadata。
- `ApprovalProvider.decide(request) -> decision`：CLI 人工审批和测试替身的边界。

### 生命周期与状态

- `AgentRunner` 是 canonical history、工具轮次和 Stop 续跑状态的唯一写者；TODO、记忆等 feature 各自封装会话状态。
- `RecoveryManager` 是当前用户 turn 的 `RecoveryState` 唯一写者；它只在 `ModelRequestExecutor` 内重试单个逻辑模型请求，不改 canonical history。
- `HookRegistry` 按注册顺序运行结构化 `HookResult`；系统 deny 的优先级始终高于 Hook allow。
- `EventInbox` 只传递 typed `RuntimeEvent`。BackgroundJob、CronJob、Task、MailboxMessage、ProtocolMailboxMessage 各自建模，不共享含混状态字典；ProtocolRequest 独立保存在协议状态机中。
- `Clock`、`Sleeper`、`IdGenerator` 均可注入，禁止依赖测试中的真实 sleep、随机数或墙钟。
- 所有异步任务由 `JobSupervisor` 跟踪并在关闭时 await/cancel；禁止无人持有的 detached Promise。组合根关闭时逆序尝试全部资源，单个异常原样抛出，多个异常分组，失败状态允许重试关闭。

## 统一循环顺序

```text
UserPromptSubmit Hook
-> TurnLifecycle.beginTurn / select relevant memory
-> drain typed events
-> prepare context / preserve transcript / compact complete message groups
-> TurnLifecycle.beforeModel / P09 inject ephemeral memory context
-> SystemPromptProvider.render / P10 renders current tools, workspace, Skill catalog, and selected memory
-> assemble current system prompt and immutable tool snapshot
-> ModelRequestExecutor.complete / P11 retries one logical request without re-entering Loop
-> resilient OpenAI model call
-> append normalized assistant message
-> for every tool call:
     parse + validate
     -> resolve trusted ToolContext
     -> PreToolUse Hook
     -> hard permission policy / approval
     -> dispatch or background submission
     -> PostToolUse Hook
     -> append exactly one matching tool result
-> no tool calls: Stop Hook, at most one forced continuation
-> TurnLifecycle.complete(canonical history)
-> final answer / typed failure / cancellation
```

一个 assistant 消息中的多个工具调用必须全部得到且只得到一个相同 ID 的 tool result。任何错误、拒绝、超时或未知工具都不能破坏该配对。

## ChapterProfile

`ChapterProfile` 使用固定 `Capability` 集合，不允许任意布尔组合。`P[n] = P[n-1] + delta[n]`，测试断言每章只增加下列能力：

| 章 | 新增 Capability |
|----|-----------------|
| 1 | LOOP、POWERSHELL |
| 2 | TOOL_REGISTRY、FILES |
| 3 | POLICY |
| 4 | HOOKS |
| 5 | TODO |
| 6 | SUBAGENT |
| 7 | SKILLS |
| 8 | ARTIFACTS、COMPACTION |
| 9 | MEMORY |
| 10 | DYNAMIC_PROMPT |
| 11 | RECOVERY |
| 12 | TASK_DAG_JSON |
| 13 | BACKGROUND、EVENT_INBOX |
| 14 | CRON |
| 15 | TEAMMATE、MAILBOX |
| 16 | PROTOCOL、PLAN_GATE |
| 17 | TASK_DAG_SQLITE、WORK_STEALING |
| 18 | WORKTREE |
| 19 | MCP |
| 20 | full_harness |

20 个章节模块只调用 `runProfile(Pxx)`，不复制循环。每章保留独立累计快照；共享能力的后续修复必须回灌到引入章及其后续章节，并由 `npm run verify:snapshot-drift` 校验已登记的同步快照。

## 持久化演进

运行数据位于所选 workspace 的 `.agent_tutorial/`；第 9 章长期记忆单独位于 `.memory/`。所有路径在解析后必须仍位于 workspace。

- 第 8 章：大工具结果和完整 transcript 使用 UTF-8 文件、唯一 ID、临时文件同步与独占原子发布；冲突不覆盖现有产物。
- 第 9 章：`.memory/*.md` + YAML；`manifest.json` 是当前集合的权威指针，`MEMORY.md` 只是有界派生目录。写入先独占创建并回读验证新文件，再替换目录和 manifest；manifest 失败时恢复旧目录并清理未提交文件。整理在模型返回后重新加锁读取当前 manifest，保留未参与记录与并发新增记录，提交成功后才清理旧源文件。
- 第 12-16 章继续使用 `.tasks/{uuid}.json` 保存 Task DAG；一个跨平台排他文件锁包住全图校验、条件认领和原子文件替换。
- 第 13 章：后台 job 状态持久化；重启后遗留 running 变成 interrupted，不盲目重放未知副作用。
- 第 14 章：`CronRuntime` 只负责 tick、投递和唤醒；`JsonCronStore` 将 Cron 定义、next run、pending event 和幂等 slot 一次原子保存。时间以 UTC ISO 字符串持久化，`cron-parser` 与 IANA 时区负责本地转换；scheduler 由共享 `JobSupervisor` 持有并按 Cron -> Supervisor 顺序关闭。
- 第 15 章：每消息一个文件，目录状态为 ready/processing/done/quarantine；claim/ack 用原子 rename，不使用 read 后 unlink。processing 已被另一 runtime 完成时，相同 done 消息可幂等 ack，内容冲突明确失败。
- 第 16 章：`.agent_tutorial/protocol/state.json` 是带版本的单一请求快照；排他文件锁内保留创建顺序并原位迁移响应，写入使用文件同步加同目录原子替换。请求先登记再通过 typed Mailbox 发送；响应验证 ID、类型、双方、pending 和半开有效期，只迁移一次。同 transport ack 重试幂等，不同 message ID 的重复响应拒绝。
- 第 17 章：`TaskStore` 接口切换到独立的 `.agent_tutorial/tasks.sqlite3`。`BEGIN IMMEDIATE`、数据库 `sequence`、条件更新、owner、claim token 和半开 lease 解决稳定选择、多进程竞争与旧 worker 完成问题；token 历史在数据库生命周期内唯一，碰撞回滚整个 claim。P17 不迁移、不读取也不双写第 12-16 章 JSON backend。
- 第 18 章：同一个 `tasks.sqlite3` 增加 `worktree_bindings` 当前快照和 append-only `worktree_events`。Binding 状态机为 `reserved -> active -> kept|needs_review|removed`，以及 `kept|needs_review -> removed`；它与 Task 状态独立。创建先在一个 SQLite 事务写 reservation/event，再执行 Git，验证成功后用第二个事务迁移 active/event；Git 创建失败保留 reserved binding 和 pending Task。自动和手动认领共用 `TaskClaimService`，P18 的 `claim_next_bound` 跳过未绑定 Task。

P16 的计划门控通过 `PermissionPolicy.withRules()` 组合到 Teammate，不替换既有 approval/audit。最新计划为 pending/rejected 时，effectful handler 与后台提交均为零调用；read、`send_message`、`submit_plan` 保持可用；approved 计划仍需通过原有工作区和人工审批规则。协议 mismatch/state 消息隔离，存储、投递和取消故障 release transport 后显式失败。

P17 的 Teammate idle loop 在同一 registry lock 内先处理 Mailbox/typed Protocol，再查询最新计划，最后才调用 SQLite `claim_next`。自动 claim token 同时作为该次 Runner 的 idempotency key 和显式 claim token；前者保留事件幂等语义，后者供 Worktree provider 区分 claim 与普通 runtime event。模型仍须显式调用带 token 的 `complete_task`。默认 5 秒轮询、12 次上限均可注入测试替身；timeout 只增加可观察计数并保留 `idle`，不伪造 shutdown request、response 或 summary。Lead、Subagent 与 Teammate 必须共享同一个 `WorkStealingRuntime` 和 SQLite store。

P18 要求 `WorktreeRuntime` 与 `WorkStealingRuntime` 共享同一个 SQLite store，且前者是后者唯一的 claim service。手动 claim 把 token 绑定到当前 execution scope；自动 claim 把 token 同时作为 Runner idempotency key 和显式 claim token。Lead、Teammate 与 Subagent 使用同一个 `ToolContextProvider`，每项已验证的工具调用都在 PreToolUse、权限和 handler 前重新解析 identity、Task、claim、binding 和 cwd。失效 token、owner/task 不一致或受控路径外逃形成配对 `tool_context_error`，handler 零调用且不得回落主 workspace。只有 Lead 注册 `create_worktree`、`keep_worktree`、`remove_worktree`。

消息和 Cron 投递采用至少一次 + 稳定事件 ID 去重。外部副作用必须传播 idempotency key；存储事务不能把任意外部动作变成恰好一次。

## Worktree 安全

- 所有工具接收不可变 `ToolContext`，禁止进程级 `chdir()`。Provider 只能在受控仓库根目录内选择真实目录，且不得改变 identity、idempotency key 或 execution scope。
- 固定分支为 `wt/{name}`，固定相对路径为 `.agent_tutorial/worktrees/{name}`；名称复用安全 lowercase Agent slug，`integration_ref` 必须是显式安全的 `refs/...`。
- 创建先解析 integration ref 为 baseline commit，再持久 reserve，随后以参数数组执行 `git worktree add -b`；不得经过 shell。创建失败保留 reservation，不推进 Task。
- `keep_worktree` 与 `remove_worktree` 都要求 Task completed。清理前验证受控路径、登记的 repository root/common dir/branch、clean 状态，并把 branch tip 与 integration ref 分别解析为不可变 commit ID，再验证 integration commit 包含 branch tip。
- 清理顺序固定为 detach、`git branch -d`、非强制 `git worktree remove`。禁止以 `@{push}` 判断集成，禁止 `git branch -D`、`git worktree remove --force` 或公开 discard 开关。
- 任一检查、Git 非零或进程异常都停止自动清理；active binding 转 `needs_review`，kept/needs_review 维持保留态；不向模型泄露 Git stderr。Binding 迁移与 event insert 同事务，审计表的 update/delete 由 trigger 拒绝。
- 当前教程根目录不是 Git 仓库；真实第 18 章起入口必须在创建运行状态前清晰失败，测试使用临时 Git 仓库。

## MCP 边界

`McpRuntime` 只连接本地配置的 allowlist alias；模型不能提交 command、args 或 cwd：

```text
StdioClientTransport
-> Client.connect
-> listTools / callTool
```

每个 connection 由独立 owner 生命周期持有 transport 与 client，通过队列串行执行 list、call 和 close，避免并发关闭打乱 transport 退出顺序。调用方取消必须原样传播；Runner 关闭统一回收 runtime、connection 和子进程。

Published 工具必须与本地 `McpToolPolicy` 精确匹配。工具命名 `mcp__{alias}__{normalized_tool}`，规范化碰撞、无效或外部 reference schema、与现有 registry 冲突都会拒绝整次 connection。JSON Schema 使用本地校验器在 handler 前校验，并原样公开已验证 schema。远端 name、description、schema、result、stderr 和错误均是不可信数据；权限只依据本地 effect class，不解析 `(readOnly)` 文本。

`ToolRegistry.registerMany()` / `unregisterMany()` 是原子版本迁移。每次模型请求获取不可变 Registry Snapshot，请求中的 tools 与对应回复的全部调用复用同一快照，因此连接后的新工具只能在下一次模型请求出现。正常断开只撤销对应 alias；超时、进程退出和 transport failure 原子撤销该 alias 全部工具，远程业务错误则保留健康 connection。MCP 管理工具和远程工具只安装到 Lead，不进入 Subagent 或 Teammate 的裁剪 registry。

## 第 20 章整合边界

`full_harness` 不是新的运行时功能，也不创建第二个 orchestrator。它是 P1-P19 全部 Capability 已由同一个 `buildAgent()`、同一个 `AgentRunner` 和同一组共享资源完成交叉验收的固定 marker。生产代码只需接受 P20 profile 并提供 `chapters/ch20.ts` 固定入口；整合测试必须从 `buildAgent(P20, BuildDependencies(...))` 进入，不能绕过组合根直接拼装平行 Loop。

P20 直接验证动态 Prompt、Hook、硬权限、Registry Snapshot、MCP 和资源所有权在同一会话中同时成立；Task/Protocol/Worktree、Background/Cron typed event、Recovery/Compaction、Stop 单次续跑和重建语义还必须继续通过各引入章的累积回归。P20 的完成证据是专项交叉测试与 P1-P19 全量回归的并集，不能用对象存在、导入成功或单个最终文本替代。

## 完成边界

- 不以导入成功、对象存在、非空值或 mock handler 被调用替代业务断言。
- 真实 OpenAI 冒烟只在四项配置齐全时运行；没有凭据时标记 `Blocked, not run`，不影响离线行为验证的真实性。
- 不能把 Shell 工作目录限制、字符串黑名单、Prompt 指令或 MCP description 描述成安全边界。
