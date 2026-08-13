// 固定章节入口只绑定 P01，复用 CLI 的配置、授权和错误处理边界。
import { runProfile } from "../cli.js";
import { P01 } from "../core/profiles.js";

// 第 1 章固定入口：只绑定 P01 profile，并复用 CLI 的配置、授权和错误处理边界。
//
// 本文件不包含 Agent 逻辑；它把命令行参数交给 runProfile，
// 由 runProfile 隐式固定 --chapter 为 1，避免用户从固定入口覆盖章节号。
//
// 固定章节脚本始终以 P01 profile 运行，通用 CLI 仍可解析命令行参数。
// 转交命令行参数；runProfile 会隐式固定 --chapter 为 1。
process.exitCode = await runProfile(P01, process.argv.slice(2));
