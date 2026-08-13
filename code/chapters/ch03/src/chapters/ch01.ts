import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

// 固定为 P01，只含循环与 PowerShell 能力，不含工具注册表或文件工具。
process.exitCode = await runProfile(P01, process.argv.slice(2));
