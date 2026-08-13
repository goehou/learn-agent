import { runProfile } from "../cli.js";
import { P10 } from "../core/profiles.js";

// 固定入口启用 P10 的动态系统提示渲染。
process.exitCode = await runProfile(P10, process.argv.slice(2));
