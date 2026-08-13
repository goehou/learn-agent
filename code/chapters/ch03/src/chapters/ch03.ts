import { runProfile } from "../cli.js";
import { P03 } from "../core/profiles.js";

// 固定章节入口选择 policy 能力，组合根将据此注入审批、审计和工作区写边界。
process.exitCode = await runProfile(P03, process.argv.slice(2));
