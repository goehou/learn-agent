import { runProfile } from "../cli.js";
import { P15 } from "../core/profiles.js";

// 固定入口启用 P15 的队友协作与 mailbox 通信。
process.exitCode = await runProfile(P15, process.argv.slice(2));
