import { runProfile } from "../cli.js";
import { P06 } from "../core/profiles.js";

// 固定入口启用 P06 的受控子代理委派能力。
process.exitCode = await runProfile(P06, process.argv.slice(2));
