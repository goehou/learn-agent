import { runProfile } from "../cli.js";
import { P18 } from "../core/profiles.js";

// 固定入口启用 P18 的任务到 Git worktree 隔离运行时。
process.exitCode = await runProfile(P18, process.argv.slice(2));
