// 固定为 P02，暴露文件工具但不接入后续权限与 Hook 能力。
import { runProfile } from "../cli.js";
import { P02 } from "../core/profiles.js";

process.exitCode = await runProfile(P02, process.argv.slice(2));
