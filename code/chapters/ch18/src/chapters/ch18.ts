import { runProfile } from "../cli.js";
import { P18 } from "../core/profiles.js";

// 固定入口复用通用 CLI，只固定 P18 profile，避免章节命令重复传 --chapter。
process.exitCode = await runProfile(P18, process.argv.slice(2));
