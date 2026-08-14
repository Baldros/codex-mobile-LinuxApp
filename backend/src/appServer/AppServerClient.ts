import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export type JsonRpcId = string | number;

export type AppServerNotification = {
  method: string;
  params?: unknown;
};

export type AppServerRequest = {
  method: string;
  id: JsonRpcId;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type AppServerClientOptions = {
  codexPath?: string;
};

export class AppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly events = new EventEmitter();
  private initPromise: Promise<void> | null = null;

  constructor(private readonly options: AppServerClientOptions = {}) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureReady();
    return this.sendRequest<T>(method, params);
  }

  async notify(method: string, params?: unknown) {
    await this.ensureReady();
    this.write(params === undefined ? { method } : { method, params });
  }

  async respond(id: JsonRpcId, result: unknown) {
    await this.ensureReady();
    this.write({ id, result });
  }

  onNotification(listener: (message: AppServerNotification) => void) {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  onServerRequest(listener: (message: AppServerRequest) => void) {
    this.events.on("serverRequest", listener);
    return () => this.events.off("serverRequest", listener);
  }

  async dispose() {
    if (!this.proc) {
      return;
    }

    const proc = this.proc;
    this.proc = null;
    proc.kill();
  }

  private async ensureReady() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.startAndInitialize();
    return this.initPromise;
  }

  private async startAndInitialize() {
    this.startProcess();
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "codex_mobile_bridge",
        title: "Codex Mobile Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.write({ method: "initialized", params: {} });
  }

  private startProcess() {
    if (this.proc) {
      return;
    }

    const proc = spawn(this.options.codexPath ?? "codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    proc.stderr.on("data", (chunk) => {
      this.events.emit("stderr", Buffer.from(chunk).toString("utf8"));
    });

    proc.on("error", (error) => {
      this.proc = null;
      this.initPromise = null;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.events.emit("processError", error);
    });

    proc.on("exit", (code, signal) => {
      this.proc = null;
      this.initPromise = null;
      const error = new Error(`codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.events.emit("exit", { code, signal });
    });
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      this.write(message);
    });
  }

  private handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.events.emit("parseError", line);
      return;
    }

    if ("id" in message && "method" in message) {
      this.events.emit("serverRequest", message as AppServerRequest);
      return;
    }

    if ("id" in message) {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === "string") {
      this.events.emit("notification", message as AppServerNotification);
    }
  }

  private handleResponse(message: Record<string, unknown>) {
    const id = message.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);

    if (message.error) {
      const errorPayload = message.error as { message?: string; code?: number };
      pending.reject(new Error(errorPayload.message ?? `App-server request failed: ${id}`));
      return;
    }

    pending.resolve(message.result);
  }

  private write(message: unknown) {
    if (!this.proc) {
      throw new Error("codex app-server process is not running.");
    }

    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
