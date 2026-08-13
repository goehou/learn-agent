import { runProfile } from "../cli.js";
import { P02 } from "../core/profiles.js";

// 固定为 P02，暴露文件工具与工具注册表，但跳过第 3 章的权限策略能力。
process.exitCode = await runProfile(P02, process.argv.slice(2));
