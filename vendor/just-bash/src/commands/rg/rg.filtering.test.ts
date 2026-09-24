import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("rg file type filtering", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should filter by type with -t", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/app.ts": "const foo = 1;\n",
        "/home/user/app.js": "const foo = 2;\n",
        "/home/user/style.css": "foo { }\n",
      },
    });
    const result = await bash.exec("rg -n -t ts foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:const foo = 1;\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should exclude type with -T", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/app.ts": "const foo = 1;\n",
        "/home/user/app.js": "const foo = 2;\n",
      },
    });
    const result = await bash.exec("rg -n -T ts foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.js:1:const foo = 2;\n");
    expect(result.stderr).toBe("");
  });

  it("should list types with --type-list", async () => {
    const bash = new Bash();
    const result = await bash.exec("rg --type-list");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("js:");
    expect(result.stdout).toContain("ts:");
    expect(result.stdout).toContain("py:");
    expect(result.stderr).toBe("");
  });
});

describe("rg glob filtering", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should filter files with -g", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/app.ts": "const foo = 1;\n",
        "/home/user/app.js": "const foo = 2;\n",
      },
    });
    const result = await bash.exec("rg -n -g '*.ts' foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:const foo = 1;\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should support negated globs", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/app.ts": "const foo = 1;\n",
        "/home/user/test.ts": "const foo = 2;\n",
      },
    });
    const result = await bash.exec("rg -n -g '!test.ts' foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:const foo = 1;\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match multiple files with glob", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.ts": "foo\n",
        "/home/user/b.ts": "foo\n",
        "/home/user/c.js": "foo\n",
      },
    });
    const result = await bash.exec("rg -n -g '*.ts' foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.ts:1:foo\nb.ts:1:foo\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg hidden files", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should skip hidden files by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/visible.txt": "hello\n",
        "/home/user/.hidden.txt": "hello\n",
      },
    });
    const result = await bash.exec("rg -n hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("visible.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should include hidden files with --hidden", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/visible.txt": "hello\n",
        "/home/user/.hidden.txt": "hello\n",
      },
    });
    const result = await bash.exec("rg -n --hidden hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".hidden.txt:1:hello\nvisible.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg gitignore", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should respect .gitignore patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "*.log\n",
        "/home/user/app.ts": "hello\n",
        "/home/user/debug.log": "hello\n",
      },
    });
    const result = await bash.exec("rg -n hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should include ignored files with --no-ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "*.log\n",
        "/home/user/app.ts": "hello\n",
        "/home/user/debug.log": "hello\n",
      },
    });
    const result = await bash.exec("rg -n --no-ignore hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:hello\ndebug.log:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should handle negation patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "*.log\n!important.log\n",
        "/home/user/debug.log": "hello\n",
        "/home/user/important.log": "hello\n",
      },
    });
    const result = await bash.exec("rg -n hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("important.log:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should handle directory patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "build/\n",
        "/home/user/src/app.ts": "hello\n",
        "/home/user/build/output.js": "hello\n",
      },
    });
    const result = await bash.exec("rg -n hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("src/app.ts:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should apply parent gitignore to subdirectories", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "*.log\n",
        "/home/user/app.ts": "hello\n",
        "/home/user/subdir/file.ts": "hello\n",
        "/home/user/subdir/debug.log": "hello\n",
      },
    });
    const result = await bash.exec("rg -n hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:hello\nsubdir/file.ts:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should handle directory trailing slash vs similar prefix", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "node_modules/\n",
        "/home/user/node_modules/pkg/index.js": "hello\n",
        "/home/user/node_modules_backup/file.js": "hello\n",
      },
    });
    const result = await bash.exec("rg -n hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("node_modules_backup/file.js:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should handle double-star patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "**/cache/**\n",
        "/home/user/src/app.ts": "hello\n",
        "/home/user/src/cache/data.json": "hello\n",
        "/home/user/cache/index.json": "hello\n",
      },
    });
    const result = await bash.exec("rg -n hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("src/app.ts:1:hello\n");
    expect(result.stderr).toBe("");
  });
});
