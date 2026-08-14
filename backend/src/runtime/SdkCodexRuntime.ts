import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Codex, type Thread, type ThreadOptions } from "@openai/codex-sdk";

import type {
  CodexRuntime,
  CodexRuntimeHealth,
  RuntimeThread,
  RuntimeThreadOptions,
  RuntimeTurnOptions
} from "./types.js";

const execFileAsync = promisify(execFile);

export class SdkCodexRuntime implements CodexRuntime {
  readonly name = "sdk" as const;
  private readonly codex = new Codex();

  async health(): Promise<CodexRuntimeHealth> {
    const checks: CodexRuntimeHealth["checks"] = {
      codex_cli: "failed",
      codex_auth: "failed"
    };

    const version = await runCodexCommand(["--version"]);
    checks.codex_cli = version.ok ? "ok" : "failed";

    const auth = await runCodexCommand(["login", "status"]);
    checks.codex_auth = auth.ok ? "ok" : "failed";

    return {
      runtime: this.name,
      ready: version.ok && auth.ok,
      auth: auth.ok ? "ok" : "missing",
      codexCliVersion: version.ok ? version.stdout.trim() : null,
      checks
    };
  }

  startThread(options: RuntimeThreadOptions): RuntimeThread {
    return new SdkRuntimeThread(this.codex.startThread(toSdkThreadOptions(options)));
  }

  resumeThread(id: string, options: RuntimeThreadOptions): RuntimeThread {
    return new SdkRuntimeThread(this.codex.resumeThread(id, toSdkThreadOptions(options)));
  }
}

class SdkRuntimeThread implements RuntimeThread {
  constructor(private readonly thread: Thread) {}

  get id() {
    return this.thread.id;
  }

  async runStreamed(input: string, options: RuntimeTurnOptions) {
    const { events } = await this.thread.runStreamed(input, {
      signal: options.signal
    });
    return events;
  }
}

function toSdkThreadOptions(options: RuntimeThreadOptions): ThreadOptions {
  const threadOptions: ThreadOptions = {
    workingDirectory: options.workingDirectory,
    skipGitRepoCheck: options.skipGitRepoCheck
  };

  if (options.model !== undefined) {
    threadOptions.model = options.model;
  }
  if (options.sandboxMode !== undefined) {
    threadOptions.sandboxMode = options.sandboxMode;
  }
  if (options.modelReasoningEffort !== undefined) {
    threadOptions.modelReasoningEffort = options.modelReasoningEffort;
  }
  if (options.networkAccessEnabled !== undefined) {
    threadOptions.networkAccessEnabled = options.networkAccessEnabled;
  }
  if (options.webSearchMode !== undefined) {
    threadOptions.webSearchMode = options.webSearchMode;
  }
  if (options.approvalPolicy !== undefined) {
    threadOptions.approvalPolicy = options.approvalPolicy;
  }
  if (options.additionalDirectories !== undefined) {
    threadOptions.additionalDirectories = options.additionalDirectories;
  }

  return threadOptions;
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

export function toSdkTurnOptions(options: RuntimeTurnOptions) {
  return {
    signal: options.signal
  };
}
