/**
 * 配置模块：从 .env 文件或进程环境变量读取 OpenAI 连接参数。
 * settingsFromMapping 是纯函数，校验并归一化配置后可被测试直接调用；
 * settingsFromEnvFile 在进程边界读取本地 .env 后再复用同一套校验。
 * baseUrl 不允许以 /chat/completions 结尾，否则 SDK 会构造错误路径。
 */
import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// 模型连接的最小环境变量集合；fallback 由后续章节按需提升为必填项。
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

// 保留缺失字段，CLI 可据此区分配置问题与运行期失败。
export class ConfigurationError extends Error {
  // 稳定错误名，CLI 通过它选择配置错误退出码。
  override readonly name = "ConfigurationError";
  // 缺失或不合法的环境变量名称，冻结副本防止错误对象被篡改。
  readonly missingFields: readonly string[];

  // 用所有失效字段创建可操作错误，可选 cause 保留 URL 解析失败原因。
  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

export interface OpenAISettings {
  // 已验证的 SDK 基础地址，不能是完整 Chat Completions endpoint。
  readonly baseUrl: string;
  // 已去除首尾空白的访问密钥。
  readonly apiKey: string;
  // 默认模型标识。
  readonly model: string;
  // 后续恢复能力使用的备用模型；P02 不强制要求。
  readonly fallbackModel?: string;
}

// 先完整校验再读取字段，避免用默认值掩盖缺失的连接配置。
export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  const missing = fields.filter((field) => {
    const value = mapping[field];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }

  const baseUrl = mapping.OPENAI_BASE_URL;
  const apiKey = mapping.OPENAI_API_KEY;
  const model = mapping.OPENAI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new Error("validated OpenAI settings are incomplete");
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl.trim());
  } catch (error) {
    throw new ConfigurationError(["OPENAI_BASE_URL"], { cause: error });
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  // SDK 会附加 Chat Completions 路径；完整 endpoint 会导致请求路径重复。
  const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/chat/completions")) {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  const fallbackModel = mapping.OPENAI_FALLBACK_MODEL;
  return Object.freeze({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    ...(fallbackModel === undefined || fallbackModel.trim().length === 0
      ? {}
      : { fallbackModel: fallbackModel.trim() }),
  });
}

// .env 解析属于进程边界；其余校验复用纯映射函数以便测试。
export function settingsFromEnvFile(path: string, requireFallback = false): OpenAISettings {
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
