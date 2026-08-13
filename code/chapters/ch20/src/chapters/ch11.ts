import { runProfile } from "../cli.js";
import { P11 } from "../core/profiles.js";

// 固定入口启用 P11 的模型请求恢复边界。
process.exitCode = await runProfile(P11, process.argv.slice(2));
