import { runProfile } from "../cli.js";
import { P16 } from "../core/profiles.js";

// 固定入口启用 P16 的计划审批协议与执行门控。
process.exitCode = await runProfile(P16, process.argv.slice(2));
