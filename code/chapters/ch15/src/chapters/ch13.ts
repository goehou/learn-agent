import { runProfile } from "../cli.js";
import { P13 } from "../core/profiles.js";

// 固定入口启用 P13 后台任务事件运行时。
process.exitCode = await runProfile(P13, process.argv.slice(2));
