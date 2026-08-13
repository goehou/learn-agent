# Agent 教程领域语言

本文件定义教程运行时中容易混淆的领域词汇，使任务协作、执行隔离与清理决策使用同一套语言。

## Language

**项目任务（Project Task）**：
工作区内可持久恢复、可声明依赖并由一个执行者认领的工作单元。
_Avoid_：TODO、后台任务、Cron 任务

**任务认领（Task Claim）**：
执行者在有限租期内取得某个项目任务执行权的记录，以 claim token 证明当前所有权。
_Avoid_：任务绑定、任务分配

**受管 Worktree（Managed Worktree）**：
由运行时控制生命周期、用于隔离一个项目任务文件改动的 Git 工作目录及对应分支。
_Avoid_：workspace、clone、临时目录

**Worktree 预留（Worktree Reservation）**：
Git 创建完成前，对任务、名称、路径和分支组合建立的持久唯一占位。
_Avoid_：任务认领、Worktree 绑定

**Worktree 绑定（Worktree Binding）**：
一个项目任务与一个受管 Worktree 之间的持久关联；它独立于任务状态，不代表任务已被认领或完成。
_Avoid_：任务认领、当前工作目录

**集成引用（Integration Ref）**：
调用方明确指定的 Git 引用；只有其当前提交包含 Worktree 分支顶端时，运行时才允许自动清理。
_Avoid_：upstream、push ref、默认分支

**执行上下文（Execution Context）**：
运行时为一次工具执行解析出的可信作用域，包含执行者、工作目录以及当前任务认领信息。
_Avoid_：进程 cwd、Prompt 上下文

**需要审查（Needs Review）**：
运行时无法证明自动清理安全或无法完成清理时使用的 Worktree 生命周期状态；相关资源必须保留供人工处理。
_Avoid_：失败后删除、强制清理

**MCP Server Alias**：
本地 allowlist 中代表一个 MCP Server 及其可信策略的稳定名称。
_Avoid_：远程 server name、任意命令

**MCP Connection**：
一个 MCP Server Alias 当前已初始化且仍存活的协议会话。
_Avoid_：工具注册表、进程句柄

**Published MCP Tool**：
MCP Server 通过协议发布的远程工具声明；名称、描述、schema 与结果均属于外部数据。
_Avoid_：内置工具、本地授权

**MCP Tool Policy**：
本地为一个 Published MCP Tool 指定的可信 effect classification。
_Avoid_：远程 description、远程 readOnly 标注

**Exposed MCP Tool**：
Published MCP Tool 经 Server Alias、名称隔离与 MCP Tool Policy 转换后进入本地工具池的能力。
_Avoid_：Published MCP Tool、原始远程名称

**Registry Snapshot**：
一次模型请求及其对应回复共同使用的不可变工具集合。
_Avoid_：实时工具池、启动时静态列表
