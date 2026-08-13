// 固定章节入口：使用 P04 profile 启动，启用 Hook 生命周期。
import { runProfile } from "../cli.js";
import { P04 } from "../core/profiles.js";

process.exitCode = await runProfile(P04, process.argv.slice(2));
