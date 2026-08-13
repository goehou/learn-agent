import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  McpCallResult,
  McpContractError,
  McpPublishedTool,
  McpTimeoutError,
  McpTransportError,
} from "../features/mcp-tools.js";
import type { McpConnection, McpConnectionFactory, McpServerSpec } from "../features/mcp-tools.js";

const CLIENT_INFO = Object.freeze({ name: "agent-tutorial", version: "0.1.0" });
const TRANSPORT_EXIT_GRACE_MS = 100;

// stdio 工厂仅在连接成功后交付实例；初始化失败时先关闭子进程相关资源。
export class StdioMcpConnectionFactory implements McpConnectionFactory {
  async open(spec: McpServerSpec, signal?: AbortSignal): Promise<McpConnection> {
    const connection = new StdioMcpConnection(spec);
    try {
      await connection.start(signal);
      return connection;
    } catch (error) {
      await connection.closeAfterFailedStart();
      throw error;
    }
  }
}

// 单连接将请求串行化，并将传输终止传播给排队和进行中的 MCP 调用。
class StdioMcpConnection implements McpConnection {
  readonly #spec: McpServerSpec;
  readonly #transport: StdioClientTransport;
  readonly #client: Client;
  #tail: Promise<void> = Promise.resolve();
  #terminalError: McpTransportError | undefined;
  #rejectTerminal: (error: McpTransportError) => void = () => {};
  #resolveTerminal: () => void = () => {};
  readonly #terminalFailure = new Promise<never>((_, reject) => {
    this.#rejectTerminal = (error) => reject(error);
  });
  readonly #terminalSignal = new Promise<void>((resolve) => {
    this.#resolveTerminal = resolve;
  });
  #closing = false;
  #closed = false;
  #started = false;

  constructor(spec: McpServerSpec) {
    this.#spec = spec;
    this.#transport = new StdioClientTransport({
      command: spec.command,
      args: [...spec.args],
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      stderr: "ignore",
    });
    this.#client = new Client(CLIENT_INFO, { capabilities: {} });
    // 提前消费终态拒绝，避免未等待的 Promise 产生 unhandled rejection。
    void this.#terminalFailure.catch(() => undefined);
    this.#transport.onclose = () => {
      if (!this.#closing && !this.#closed) {
        this.#markTerminal(new McpTransportError("MCP stdio transport closed"));
      }
    };
    this.#transport.onerror = (error: Error) => {
      if (!this.#closing && !this.#closed) {
        this.#markTerminal(new McpTransportError("MCP stdio transport failed", { cause: error }));
      }
    };
  }

  // 启动连接：等待 initialize 完成，连接建立后再确认 transport 没有已经失败。
  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) {
      throw new McpTransportError("MCP stdio connection was already started");
    }
    this.#started = true;
    try {
      await this.#client.connect(this.#transport, {
        ...(signal === undefined ? {} : { signal }),
        timeout: milliseconds(this.#spec.startupTimeoutSeconds),
        maxTotalTimeout: milliseconds(this.#spec.startupTimeoutSeconds),
      });
    } catch (error) {
      throw mapSdkError(error, "MCP stdio initialize failed");
    }
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
  }

  // 分页读取 tools/list，并校验远程声明的名称、描述和 input schema 契约。
  async listTools(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly McpPublishedTool[]> {
    return await this.#enqueue(async () => {
      const tools: McpPublishedTool[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      while (true) {
        const result = await this.#client.listTools(
          cursor === undefined ? undefined : { cursor },
          requestOptions(this.#spec.startupTimeoutSeconds, options.signal),
        );
        for (const tool of result.tools) {
          if (!isRecord(tool.inputSchema)) {
            throw new McpContractError("MCP tools/list returned a non-object input schema");
          }
          tools.push(
            new McpPublishedTool({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              inputSchema: tool.inputSchema,
            }),
          );
        }
        cursor = result.nextCursor;
        if (cursor === undefined) return Object.freeze(tools);
        if (seenCursors.has(cursor)) {
          throw new McpTransportError("MCP tools/list repeated a pagination cursor");
        }
        seenCursors.add(cursor);
      }
    }, options.signal);
  }

  // 调用远程工具，只把通过契约校验的 content、structuredContent 和 isError 交回上层。
  async callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    options: { readonly timeoutSeconds: number; readonly signal?: AbortSignal },
  ): Promise<McpCallResult> {
    return await this.#enqueue(async () => {
      const result = await this.#client.callTool(
        { name, arguments: { ...argumentsValue } },
        undefined,
        requestOptions(options.timeoutSeconds, options.signal),
      );
      if (!isRecord(result)) {
        throw new McpContractError("MCP tools/call returned an invalid result");
      }
      const rawContent = Reflect.get(result, "content");
      if (!Array.isArray(rawContent) || !rawContent.every(isRecord)) {
        throw new McpContractError("MCP tools/call content is invalid");
      }
      const rawStructuredContent = Reflect.get(result, "structuredContent");
      if (
        rawStructuredContent !== undefined &&
        rawStructuredContent !== null &&
        !isRecord(rawStructuredContent)
      ) {
        throw new McpContractError("MCP tools/call structured content is invalid");
      }
      const rawIsError = Reflect.get(result, "isError");
      if (rawIsError !== undefined && typeof rawIsError !== "boolean") {
        throw new McpContractError("MCP tools/call isError is invalid");
      }
      return new McpCallResult({
        content: rawContent,
        structuredContent: rawStructuredContent === undefined ? null : rawStructuredContent,
        isError: rawIsError === true,
      });
    }, options.signal);
  }

  // 正常关闭：先等待队列中已有操作结束，再关闭 SDK client，避免关闭打断进行中的请求。
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try {
      await this.#tail;
      await this.#client.close();
    } catch (error) {
      this.#closing = false;
      throw mapSdkError(error, "MCP stdio connection close failed");
    }
    this.#closed = true;
    this.#terminalError = undefined;
    this.#resolveTerminal();
  }

  // 启动失败时的兜底关闭；client 关闭不成功时直接关闭 transport，尽力回收子进程。
  async closeAfterFailedStart(): Promise<void> {
    this.#closing = true;
    try {
      await this.#client.close();
    } catch {
      await this.#transport.close();
    } finally {
      this.#closed = true;
      this.#resolveTerminal();
    }
  }

  // 向运行时暴露“连接已终止”信号，供 Watchdog 撤销该 alias 的动态工具。
  waitForFailure(): Promise<void> {
    return this.#terminalSignal;
  }

  // 单连接串行队列：操作按顺序执行，同时与 transport 终态、调用方 abort 竞争。
  async #enqueue<Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
    if (!this.#started) throw new McpTransportError("MCP stdio connection was not started");
    if (this.#closed) throw new McpTransportError("MCP stdio connection is closed");
    if (this.#terminalError !== undefined) throw this.#terminalError;
    const queued = this.#tail.then(async () => {
      if (signal?.aborted) throw abortReason(signal);
      if (this.#terminalError !== undefined) throw this.#terminalError;
      try {
        return await Promise.race([operation(), this.#terminalFailure]);
      } catch (error) {
        if (error instanceof McpContractError || isAbortError(error)) throw error;
        if (isRequestTimeout(error) && (await this.#waitForTransportClosure())) {
          throw new McpTransportError("MCP stdio process exited during request", { cause: error });
        }
        throw mapSdkError(error, "MCP stdio request failed");
      }
    });
    this.#tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return await waitForAbort(queued, signal);
  }

  // 记录首个不可逆传输错误，并唤醒所有等待中的调用；后续操作直接失败。
  #markTerminal(error: McpTransportError): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error;
    this.#rejectTerminal(error);
    this.#resolveTerminal();
  }

  // 给 RequestTimeout 一个短观察窗口，确认是子进程退出还是纯协议超时。
  async #waitForTransportClosure(): Promise<boolean> {
    if (this.#transport.pid === null || this.#terminalError !== undefined) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (closed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(closed);
      };
      const timer = setTimeout(
        () => finish(this.#transport.pid === null || this.#terminalError !== undefined),
        TRANSPORT_EXIT_GRACE_MS,
      );
      void this.#terminalFailure.then(
        () => finish(true),
        () => finish(true),
      );
    });
  }
}

// 统一把秒级配置转换为 SDK 的单次请求超时和总超时。
function requestOptions(
  seconds: number,
  signal?: AbortSignal,
): {
  readonly timeout: number;
  readonly maxTotalTimeout: number;
  readonly signal?: AbortSignal;
} {
  const timeout = milliseconds(seconds);
  return Object.freeze({
    timeout,
    maxTotalTimeout: timeout,
    ...(signal === undefined ? {} : { signal }),
  });
}

// 秒转毫秒，并拒绝 NaN、零值或超出 SDK 整数上限的配置。
function milliseconds(seconds: number): number {
  const value = seconds * 1000;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new McpContractError("MCP timeout is outside the supported millisecond range");
  }
  return Math.max(1, Math.ceil(value));
}

// 把 SDK 异常映射为本地错误类型，保留 abort 原样，避免把业务错误当成协议错误。
function mapSdkError(error: unknown, message: string): Error {
  if (isAbortError(error)) return error;
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new McpTimeoutError(message, { cause: error });
  }
  if (error instanceof McpError || error instanceof Error) {
    return new McpTransportError(message, { cause: error });
  }
  return new McpTransportError(message, { cause: error });
}

// 识别 MCP SDK 的 RequestTimeout 错误码，用于区分超时与连接丢失。
function isRequestTimeout(error: unknown): error is McpError {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

// 给异步结果附加调用方 abort 监听，取消时只拒绝当前等待者。
function waitForAbort<Result>(promise: Promise<Result>, signal?: AbortSignal): Promise<Result> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// 生成统一、可识别的 AbortError 原因。
function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

// 判断 SDK 抛出的对象是否为 AbortError。
function isAbortError(value: unknown): value is Error {
  return value instanceof Error && value.name === "AbortError";
}

// 类型守卫：判断未知值是否为非 null、非数组的普通对象。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
