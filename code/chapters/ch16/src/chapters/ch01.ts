// 固定为 P01，防止该入口意外启用后续章节能力。
import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

process.exitCode = await runProfile(P01, process.argv.slice(2));
