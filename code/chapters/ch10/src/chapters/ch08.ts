import { runProfile } from "../cli.js";
import { P08 } from "../core/profiles.js";

// 固定入口启用 P08 的 artifact 与上下文压缩能力。
process.exitCode = await runProfile(P08, process.argv.slice(2));
