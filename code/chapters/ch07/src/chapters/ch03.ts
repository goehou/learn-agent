// 固定章节入口选择包含 policy 的 P03 profile。
import { runProfile } from "../cli.js";
import { P03 } from "../core/profiles.js";

process.exitCode = await runProfile(P03, process.argv.slice(2));
