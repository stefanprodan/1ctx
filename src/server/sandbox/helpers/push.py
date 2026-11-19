# The sandbox's push helper, run as python3 -I -S -c <this> <root>...
# stdin holds frames: a JSON header line, then `size` raw bytes for a
# file. Paths are percent-escaped bytes, as frames.ts writes them. It
# writes only regular files and folders under the roots, and walks every
# parent by a folder handle opened without following a link, so a link
# the workload left can never send a write elsewhere. A frame with `was`
# applies only while its path still holds those bytes (null: nothing),
# so a command running beside the push keeps what it wrote.
import errno, hashlib, json, os, re, stat, sys

PIECE = 1 << 16
HEADER = 1 << 16
ESCAPED = re.compile(rb"(?:[\x21-\x24\x26-\x7e]|%[0-9A-F]{2})+")
SHA = re.compile(r"[0-9a-f]{64}")
SEARCH = getattr(os, "O_PATH", os.O_RDONLY)
# milliseconds whose nanoseconds still fit utime's 64 bits, year 2255
MAX_MTIME = 9 * 10**12


def escape(raw):
    return "".join(
        chr(b) if 0x21 <= b <= 0x7E and b != 0x25 else "%%%02X" % b for b in raw
    )


class Refused(Exception):
    pass


# the raw path of the frame at hand, for the refusal line
CURRENT = b""


def unescape(text):
    try:
        raw = text.encode("ascii") if isinstance(text, str) else text
    except UnicodeEncodeError:
        raise Refused("name", b"")
    if not ESCAPED.fullmatch(raw):
        raise Refused("name", raw)
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0x25:
            out.append(int(raw[i + 1 : i + 3], 16))
            i += 3
        else:
            out.append(raw[i])
            i += 1
    if escape(out) != raw.decode("ascii"):
        raise Refused("name", raw)
    return bytes(out)


def checked_roots(args):
    roots = [os.fsencode(a) for a in args]
    for r in roots:
        parts = r.split(b"/")
        if not r.startswith(b"/") or any(p in (b"", b".", b"..") for p in parts[1:]):
            raise SystemExit("PUSH refused roots")
    return roots


ROOTS = checked_roots(sys.argv[1:])


# the root and the segments under it; refuses anything else
def split(path):
    if b"\0" in path:
        raise Refused("name", path)
    for root in ROOTS:
        if path == root:
            return root, []
        if path.startswith(root + b"/"):
            parts = path[len(root) + 1 :].split(b"/")
            if any(p in (b"", b".", b"..") for p in parts):
                raise Refused("name", path)
            return root, parts
    raise Refused("outside", path)


# a handle on the folder holding the last segment, every step taken
# without following a link
def parent(path, root, parts):
    try:
        fd = os.open(root, SEARCH | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refused("kind", path)
        raise
    for part in parts[:-1]:
        try:
            nxt = os.open(part, SEARCH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        except OSError as e:
            # Linux answers a link with ELOOP, macOS with ENOTDIR
            st = lstat_at(part, fd) if e.errno in (errno.ELOOP, errno.ENOTDIR) else None
            os.close(fd)
            if st is not None and stat.S_ISLNK(st.st_mode):
                raise Refused("link", path)
            if e.errno in (errno.ELOOP, errno.ENOTDIR):
                raise Refused("kind", path)
            if e.errno == errno.ENOENT:
                raise Refused("missing", path)
            raise
        os.close(fd)
        fd = nxt
    return fd


def lstat_at(name, fd):
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


# the owner's write and search on a folder this frame changes, through
# the handle already held; the frames' trailing meta puts its own mode
# back
def writable(fd):
    st = os.fstat(fd)
    if st.st_uid != os.geteuid() or st.st_mode & 0o300 == 0o300:
        return
    mode = stat.S_IMODE(st.st_mode) | 0o300
    if SEARCH == os.O_RDONLY:
        os.fchmod(fd, mode)
    else:
        # an O_PATH handle takes no fchmod; its /proc entry names the
        # very folder held, wherever links point now
        os.chmod("/proc/self/fd/%d" % fd, mode)


def times(h):
    ns = h["mtime"] * 1000000
    return (ns, ns)


def settle(name, fd, h):
    os.chmod(name, h["mode"], dir_fd=fd)
    os.utime(name, ns=times(h), dir_fd=fd, follow_symlinks=False)


def drain(size):
    left = size
    while left:
        b = sys.stdin.buffer.read(min(left, PIECE))
        if not b:
            raise Refused("short", b"")
        left -= len(b)


def digest(f):
    h = hashlib.sha256()
    while True:
        b = os.read(f, PIECE)
        if not b:
            return h.hexdigest()
        h.update(b)


def unchanged(a, b):
    return (a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns) == (
        b.st_dev,
        b.st_ino,
        b.st_size,
        b.st_mtime_ns,
    )


# the file at the name, opened without following a link, while it is a
# lone regular file holding the bytes `was` names and unwritten while
# hashed; None for anything else
def holding(name, fd, flags, was):
    try:
        f = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except OSError:
        return None
    st = os.fstat(f)
    ok = stat.S_ISREG(st.st_mode) and st.st_nlink == 1
    if ok and digest(f) == was and unchanged(st, os.fstat(f)):
        return f, st
    os.close(f)
    return None


# A frame with `was` acts on the very file it hashed, which narrows a
# sibling's race without closing it: a write between the last check and
# the truncate is lost, and so is a rewrite between the remove's lstat
# and its unlink; a writer holding the file open lands its later bytes
# at its own offset in the rewritten file, which may mix the two; a
# write between two parts of an append skips the parts after it.
def contested(h, name, fd, st):
    was = h["was"]
    if was is None:
        if st is None and h["op"] == "file":
            create(name, fd, h, skip_made=True)
        else:
            drain(h["size"])
        return
    if h["op"] == "file" and h.get("append"):
        held = holding(name, fd, os.O_RDWR | os.O_APPEND, was)
        if held is None:
            drain(h["size"])
        else:
            write(held[0], h)
        return
    held = holding(name, fd, os.O_RDONLY, was)
    if held is None:
        drain(h["size"])
        return
    f, st = held
    try:
        if h["op"] == "rm":
            now = lstat_at(name, fd)
            if now is not None and unchanged(st, now):
                writable(fd)
                os.unlink(name, dir_fd=fd)
            return
        # opening to write needs the bit; a check that fails gives the
        # file its mode back
        added = st.st_mode & 0o200 == 0
        if added:
            os.fchmod(f, stat.S_IMODE(st.st_mode) | 0o200)
        try:
            out = os.open(
                name, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
            )
        except OSError:
            if added:
                os.fchmod(f, stat.S_IMODE(st.st_mode))
            raise
        if not unchanged(st, os.fstat(out)):
            os.close(out)
            if added:
                os.fchmod(f, stat.S_IMODE(st.st_mode))
            drain(h["size"])
            return
        os.ftruncate(out, 0)
        write(out, h)
    finally:
        os.close(f)


# a new inode every time, so a hard link never carries a write to
# another name; a file made since a `was` of nothing is the other's
def create(name, fd, h, skip_made=False):
    writable(fd)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    try:
        out = os.open(name, flags, 0o600, dir_fd=fd)
    except FileExistsError:
        if not skip_made:
            raise
        drain(h["size"])
        return
    write(out, h)


def copy(fd, size):
    left = size
    while left:
        b = sys.stdin.buffer.read(min(left, PIECE))
        if not b:
            raise Refused("short", b"")
        view = memoryview(b)
        while view:
            view = view[os.write(fd, view) :]
        left -= len(b)


def header(line):
    try:
        h = json.loads(line)
    except ValueError:
        raise Refused("header", b"")
    ok = isinstance(h, dict) and h.get("op") in ("rm", "dir", "file", "meta")
    ok = ok and isinstance(h.get("path"), str)
    if ok and h["op"] != "rm":
        for key in ("mode", "mtime"):
            v = h.get(key)
            ok = ok and type(v) is int and v >= 0
        ok = ok and h["mode"] <= 0o7777 and h["mtime"] <= MAX_MTIME
    size = h.get("size", 0) if ok else 0
    ok = ok and type(size) is int and size >= 0
    ok = ok and (h["op"] == "file" or size == 0)
    ok = ok and type(h.get("append", False)) is bool
    if ok and "was" in h:
        v = h["was"]
        ok = h["op"] in ("rm", "file")
        ok = ok and (v is None or (type(v) is str and SHA.fullmatch(v) is not None))
    if not ok:
        raise Refused("header", b"")
    h["size"] = size
    return h


def apply(h):
    global CURRENT
    path = unescape(h["path"])
    CURRENT = path
    root, parts = split(path)
    op = h["op"]
    if not parts:
        # a root is the image's or a mount's: never removed, written
        # or given a mode
        raise Refused("root", path)
    fd = parent(path, root, parts)
    name = parts[-1]
    try:
        st = lstat_at(name, fd)
        if "was" in h:
            contested(h, name, fd, st)
        elif op == "rm":
            if st is None:
                return
            writable(fd)
            if stat.S_ISDIR(st.st_mode):
                try:
                    os.rmdir(name, dir_fd=fd)
                except OSError as e:
                    if e.errno in (errno.ENOTEMPTY, errno.EEXIST):
                        raise Refused("notempty", path)
                    raise
            else:
                os.unlink(name, dir_fd=fd)
        elif op == "dir":
            if st is None:
                writable(fd)
                os.mkdir(name, 0o700, dir_fd=fd)
            elif not stat.S_ISDIR(st.st_mode):
                raise Refused("kind", path)
            settle(name, fd, h)
        elif op == "meta":
            if st is None:
                raise Refused("missing", path)
            if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                raise Refused("kind", path)
            # a mode on a hard link would land on its other names too
            if stat.S_ISREG(st.st_mode) and st.st_nlink != 1:
                raise Refused("kind", path)
            settle(name, fd, h)
        elif h.get("append"):
            # a part after the first: the file the first part made, alone
            if st is None:
                raise Refused("missing", path)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                raise Refused("kind", path)
            flags = os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK
            out = os.open(name, flags, dir_fd=fd)
            write(out, h)
        else:
            if st is not None and stat.S_ISDIR(st.st_mode):
                raise Refused("kind", path)
            if st is not None:
                writable(fd)
                os.unlink(name, dir_fd=fd)
            create(name, fd, h)
    finally:
        os.close(fd)


def write(out, h):
    try:
        if not stat.S_ISREG(os.fstat(out).st_mode):
            raise Refused("kind", b"")
        copy(out, h["size"])
        os.fchmod(out, h["mode"])
        os.utime(out, ns=times(h))
    finally:
        os.close(out)


def main():
    global CURRENT
    n = 0
    try:
        while True:
            line = sys.stdin.buffer.readline(HEADER + 1)
            if not line:
                break
            if not line.endswith(b"\n"):
                raise Refused("header", b"")
            CURRENT = b""
            apply(header(line))
            n += 1
    except Refused as r:
        print("PUSH refused %s %s" % (r.args[0], escape(CURRENT) or "-"))
        sys.exit(2)
    except (OSError, OverflowError) as e:
        print("PUSH failed %s %s" % (errno.errorcode.get(getattr(e, "errno", None), "EIO"), escape(CURRENT) or "-"))
        sys.exit(1)
    print("PUSH ok %d" % n)


main()
