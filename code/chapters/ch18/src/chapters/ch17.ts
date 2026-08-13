import { runProfile } from "../cli.js";
import { P17 } from "../core/profiles.js";

// 固定入口启用 P17 的 SQLite 工作窃取运行时。
process.exitCode = await runProfile(P17, process.argv.slice(2));
