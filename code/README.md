# Agent 教程配套代码

本目录提供第 1-20 章逐章累进的 OpenAI Agent。每个 `chapters/chNN/` 均包含截至该章的完整 `src/` 源码快照和 `tests/` 离线测试；固定 npm 脚本运行相应章节，`npm test` 运行最新的 P20 累积回归。架构和逐章验收分别见 `ARCHITECTURE.md`、`CHAPTER_CONTRACTS.md`。

## 环境

```powershell
Set-Location 'F:\笔记\Agent实操\code'
rtk npm ci
```

确保 `code/.env` 已存在；若仓库提供 `.env.example` 则可复制为 `.env`，否则直接创建。填写以下配置：

```dotenv
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model
```

`OPENAI_BASE_URL` 应是不含 `/chat/completions` 的 OpenAI 兼容地址。第 11 章起还需填写 `OPENAI_FALLBACK_MODEL`。

## 运行

```powershell
rtk npm run ch01 -- --prompt "运行 Write-Output 42，并告诉我结果"
rtk npm run ch02 -- --prompt "读取 package.json，并列出 chapters/ch02/src/**/*.ts"
rtk npm run ch03 -- --prompt "读取 README.md，然后写入 chapter3-note.txt"
rtk npm run ch04 -- --prompt "读取 README.md 并概括运行方式"
rtk npm run ch05 -- --prompt "先建立完整 TODO，再读取 README.md 并总结运行和验证步骤"
rtk npm run ch06 -- --prompt "调用 task 独立检查本项目使用的测试框架，只返回有文件证据的结论"
rtk npm run ch07 -- --prompt "先调用 load_skill 加载 typescript-style，再总结其中两条约定"
rtk npm run ch08 -- --prompt "读取一个大文件并总结，观察完整结果落盘后的路径与预览"
rtk npm run ch09 -- --prompt "记住：本项目的示例只使用 PowerShell"
rtk npm run ch10 -- --prompt "列出当前 Agent 的可用工具"
rtk npm run ch11 -- --prompt "检查当前工作区并给出结论"
rtk npm run ch12 -- --prompt "建立 schema、endpoints、tests 和 docs 的任务依赖"
rtk npm run ch13 -- --prompt "后台运行 npm install，同时读取 README.md；拿到结果后再总结"
rtk npm run ch14 -- --prompt "每天上海时间 9 点检查 CI，周期执行并持久化"
rtk npm run ch15 -- --prompt "创建一名 writer 队友，让她阅读 README 并汇报缺口"
rtk npm run ch16 -- --prompt "创建一名 writer 队友，让她先提交计划，批准后执行并优雅关闭"
rtk npm run ch17 -- --prompt "调用 task 独立检查本项目使用的测试框架，只返回有文件证据的结论"
rtk npm run ch18 -- --prompt "创建两个任务并绑定独立 Worktree，再启动 alice 和 bob 分别认领"
rtk npm run ch19 -- --prompt "先连接 demo_alpha 和 demo_beta，下一轮分别调用 lookup 查询 needle，再断开 demo_alpha"
rtk npm run ch20 -- --prompt "验证完整 Harness 的动态上下文、MCP 边界和资源关闭"
rtk npm run agent-tutorial -- run --chapter 1 --prompt "运行 Write-Output 42，并告诉我结果"
rtk npm run agent-tutorial -- run --chapter 2 --prompt "读取 package.json，并列出 chapters/ch02/src/**/*.ts"
rtk npm run agent-tutorial -- run --chapter 3 --prompt "读取 README.md，然后写入 chapter3-note.txt"
rtk npm run agent-tutorial -- run --chapter 4 --prompt "读取 README.md 并概括运行方式"
rtk npm run agent-tutorial -- run --chapter 5 --prompt "先建立完整 TODO，再读取 README.md 并总结运行和验证步骤"
rtk npm run agent-tutorial -- run --chapter 6 --prompt "调用 task 总结 chapters/ch06/src/core 目录职责，再由父 Agent 给出结论"
rtk npm run agent-tutorial -- run --chapter 7 --prompt "调用 load_skill 加载 typescript-style，再概括关键约定"
rtk npm run agent-tutorial -- run --chapter 8 --prompt "读取一个大文件并总结，观察完整结果落盘后的路径与预览"
rtk npm run agent-tutorial -- run --chapter 9 --prompt "这个项目的命令示例有什么约束？"
rtk npm run agent-tutorial -- run --chapter 10 --prompt "列出当前 Agent 的可用工具"
rtk npm run agent-tutorial -- run --chapter 11 --prompt "检查当前工作区并给出结论"
rtk npm run agent-tutorial -- run --chapter 12 --prompt "列出当前项目任务并认领一个 ready 任务"
rtk npm run agent-tutorial -- run --chapter 13 --prompt "后台运行 npm install，同时读取 README.md；拿到结果后再总结"
rtk npm run agent-tutorial -- run --chapter 14 --prompt "每天上海时间 9 点检查 CI，周期执行并持久化"
rtk npm run agent-tutorial -- run --chapter 15 --prompt "创建一名 writer 队友，让她阅读 README 并汇报缺口"
rtk npm run agent-tutorial -- run --chapter 16 --prompt "创建一名 writer 队友，让她先提交计划，批准后执行并优雅关闭"
rtk npm run agent-tutorial -- run --chapter 17 --prompt "调用 task 独立检查本项目使用的测试框架，只返回有文件证据的结论"
rtk npm run agent-tutorial -- run --chapter 18 --prompt "创建两个任务并绑定独立 Worktree，再启动 alice 和 bob 分别认领"
rtk npm run agent-tutorial -- run --chapter 19 --prompt "先连接 demo_alpha 和 demo_beta，下一轮分别调用 lookup 查询 needle，再断开 demo_alpha"
rtk npm run agent-tutorial -- run --chapter 20 --prompt "验证完整 Harness 的动态上下文、MCP 边界和资源关闭"
```

第 1-20 章均提供固定 TypeScript 入口。第 1 章提供基础 Loop 和 PowerShell；第 2 章增加受 workspace 边界保护的文件工具；第 3 章增加结构化权限、显式审批和审计；第 4 章增加四类结构化生命周期 Hook；第 5 章增加会话 TODO；第 6 章增加一次性子智能体；第 7 章增加受限目录与按需 Skill；第 8 章增加上下文压缩与工具产物；第 9 章增加基于 manifest 的文件记忆、相关性选择和原子整理；第 10 章增加动态 Prompt；第 11 章增加输出截断、输入过长、429/529、fallback、取消与总时限恢复；第 12 章增加 workspace 级 JSON Task DAG、依赖校验、跨会话重建和原子认领；第 13 章增加受管后台 PowerShell job、持久终态、typed EventInbox 和统一资源关闭；第 14 章增加五段 Cron、显式时区、durable 原子 outbox、触发时重新授权和受管 scheduler；第 15 章增加持续 Teammate、每消息一文件的持久 Mailbox、独立 Runner history、显式 event turn 和共享运行时关闭；第 16 章增加 typed request/response 协议、持久单次响应消费、优雅 shutdown 路由和工具执行硬计划门控；第 17 章把 Task DAG 切换到独立 SQLite store，增加稳定顺序、原子 work stealing、claim token、半开 lease、协议优先和有界 idle polling；第 18 章增加 SQLite Worktree binding、统一 Task claim service、逐工具动态 cwd、非强制 Git 清理和 append-only 审计；第 19 章增加官方 MCP stdio client、allowlist、精确本地工具策略、原子动态注册、请求级 Registry Snapshot 和故障撤销；第 20 章不新增第二套 Loop，以 `full_harness` 标记同一组合根的跨能力整合验收。

第 18 章起必须从一个 Git 仓库根目录运行。第 20 章固定入口验证完整组合根；运行章节时必须在保留目标仓库 cwd 的前提下从教程代码目录解析 npm 依赖。

```powershell
$TutorialCode = 'F:\笔记\Agent实操\code'
Set-Location 'C:\workspace\my-agent-project'
rtk npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch18/src/chapters/ch18.ts" --prompt "创建两个任务并绑定独立 Worktree，再启动 alice 和 bob 分别认领"
rtk npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch20/src/cli.ts" run --chapter 18 --prompt "创建两个任务并绑定独立 Worktree，再启动 alice 和 bob 分别认领"
rtk npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch19/src/chapters/ch19.ts" --prompt "先连接 demo_alpha 和 demo_beta，下一轮分别调用 lookup 查询 needle，再断开 demo_alpha"
rtk npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch20/src/cli.ts" run --chapter 19 --prompt "连接 demo_alpha，调用 lookup 查询 needle，然后断开"
rtk npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch20/src/chapters/ch20.ts" --prompt "验证完整 Harness 的动态上下文、MCP 边界和资源关闭"
rtk npm exec --prefix $TutorialCode -- tsx "$TutorialCode/chapters/ch20/src/cli.ts" run --chapter 20 --prompt "验证完整 Harness 的动态上下文、MCP 边界和资源关闭"
```

目标仓库根目录需要自己的 `.env`，并应把 `.agent_tutorial/` 和 `.env` 加入 `.gitignore`。第 19 章只允许连接内置 `demo_alpha`、`demo_beta`；连接、断开和远程 `terminate` 都需要终端审批。

## 验证

```powershell
rtk npm run typecheck
rtk npm test
rtk npm run lint
rtk npm run format:check
rtk npm run build
```
