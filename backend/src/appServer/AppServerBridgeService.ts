import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { CodexRuntimeHealth } from "../runtime/types.js";
import type { BridgeSseEvent } from "../sse.js";
import type { RunStreamBody } from "../validation.js";
import { WorkspaceService } from "../workspaces/WorkspaceService.js";
import { AsyncQueue } from "../asyncQueue.js";

import { AppServerClient, type AppServerNotification, type AppServerRequest } from "./AppServerClient.js";
import {
  mapAppServerNotification,
  mapAppServerRequest,
  messageBelongsToThread
} from "./mapAppServerEvent.js";
import type { BridgeThreadQuery } from "./types.js";

const execFileAsync = promisify(execFile);

type ActiveRun = {
  threadId: string;
  turnId: string;
};

type AppServerThread = {
  id: string;
  sessionId?: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: unknown;
  path?: string | null;
  modelProvider?: string;
  source?: unknown;
  turns?: unknown[];
};

type AppServerUserInput =
  | { type: "text"; text: string }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string; path: string };

type McpResourceReadResponse = {
  contents?: Array<{
    uri?: string;
    mimeType?: string | null;
    text?: string;
    blob?: string;
  }>;
};

const MAX_MCP_RESOURCE_TEXT_LENGTH = 40_000;

export class AppServerBridgeService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingApprovals = new Map<string, AppServerRequest>();

  constructor(
    private readonly deps: {
      config: BridgeConfig;
      client: AppServerClient;
      workspaceService: WorkspaceService;
    }
  ) {}

  async health(): Promise<CodexRuntimeHealth> {
    const checks: CodexRuntimeHealth["checks"] = {
      codex_cli: "failed",
      codex_auth: "failed",
      app_server: "failed"
    };

    const version = await runCodexCommand(["--version"]);
    checks.codex_cli = version.ok ? "ok" : "failed";

    try {
      const account = (await this.deps.client.request("account/read", {
        refreshToken: false
      })) as { account?: unknown; requiresOpenaiAuth?: boolean };
      checks.app_server = "ok";
      checks.codex_auth = account.requiresOpenaiAuth === false || account.account ? "ok" : "failed";
    } catch {
      checks.app_server = "failed";
    }

    return {
      runtime: "app-server",
      ready: checks.codex_cli === "ok" && checks.app_server === "ok" && checks.codex_auth === "ok",
      auth: checks.codex_auth === "ok" ? "ok" : "missing",
      codexCliVersion: version.ok ? version.stdout.trim() : null,
      checks
    };
  }

  listWorkspaces() {
    return this.deps.workspaceService.listWorkspaces();
  }

  async listThreads(query: BridgeThreadQuery = {}) {
    const cwd = query.cwd
      ? this.deps.workspaceService.assertAllowed(query.cwd)
      : this.deps.workspaceService.getAllowedRoots();

    const response = (await this.deps.client.request("thread/list", {
      cursor: query.cursor ?? null,
      limit: query.limit ?? 25,
      cwd,
      searchTerm: query.searchTerm ?? null,
      archived: query.archived ?? false,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"]
    })) as { data: AppServerThread[]; nextCursor: string | null; backwardsCursor: string | null };

    return {
      data: response.data.map(toPublicThread),
      next_cursor: response.nextCursor,
      backwards_cursor: response.backwardsCursor
    };
  }

  async createThread(input: { title?: string | undefined; workspace?: string | undefined }) {
    const cwd = this.deps.workspaceService.assertAllowed(
      input.workspace ?? this.deps.config.defaultWorkspace
    );
    const response = (await this.deps.client.request("thread/start", {
      cwd,
      model: this.deps.config.defaultModel,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      serviceName: "codex_mobile_bridge",
      threadSource: "user"
    })) as { thread: AppServerThread };

    if (input.title) {
      await this.deps.client.request("thread/name/set", {
        threadId: response.thread.id,
        name: input.title
      });
      response.thread.name = input.title;
    }

    return toPublicThread(response.thread);
  }

  async getThread(threadId: string, options: { includeTurns?: boolean } = {}) {
    const response = (await this.deps.client.request("thread/read", {
      threadId,
      includeTurns: options.includeTurns ?? false
    })) as { thread: AppServerThread };

    this.deps.workspaceService.assertAllowed(String(response.thread.cwd));
    return toPublicThread(response.thread);
  }

  async renameThread(threadId: string, input: { title: string }) {
    await this.deps.client.request("thread/name/set", {
      threadId,
      name: input.title
    });

    const response = (await this.deps.client.request("thread/read", {
      threadId,
      includeTurns: false
    })) as { thread: AppServerThread };
    return toPublicThread(response.thread);
  }

  async archiveThread(threadId: string, input: { archived: boolean }) {
    if (input.archived) {
      await this.deps.client.request("thread/archive", { threadId });
      return {
        supported: true,
        thread_id: threadId,
        archived: true
      };
    }

    const response = (await this.deps.client.request("thread/unarchive", {
      threadId
    })) as { thread?: AppServerThread };

    return {
      supported: true,
      thread_id: threadId,
      archived: false,
      thread: response.thread ? toPublicThread(response.thread) : null
    };
  }

  async *runThread(
    threadId: string,
    input: RunStreamBody,
    externalSignal: AbortSignal
  ): AsyncGenerator<BridgeSseEvent> {
    const cwd = this.deps.workspaceService.assertAllowed(
      input.cwd ?? this.deps.config.defaultWorkspace
    );
    const queue = new AsyncQueue<AppServerNotification | AppServerRequest>();

    const offNotification = this.deps.client.onNotification((message) => {
      if (messageBelongsToThread(message, threadId)) {
        queue.push(message);
      }
    });
    const offServerRequest = this.deps.client.onServerRequest((message) => {
      if (messageBelongsToThread(message, threadId)) {
        this.pendingApprovals.set(String(message.id), message);
        queue.push(message);
      }
    });

    let turnId: string | null = null;
    const abortListener = () => {
      if (turnId) {
        void this.cancelRun(threadId, turnId);
      }
      queue.close();
    };
    externalSignal.addEventListener("abort", abortListener, { once: true });

    try {
      await this.deps.client.request("thread/resume", {
        threadId,
        cwd,
        approvalPolicy: input.approval_policy ?? "on-request",
        approvalsReviewer: "user"
      });

      const turnInput = await this.buildTurnInput(input, threadId);
      const turnResponse = (await this.deps.client.request("turn/start", {
        threadId,
        input: turnInput,
        cwd,
        approvalPolicy: input.approval_policy ?? "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: toSandboxPolicy(input, cwd),
        model: input.model ?? this.deps.config.defaultModel,
        serviceTier: input.service_tier ?? null,
        effort: input.model_reasoning_effort ?? null
      })) as { turn: { id: string; status?: string } };

      turnId = turnResponse.turn.id;
      this.activeRuns.set(turnId, { threadId, turnId });

      yield {
        event: "run_started",
        data: {
          thread_id: threadId,
          run_id: turnId
        }
      };

      for await (const message of queue) {
        if ("id" in message && "method" in message) {
          yield mapAppServerRequest(message);
          continue;
        }

        const events = mapAppServerNotification(message, {
          bridgeThreadId: threadId,
          turnId
        });

        for (const event of events) {
          yield event;
        }

        if (message.method === "turn/completed") {
          break;
        }
      }
    } finally {
      if (turnId) {
        this.activeRuns.delete(turnId);
      }
      externalSignal.removeEventListener("abort", abortListener);
      offNotification();
      offServerRequest();
      queue.close();
    }
  }

  async cancelRun(threadId: string, runId?: string) {
    if (runId) {
      const active = this.activeRuns.get(runId);
      if (!active || active.threadId !== threadId) {
        return { cancelled: false, thread_id: threadId, run_id: runId };
      }

      await this.deps.client.request("turn/interrupt", { threadId, turnId: runId });
      return { cancelled: true, thread_id: threadId, run_id: runId };
    }

    const runIds = [...this.activeRuns.values()]
      .filter((run) => run.threadId === threadId)
      .map((run) => run.turnId);

    for (const turnId of runIds) {
      await this.deps.client.request("turn/interrupt", { threadId, turnId });
    }

    return {
      cancelled: runIds.length > 0,
      thread_id: threadId,
      run_ids: runIds
    };
  }

  async listModels(params: { includeHidden?: boolean; limit?: number; cursor?: string | null } = {}) {
    return this.deps.client.request("model/list", {
      includeHidden: params.includeHidden ?? false,
      limit: params.limit ?? 50,
      cursor: params.cursor ?? null
    });
  }

  async readConfig() {
    return this.deps.client.request("config/read", {
      includeLayers: false
    });
  }

  async writeConfig(input: { keyPath: string; value: unknown; mergeStrategy?: "replace" | "upsert" }) {
    return this.deps.client.request("config/value/write", {
      keyPath: input.keyPath,
      value: input.value,
      mergeStrategy: input.mergeStrategy ?? "replace"
    });
  }

  async readAccount() {
    const [accountResult, rateLimitsResult] = await Promise.allSettled([
      this.deps.client.request("account/read", {
        refreshToken: false
      }),
      this.deps.client.request("account/rateLimits/read")
    ]);

    if (accountResult.status === "rejected") {
      throw accountResult.reason;
    }

    return {
      ...(isRecord(accountResult.value) ? accountResult.value : { account: accountResult.value }),
      rateLimits: rateLimitsResult.status === "fulfilled" ? rateLimitsResult.value : null,
      rateLimitsError:
        rateLimitsResult.status === "rejected" ? errorMessage(rateLimitsResult.reason) : null
    };
  }

  async listExperimentalFeatures(params: { limit?: number; cursor?: string | null } = {}) {
    return this.deps.client.request("experimentalFeature/list", {
      limit: params.limit ?? 50,
      cursor: params.cursor ?? null
    });
  }

  async listApps(params: {
    limit?: number;
    cursor?: string | null;
    threadId?: string | null;
    forceRefetch?: boolean;
  } = {}) {
    try {
      return await this.deps.client.request("app/list", {
        limit: params.limit ?? 50,
        cursor: params.cursor ?? null,
        threadId: params.threadId ?? null,
        forceRefetch: params.forceRefetch ?? false
      });
    } catch (caught) {
      throw new AppError(502, "apps_unavailable", sanitizeAppListError(caught));
    }
  }

  async listSkills(params: { cwd?: string | null; forceReload?: boolean } = {}) {
    const cwds = params.cwd
      ? [this.deps.workspaceService.assertAllowed(params.cwd)]
      : this.deps.workspaceService.getAllowedRoots();

    return this.deps.client.request("skills/list", {
      cwds,
      forceReload: params.forceReload ?? false
    });
  }

  async listMcpServers(
    params: { detail?: "full" | "toolsAndAuthOnly"; limit?: number; cursor?: string | null } = {}
  ) {
    return this.deps.client.request("mcpServerStatus/list", {
      detail: params.detail ?? "full",
      limit: params.limit ?? 50,
      cursor: params.cursor ?? null
    });
  }

  async readMcpResource(input: { server: string; uri: string; threadId?: string | null }) {
    return this.deps.client.request("mcpServer/resource/read", {
      server: input.server,
      uri: input.uri,
      threadId: input.threadId ?? null
    });
  }

  async reloadMcpServers() {
    return this.deps.client.request("config/mcpServer/reload");
  }

  async respondApproval(requestId: string, input: { decision: string; payload?: unknown }) {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      throw new AppError(404, "approval_not_found", `Approval request not found: ${requestId}`);
    }

    const result =
      input.payload && typeof input.payload === "object"
        ? input.payload
        : { decision: input.decision };

    await this.deps.client.respond(pending.id, result);
    this.pendingApprovals.delete(requestId);

    return {
      resolved: true,
      approval_id: requestId
    };
  }

  private async buildTurnInput(input: RunStreamBody, threadId: string): Promise<AppServerUserInput[]> {
    const turnInput: AppServerUserInput[] = [{ type: "text", text: input.message }];

    for (const item of input.input_items ?? []) {
      if (item.type === "mention" || item.type === "skill") {
        turnInput.push({
          type: item.type,
          name: item.name,
          path: item.path
        });
        continue;
      }

      if (item.type === "mcp_resource") {
        const resource = (await this.readMcpResource({
          server: item.server,
          uri: item.uri,
          threadId
        })) as McpResourceReadResponse;
        turnInput.push({
          type: "text",
          text: formatMcpResourceForPrompt(item, resource)
        });
      }
    }

    return turnInput;
  }
}

function toPublicThread(thread: AppServerThread) {
  return {
    id: thread.id,
    session_id: thread.sessionId ?? thread.id,
    title: thread.name ?? thread.preview ?? "Untitled thread",
    preview: thread.preview ?? "",
    cwd: thread.cwd,
    created_at: toIso(thread.createdAt),
    updated_at: toIso(thread.updatedAt),
    status: thread.status,
    runtime_thread_id: thread.id,
    model_provider: thread.modelProvider,
    source: sourceLabel(thread.source),
    path: thread.path ?? null,
    turns: thread.turns ?? []
  };
}

function toIso(value: number | undefined) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function sourceLabel(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.type === "string") {
    return value.type;
  }
  return "appServer";
}

function toSandboxPolicy(input: RunStreamBody, cwd: string) {
  const networkAccess = input.network_access_enabled ?? false;

  switch (input.sandbox_mode) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };

    case "read-only":
      return { type: "readOnly", networkAccess };

    case "workspace-write":
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [cwd, ...(input.additional_directories ?? [])],
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
  }
}

async function runCodexCommand(args: string[]) {
  try {
    const { stdout } = await execFileAsync("codex", args, {
      timeout: 5000
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeAppListError(error: unknown) {
  const message = errorMessage(error);
  if (/403|forbidden/i.test(message)) {
    return "Failed to list apps: Codex app registry returned 403 Forbidden.";
  }

  const withoutHtml = message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return withoutHtml.length > 240 ? `${withoutHtml.slice(0, 240)}...` : withoutHtml;
}

function formatMcpResourceForPrompt(
  item: Extract<NonNullable<RunStreamBody["input_items"]>[number], { type: "mcp_resource" }>,
  resource: McpResourceReadResponse
) {
  const label = item.title ?? item.name ?? item.uri;
  const content = (resource.contents ?? [])
    .map((entry) => {
      if (entry.text) {
        return entry.text;
      }
      if (entry.blob) {
        return `[binary resource: ${entry.mimeType ?? "application/octet-stream"} at ${entry.uri ?? item.uri}]`;
      }
      return `[empty resource content at ${entry.uri ?? item.uri}]`;
    })
    .join("\n\n");

  const trimmed =
    content.length > MAX_MCP_RESOURCE_TEXT_LENGTH
      ? `${content.slice(0, MAX_MCP_RESOURCE_TEXT_LENGTH)}\n\n[resource truncated]`
      : content;

  return [
    `MCP resource selected by the user: ${label}`,
    `Server: ${item.server}`,
    `URI: ${item.uri}`,
    "",
    trimmed || "[resource returned no content]"
  ].join("\n");
}
