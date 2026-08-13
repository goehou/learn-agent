import { runProfile } from "../cli.js";
import { P09 } from "../core/profiles.js";

// 固定入口启用 P09 的文件级持久记忆生命周期。
process.exitCode = await runProfile(P09, process.argv.slice(2));
