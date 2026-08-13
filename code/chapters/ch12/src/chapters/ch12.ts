import { runProfile } from "../cli.js";
import { P12 } from "../core/profiles.js";

// 固定入口启用 P12 的持久任务 DAG 工具。
process.exitCode = await runProfile(P12, process.argv.slice(2));
