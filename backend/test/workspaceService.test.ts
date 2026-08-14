import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { parseAllowlistFile, WorkspaceService } from "../src/workspaces/WorkspaceService.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WorkspaceService", () => {
  it("parses one workspace path per line and ignores comments", () => {
    expect(parseAllowlistFile("# comment\n/srv/repo\n\n/opt/other\n")).toEqual([
      "/srv/repo",
      "/opt/other"
    ]);
  });

  it("loads workspaces from the allowlist file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-workspaces-"));
    tempDirs.push(root);
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(repo, ".git"));

    const allowlistFile = path.join(root, "workspaces.allowlist");
    fs.writeFileSync(allowlistFile, `${repo}\n${path.join(root, "missing")}\n`);

    const service = new WorkspaceService(testConfig(root, allowlistFile));
    const workspaces = service.listWorkspaces();

    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]).toMatchObject({
      path: repo,
      exists: true,
      is_git_repo: true,
      source: "file"
    });
    expect(workspaces[1]).toMatchObject({
      exists: false,
      source: "file"
    });
    expect(service.assertAllowed(path.join(repo, "src"))).toBe(path.join(repo, "src"));
  });

  it("removes and restores only allowlist file entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-workspaces-"));
    tempDirs.push(root);
    const repo = path.join(root, "repo");
    const other = path.join(root, "other");
    fs.mkdirSync(repo);
    fs.mkdirSync(other);

    const allowlistFile = path.join(root, "workspaces.allowlist");
    fs.writeFileSync(allowlistFile, `# keep\n${repo}\n${other}\n`);

    const service = new WorkspaceService(testConfig(root, allowlistFile));
    const removed = service.removeFromFileAllowlist(repo);

    expect(removed).toMatchObject({ supported: true, removed: true, path: repo });
    expect(parseAllowlistFile(fs.readFileSync(allowlistFile, "utf8"))).toEqual([other]);
    expect(fs.readFileSync(allowlistFile, "utf8")).toContain("# keep");

    const restored = service.restoreToFileAllowlist(repo);

    expect(restored).toMatchObject({ supported: true, restored: true, path: repo });
    expect(parseAllowlistFile(fs.readFileSync(allowlistFile, "utf8"))).toEqual([other, repo]);
  });

  it("adds a workspace to an existing allowlist file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-workspaces-"));
    tempDirs.push(root);
    const repo = path.join(root, "repo");
    const other = path.join(root, "other");
    fs.mkdirSync(repo);
    fs.mkdirSync(other);

    const allowlistFile = path.join(root, "workspaces.allowlist");
    fs.writeFileSync(allowlistFile, `${repo}\n`);

    const service = new WorkspaceService(testConfig(root, allowlistFile));
    const added = service.addToFileAllowlist(other);

    expect(added).toMatchObject({ supported: true, added: true, path: other });
    expect(parseAllowlistFile(fs.readFileSync(allowlistFile, "utf8"))).toEqual([repo, other]);

    const duplicate = service.addToFileAllowlist(other);
    expect(duplicate).toMatchObject({ supported: true, added: false, path: other });
    expect(parseAllowlistFile(fs.readFileSync(allowlistFile, "utf8"))).toEqual([repo, other]);
  });

  it("creates a file allowlist from fallback entries when adding a workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-workspaces-"));
    tempDirs.push(root);
    const other = path.join(root, "other");
    fs.mkdirSync(other);

    const allowlistFile = path.join(root, "workspaces.allowlist");
    const service = new WorkspaceService(testConfig(root, allowlistFile));
    const added = service.addToFileAllowlist(other);

    expect(added).toMatchObject({ supported: true, added: true, path: other });
    expect(parseAllowlistFile(fs.readFileSync(allowlistFile, "utf8"))).toEqual([root, other]);
  });

  it("rejects adding a missing workspace path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-workspaces-"));
    tempDirs.push(root);
    const missing = path.join(root, "missing");
    const allowlistFile = path.join(root, "workspaces.allowlist");

    const service = new WorkspaceService(testConfig(root, allowlistFile));
    const added = service.addToFileAllowlist(missing);

    expect(added).toMatchObject({
      supported: true,
      added: false,
      path: missing,
      reason: "Workspace path does not exist or is not a directory."
    });
    expect(fs.existsSync(allowlistFile)).toBe(false);
  });

  it("reports unsupported removal when no allowlist file exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-workspaces-"));
    tempDirs.push(root);
    const service = new WorkspaceService(testConfig(root, path.join(root, "missing.allowlist")));

    expect(service.removeFromFileAllowlist(root)).toMatchObject({
      supported: false,
      removed: false,
      path: root
    });
  });
});

function testConfig(defaultWorkspace: string, workspaceAllowlistFile: string): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    runtime: "mock",
    workspaceAllowlist: [],
    workspaceAllowlistFile,
    defaultWorkspace,
    defaultSkipGitRepoCheck: true,
    defaultModel: null,
    heartbeatMs: 15000,
    version: "test"
  };
}
