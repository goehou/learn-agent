import { runProfile } from "../cli.js";
import { P14 } from "../core/profiles.js";

// 固定入口启用 P14 的持久 Cron 调度运行时。
process.exitCode = await runProfile(P14, process.argv.slice(2));
