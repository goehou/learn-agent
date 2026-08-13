import { runProfile } from "../cli.js";
import { P19 } from "../core/profiles.js";

// 固定入口启用 P19 的 MCP 连接和动态工具发布能力。
process.exitCode = await runProfile(P19, process.argv.slice(2));
