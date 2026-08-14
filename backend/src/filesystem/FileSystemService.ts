import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "../errors.js";

export type DirectoryEntry = {
  name: string;
  path: string;
  is_git_repo: boolean;
};

const MAX_DIRECTORY_CHILDREN = 300;

export class FileSystemService {
  listRoots() {
    return {
      data: localRoots().map(toEntry)
    };
  }

  listChildren(candidate: string | null) {
    if (!candidate) {
      throw new AppError(400, "missing_path", "Directory path is required.");
    }

    const resolved = path.resolve(candidate);
    if (!isDirectory(resolved)) {
      throw new AppError(404, "directory_not_found", `Directory does not exist: ${resolved}`);
    }

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      throw new AppError(403, "directory_not_readable", `Directory is not readable: ${resolved}`);
    }

    const directories = children
      .filter((child) => child.isDirectory())
      .map((child) => toEntry(path.join(resolved, child.name)))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

    return {
      path: resolved,
      name: path.basename(resolved) || resolved,
      parent: parentPath(resolved),
      children: directories.slice(0, MAX_DIRECTORY_CHILDREN),
      truncated: directories.length > MAX_DIRECTORY_CHILDREN
    };
  }
}

function localRoots() {
  return [path.parse(os.homedir()).root || "/"];
}

function toEntry(candidate: string): DirectoryEntry {
  return {
    name: path.basename(candidate) || candidate,
    path: candidate,
    is_git_repo: isGitRepository(candidate)
  };
}

function parentPath(candidate: string) {
  const root = path.parse(candidate).root;
  return samePath(root, candidate) ? null : path.dirname(candidate);
}

function isDirectory(candidate: string) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isGitRepository(candidate: string) {
  return fs.existsSync(path.join(candidate, ".git"));
}

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}
