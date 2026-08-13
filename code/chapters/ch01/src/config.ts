import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// 配置校验层：在网络请求前一次性验证环境变量和 API 端点。
//
// ConfigurationError 把缺失字段列表带到 CLI 边界，调用方据此给出可操作的启动错误。
// settingsFromMapping / settingsFromEnvFile 两条入口最终都归约为不可变的 OpenAISettings。
// 这里不为密钥、模型或地址提供默认值：缺失或空字段会直接失败，而不是用隐式默认值掩盖问题。
//
// 首章真实模型调用所需的三个环境变量；不为密钥和模型提供隐式默认值。
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

// 配置在网络请求前一次性校验，调用者可据此给出可操作的启动错误。
export class ConfigurationError extends Error {
  // 稳定错误名，CLI 通过它选择配置错误退出码。
  override readonly name = "ConfigurationError";
  // 缺失、空白或不合法的环境变量名；冻结副本防止异常创建后被篡改。
  readonly missingFields: readonly string[];

  // 以所有失效字段构造单个可操作错误，可选 cause 保留底层 URL/文件失败原因。
  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

// 通过配置边界验证后的 OpenAI 连接信息，后续层不再处理空值或空白字符串。
export interface OpenAISettings {
  // OpenAI SDK 所需的已校验、已去除首尾空白的连接配置。
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  // 第 11 章恢复策略使用的备用模型；第 1 章不强制要求它存在。
  readonly fallbackModel?: string;
}

// 从环境变量映射验证并规范化配置；requireFallback 仅在具备恢复能力的章节启用。
export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  // 不提供关键字段默认值；空字符串与缺失字段同样视为无效配置。
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  const missing = fields.filter((field) => {
    const value = mapping[field];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }

  // 前序缺失检查缩窄了必填字段；此分支仅防御映射在检查后的意外变化。
  const baseUrl = mapping.OPENAI_BASE_URL;
  const apiKey = mapping.OPENAI_API_KEY;
  const model = mapping.OPENAI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new Error("validated OpenAI settings are incomplete");
  }
  // 使用 URL 解析器确认地址合法，并限制为 SDK 可以访问的 HTTP(S) 协议。
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

// 读取 dotenv 文件后复用同一映射校验路径，避免文件和进程环境出现两套规则。
export function settingsFromEnvFile(path: string, requireFallback = false): OpenAISettings {
  // dotenv 只负责文件语法解析，字段完整性仍统一委托给 settingsFromMapping。
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
