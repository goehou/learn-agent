import { runProfile } from "../cli.js";
import { P20 } from "../core/profiles.js";

// 固定入口运行 P20 Full Harness，并由 CLI 负责结束后的资源释放与错误码返回。
process.exitCode = await runProfile(P20, process.argv.slice(2));
