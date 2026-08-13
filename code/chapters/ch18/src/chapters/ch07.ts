import { runProfile } from "../cli.js";
import { P07 } from "../core/profiles.js";

// 固定入口启用 P07 的 Skill catalog 与 load_skill 工具。
process.exitCode = await runProfile(P07, process.argv.slice(2));
