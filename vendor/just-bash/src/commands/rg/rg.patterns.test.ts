import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("rg pattern options", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match whole words with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\nhelloworld\n",
      },
    });
    const result = await bash.exec("rg -n -w hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello world\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match whole lines with -x", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\nhello world\n",
      },
    });
    const result = await bash.exec("rg -n -x hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should treat pattern as literal with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a.b\naxb\n",
      },
    });
    const result = await bash.exec("rg -n -F 'a.b'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:a.b\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match regex special chars literally with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo[bar]\nfoobar\n",
      },
    });
    const result = await bash.exec("rg -n -F '[bar]'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo[bar]\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should invert match with -v", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\nworld\n",
      },
    });
    const result = await bash.exec("rg -n -v hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:world\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should show all non-matching lines with -v", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\nfoo\nbaz\n",
      },
    });
    const result = await bash.exec("rg -n -v foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:bar\nfile.txt:4:baz\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg multiple patterns", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should search for multiple patterns with -e", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\nbaz\n",
      },
    });
    const result = await bash.exec("rg -n -e foo -e bar");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo\nfile.txt:2:bar\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should combine multiple -e patterns", async () => {
    // Note: When -e is used, all positional args are paths (ripgrep behavior)
    // Use multiple -e flags to search for multiple patterns
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\nbaz\n",
      },
    });
    const result = await bash.exec("rg -n -e foo -e bar");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo\nfile.txt:2:bar\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should use smart case across all patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello\nhello\nWorld\nworld\n",
      },
    });
    const result = await bash.exec("rg -n -e Hello -e world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:Hello\nfile.txt:4:world\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should support --regexp= syntax", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\n",
      },
    });
    const result = await bash.exec("rg -n --regexp=foo --regexp=bar");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo\nfile.txt:2:bar\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match multiple patterns in same line", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo bar baz\n",
      },
    });
    const result = await bash.exec("rg -n -e foo -e bar");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo bar baz\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg regex patterns", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match regex patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo123\nbar456\nbaz\n",
      },
    });
    const result = await bash.exec("rg -n '[0-9]+'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo123\nfile.txt:2:bar456\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match start of line with ^", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\nworld hello\n",
      },
    });
    const result = await bash.exec("rg -n '^hello'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello world\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match end of line with $", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\nworld hello\n",
      },
    });
    const result = await bash.exec("rg -n 'hello$'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:world hello\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match with alternation", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "cat\ndog\nbird\n",
      },
    });
    const result = await bash.exec("rg -n 'cat|dog'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:cat\nfile.txt:2:dog\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match with quantifiers", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a\naa\naaa\nb\n",
      },
    });
    const result = await bash.exec("rg -n 'a{2,}'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:aa\nfile.txt:3:aaa\n");
    expect(result.stderr).toBe("");
  });

  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should match with character classes", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a1\nb2\nc!\n",
      },
    });
    const result = await bash.exec("rg -n '[a-z][0-9]'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:a1\nfile.txt:2:b2\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg combined options", () => {
  // (1ctx) ripgrep numbers lines only with -n when piped
  it("should combine -w and -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello world\nhelloworld\nHELLO there\n",
      },
    });
    const result = await bash.exec("rg -n -wi hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:1:Hello world\nfile.txt:3:HELLO there\n",
    );
    expect(result.stderr).toBe("");
  });

  it("should combine -c and -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello\nhello\nHELLO\n",
      },
    });
    const result = await bash.exec("rg -ci hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:3\n");
    expect(result.stderr).toBe("");
  });

  it("should combine -l and -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "HELLO\n",
        "/home/user/b.txt": "world\n",
      },
    });
    const result = await bash.exec("rg -li hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should combine -v and -c", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\nfoo\nbaz\n",
      },
    });
    const result = await bash.exec("rg -vc foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2\n");
    expect(result.stderr).toBe("");
  });
});
