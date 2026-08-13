import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { NodeWorkspaceFileSystem, safePath } from "../src/adapters/filesystem.js";
import {
  FileNotFoundError,
  InvalidFilePathError,
  TextNotFoundError,
} from "../src/core/filesystem.js";

async function workspaceDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `agent-tutorial-ch02-${prefix}-`));
}

describe("workspace filesystem", () => {
  test.each(["../secret.txt", "nested/../secret.txt"])(
    "rejects parent segments: %s",
    async (relativePath) => {
      const workspace = await workspaceDirectory("parent");
      try {
        await expect(safePath(workspace, relativePath)).rejects.toThrow(/parent/);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test("rejects absolute paths and Windows reserved components", async () => {
    const workspace = await workspaceDirectory("reserved");
    try {
      await expect(safePath(workspace, join(workspace, "secret.txt"))).rejects.toThrow(/absolute/);
      for (const relativePath of [
        "NUL",
        "nul.txt",
        "nested/CON.log",
        "COM1",
        "LPT9.txt",
        "file:stream",
        "wild*.txt",
        "wild?.txt",
        "trailing.",
        "trailing ",
      ]) {
        await expect(safePath(workspace, relativePath)).rejects.toThrow(/reserved Windows/);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects an existing symlink that escapes the workspace", async () => {
    const workspace = await workspaceDirectory("link");
    const outside = await workspaceDirectory("outside");
    try {
      await writeFile(join(outside, "secret.txt"), "outside", "utf8");
      await symlink(outside, join(workspace, "escape"), "junction");
      await expect(safePath(workspace, "escape/secret.txt")).rejects.toThrow(/escapes workspace/);
      await expect(new NodeWorkspaceFileSystem().globFiles(workspace, "escape")).rejects.toThrow(
        /escapes workspace/,
      );
      await expect(
        new NodeWorkspaceFileSystem().globFiles(workspace, "escape/*.txt"),
      ).rejects.toThrow(/escapes workspace/);
      await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("outside");
      await rm(join(outside, "secret.txt"));
      await expect(
        new NodeWorkspaceFileSystem().globFiles(workspace, "escape/*.txt"),
      ).rejects.toThrow(/escapes workspace/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("reads with a positive line limit and reports omitted lines", async () => {
    const workspace = await workspaceDirectory("read");
    try {
      await writeFile(join(workspace, "notes.txt"), "one\ntwo\nthree\n", "utf8");
      const fileSystem = new NodeWorkspaceFileSystem();
      await expect(fileSystem.readFile(workspace, "notes.txt", 2)).resolves.toBe(
        "one\ntwo\n... (1 more lines)",
      );
      await expect(fileSystem.readFile(workspace, "notes.txt", 0)).rejects.toThrow(/positive/);
      await expect(fileSystem.readFile(workspace, "missing.txt")).rejects.toBeInstanceOf(
        FileNotFoundError,
      );
      await expect(fileSystem.readFile(workspace, ".")).rejects.toBeInstanceOf(
        InvalidFilePathError,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("writes UTF-8 bytes, edits once, and preserves CRLF", async () => {
    const workspace = await workspaceDirectory("write");
    try {
      const fileSystem = new NodeWorkspaceFileSystem();
      const content = "你好 Agent\nnext line\n你好";
      await expect(fileSystem.writeFile(workspace, "nested/deep/note.txt", content)).resolves.toBe(
        Buffer.byteLength(content, "utf8"),
      );
      await expect(
        fileSystem.editFile(workspace, "nested/deep/note.txt", "你好", "您好"),
      ).resolves.toBeUndefined();
      await expect(readFile(join(workspace, "nested/deep/note.txt"), "utf8")).resolves.toBe(
        "您好 Agent\nnext line\n你好",
      );

      await writeFile(join(workspace, "crlf.txt"), Buffer.from("old\r\nmiddle\r\n", "utf8"));
      await fileSystem.editFile(workspace, "crlf.txt", "old", "new");
      await expect(readFile(join(workspace, "crlf.txt"))).resolves.toEqual(
        Buffer.from("new\r\nmiddle\r\n"),
      );
      await expect(
        fileSystem.editFile(workspace, "crlf.txt", "missing", "replacement"),
      ).rejects.toBeInstanceOf(TextNotFoundError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("returns sorted POSIX relative glob matches", async () => {
    const workspace = await workspaceDirectory("glob");
    try {
      const fileSystem = new NodeWorkspaceFileSystem();
      await fileSystem.writeFile(workspace, "nested/a.py", "");
      await fileSystem.writeFile(workspace, "b.py", "");
      await fileSystem.writeFile(workspace, "ignored.txt", "");
      await expect(fileSystem.globFiles(workspace, "**/*.py")).resolves.toEqual([
        "b.py",
        "nested/a.py",
      ]);
      await expect(fileSystem.globFiles(workspace, "nested/*.py")).resolves.toEqual([
        "nested/a.py",
      ]);
      await expect(fileSystem.globFiles(workspace, "missing/*.py")).resolves.toEqual([]);
      await expect(fileSystem.globFiles(workspace, "b.py")).resolves.toEqual(["b.py"]);
      await expect(fileSystem.globFiles(workspace, "missing.txt")).resolves.toEqual([]);
      await expect(fileSystem.globFiles(workspace, "../*.txt")).rejects.toThrow(/parent/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
