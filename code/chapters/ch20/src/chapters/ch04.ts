// 固定入口以 P04 运行，启用 Hook 生命周期。
import { runProfile } from "../cli.js";
import { P04 } from "../core/profiles.js";

process.exitCode = await runProfile(P04, process.argv.slice(2));
