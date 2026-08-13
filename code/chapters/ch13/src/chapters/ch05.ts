import { runProfile } from "../cli.js";
import { P05 } from "../core/profiles.js";

// 固定入口启用 P05 的 TODO 计划能力。
process.exitCode = await runProfile(P05, process.argv.slice(2));
