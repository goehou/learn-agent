/**
 * P02 固定入口点：锁定章节 profile 为 P02，
 * 保证 shell 与四个文件工具在该入口下一次性准备好。
 */
import { runProfile } from "../cli.js";
import { P02 } from "../core/profiles.js";

// 固定入口锁定 P02，防止通用 CLI 选择不属于本快照的能力集合。
process.exitCode = await runProfile(P02, process.argv.slice(2));
