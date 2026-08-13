/**
 * P01 固定入口点：锁定章节 profile 为 P01，
 * 阻止调用方通过通用 CLI 参数越级启用 P02 文件能力。
 */
import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

// 独立脚本固定为 P01，避免调用方通过参数越级启用 P02 文件能力。
process.exitCode = await runProfile(P01, process.argv.slice(2));
