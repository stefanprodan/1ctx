# The sandbox's pull helper, run as
#   python3 -I -S -c <this> <file bytes> <root>...
# stdin: one percent-escaped path per line. For each, a frame on stdout:
# a JSON header line {"path","size","mode"} then exactly `size` bytes, or
# {"path","missing":true} when the path is no longer a regular file
# reached without a link. Ends with PULL done <n>. A file past <file
# bytes> ends it with PULL refused size before a byte of it is sent.
import errno, json, os, re, stat, sys

PIECE = 1 << 16
LINE = 1 << 16
ESCAPED = re.compile(rb"(?:[\x21-\x24\x26-\x7e]|%[0-9A-F]{2})+")
SEARCH = getattr(os, "O_PATH", os.O_RDONLY)
out = sys.stdout.buffer


def escape(raw):
    return "".join(
        chr(b) if 0x21 <= b <= 0x7E and b != 0x25 else "%%%02X" % b for b in raw
    )


def refuse(word):
    out.write(("PULL refused %s\n" % word).encode("ascii"))
    out.flush()
    sys.exit(2)


def unescape(raw):
    if not ESCAPED.fullmatch(raw):
        refuse("name")
    data = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0x25:
            data.append(int(raw[i + 1 : i + 3], 16))
            i += 3
        else:
            data.append(raw[i])
            i += 1
    if escape(data) != raw.decode("ascii"):
        refuse("name")
    return bytes(data)


if len(sys.argv) < 2 or not re.fullmatch(r"(0|[1-9][0-9]{0,15})", sys.argv[1]):
    refuse("usage")
CAP = int(sys.argv[1])
ROOTS = [os.fsencode(a) for a in sys.argv[2:]]


def split(path):
    for root in ROOTS:
        if path.startswith(root + b"/"):
            parts = path[len(root) + 1 :].split(b"/")
            if any(p in (b"", b".", b"..") for p in parts) or b"\0" in path:
                refuse("name")
            return root, parts
    refuse("outside")


# the file's handle, every folder on the way opened without following a
# link; None when any step is not what it must be
def reach(root, parts):
    flags = SEARCH | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        fd = os.open(root, flags)
    except OSError:
        return None
    try:
        for part in parts[:-1]:
            nxt = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = nxt
        # O_NONBLOCK, so a fifo standing there never holds the open
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        return os.open(parts[-1], flags, dir_fd=fd)
    except OSError:
        return None
    finally:
        os.close(fd)


def frame(esc, fd):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        head = {"path": esc, "missing": True}
        out.write(json.dumps(head, separators=(",", ":")).encode("ascii") + b"\n")
        return
    size = st.st_size
    if size > CAP:
        refuse("size")
    head = {"path": esc, "size": size, "mode": stat.S_IMODE(st.st_mode)}
    out.write(json.dumps(head, separators=(",", ":")).encode("ascii") + b"\n")
    left = size
    while left:
        b = os.read(fd, min(left, PIECE))
        if not b:
            # the header promised more bytes than the file still holds,
            # so the stream can only end here, without its last line
            out.flush()
            sys.exit(1)
        out.write(b)
        left -= len(b)


def main():
    n = 0
    while True:
        raw = sys.stdin.buffer.readline(LINE + 1)
        if not raw:
            break
        if not raw.endswith(b"\n"):
            refuse("line")
        esc = raw[:-1]
        root, parts = split(unescape(esc))
        fd = reach(root, parts)
        if fd is None:
            head = {"path": esc.decode("ascii"), "missing": True}
            out.write(json.dumps(head, separators=(",", ":")).encode("ascii") + b"\n")
        else:
            try:
                frame(esc.decode("ascii"), fd)
            finally:
                os.close(fd)
        n += 1
    out.write(("PULL done %d\n" % n).encode("ascii"))
    out.flush()


main()
