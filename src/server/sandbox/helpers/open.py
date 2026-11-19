# The sandbox's open, run by the wrapper's open function as
#   python3 -I -S -c <this> <folder> <under> <docs 1|0> <max files>
#     <limit> <limit words> <repo limit or -> <repo words> <cwd> <arg>...
# <under> is empty in a sandbox; a test names a folder standing for /.
# It refuses with the words of bash/open.ts, then copies the file to
# <folder>/<n> and its percent-escaped path to <folder>/<n>.path, the same
# n for a second open of the same path. The server takes each copy
# through the same checks again.
import os, re, stat, sys

ROOTS = (b"knowledge", b"tmp", b"uploads", b"mcp", b"repos")
LINE_BREAK = re.compile("[\n\r\v\f\u0085  ]")
CONTROL = re.compile("[\x00-\x1f\x7f-\x9f]")
PREFIX = "/tmp/"
SEGMENT = 255
SEGMENTS = 64
NAME = 4095
PIECE = 1 << 16


def escape(raw):
    return "".join(
        chr(b) if 0x21 <= b <= 0x7E and b != 0x25 else "%%%02X" % b for b in raw
    )


def say(arg, words):
    sys.stderr.buffer.write(b"open: " + arg + b": " + words.encode() + b"\n")
    sys.exit(1)


# as just-bash's resolvePath: lexical, a .. at the top stays at /
def resolve(cwd, arg):
    joined = arg if arg.startswith(b"/") else cwd + b"/" + arg
    parts = []
    for part in joined.split(b"/"):
        if part in (b"", b"."):
            continue
        if part == b"..":
            if parts:
                parts.pop()
        else:
            parts.append(part)
    return b"/" + b"/".join(parts)


def scratch(name):
    parts = name.encode().split(b"/")
    return len(name.encode()) <= NAME and len(parts) <= SEGMENTS and all(
        p not in (b"", b".", b"..") and len(p) <= SEGMENT for p in parts
    )


# the words open.ts gives a path mountPath refuses, or None
def refused(path):
    try:
        text = path.decode("utf-8")
    except UnicodeDecodeError:
        return "not an allowed name"
    parts = path.split(b"/")[1:]
    if (
        len(path) <= len(PREFIX) + NAME
        and not CONTROL.search(text)
        and not LINE_BREAK.search(text)
        and parts[0] in ROOTS
        and all(p not in (b"", b".", b"..") for p in parts)
        and (not text.startswith(PREFIX) or scratch(text[len(PREFIX) :]))
    ):
        return None
    if LINE_BREAK.search(text):
        return "name has a line break"
    if CONTROL.search(text):
        return "name has a control character"
    return "not an allowed name"


def stdin_empty():
    try:
        st = os.fstat(0)
    except OSError:
        return True
    if not (stat.S_ISFIFO(st.st_mode) or stat.S_ISREG(st.st_mode)):
        return True
    return os.read(0, 1) == b""


def main():
    folder, under, docs, most, limit, words, repo, repo_words, cwd = (
        os.fsencode(a) for a in sys.argv[1:10]
    )
    args = [os.fsencode(a) for a in sys.argv[10:]]
    if under and cwd.startswith(under + b"/"):
        cwd = cwd[len(under) :]
    if len(args) != 1 or args[0].startswith(b"-") or not stdin_empty():
        sys.stderr.write("usage: open <file>\n")
        sys.exit(1)
    arg = args[0]
    path = resolve(cwd, arg)
    top = path.split(b"/")[1]
    if path == b"/" or top not in ROOTS:
        say(arg, "not in the mount")
    why = refused(path)
    if why:
        say(arg, why)
    if docs != b"1" and top == b"knowledge":
        say(arg, "no such file")
    walked = b""
    for part in path.split(b"/")[1:]:
        walked += b"/" + part
        try:
            st = os.stat(under + walked, follow_symlinks=False)
        except OSError:
            say(arg, "no such file")
        if stat.S_ISLNK(st.st_mode):
            say(arg, "not a regular file")
    if not stat.S_ISREG(st.st_mode):
        say(arg, "not a regular file")
    cap, cap_words = int(limit), words.decode()
    if top == b"repos" and repo != b"-" and int(repo) < cap:
        cap, cap_words = int(repo), repo_words.decode()
    over = "over %s, open a smaller part (sed -n '1,200p' f > /tmp/part.md)"
    if st.st_size > cap:
        say(arg, over % cap_words)
    try:
        fd = os.open(under + path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        say(arg, "no such file")
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            say(arg, "not a regular file")
        data = bytearray()
        while len(data) <= cap:
            b = os.read(fd, PIECE)
            if not b:
                break
            data += b
    finally:
        os.close(fd)
    if len(data) > cap:
        say(arg, over % cap_words)
    os.makedirs(folder, 0o700, exist_ok=True)
    record = escape(path)
    taken = {}
    for name in os.listdir(folder):
        if name.endswith(b".path") and name[:-5].isdigit():
            with open(os.path.join(folder, name), "rb") as f:
                taken[f.read().decode("ascii", "replace").rstrip("\n")] = name[:-5]
    n = taken.get(record)
    if n is None:
        if len(taken) >= int(most):
            say(arg, "at most %d files per command" % int(most))
        n = str(len(taken) + 1).encode()
    if b"\0" in data:
        say(arg, "not text")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        say(arg, "not text")
    copy = os.path.join(folder, n)
    with open(copy + b".part", "wb") as f:
        f.write(data)
    os.replace(copy + b".part", copy)
    with open(copy + b".path", "wb") as f:
        f.write(record.encode("ascii") + b"\n")


main()
