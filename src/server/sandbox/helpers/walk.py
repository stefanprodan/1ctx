# The sandbox's walk helper, run as
#   python3 -I -S -c <this> <max entries> <max file> <max total> <root>...
# One line per entry, the roots included, a folder before what it holds:
#   <type> <mode> <size> <nlink> <sha256 or -> <path>
# type d, f, l (a link) or o (anything else, a folder on another mount
# too, never entered); mode in octal. The path is percent-escaped so a
# name never breaks a line. A folder or file it cannot read is an E line
# (E <errno> <path>); the server reads ENOENT as gone and ESTALE, ELOOP
# or ENOTDIR as moved only while other commands run. A file not hashed
# counts toward neither the entries nor the bytes here; the server still
# counts its name's bytes. Before going past a bound it stops with
# WALK over <entries|file|bytes> <bound>: a file is sized before it is
# read, so a huge or sparse file costs nothing.
import errno, hashlib, os, stat, sys

PIECE = 1 << 16
out = sys.stdout.buffer


def escape(raw):
    return "".join(
        chr(b) if 0x21 <= b <= 0x7E and b != 0x25 else "%%%02X" % b for b in raw
    )


def line(text):
    out.write(text.encode("ascii") + b"\n")


def failed(e, path):
    line("E %s %s" % (errno.errorcode.get(e.errno, "EIO"), escape(path)))


def digest(path, st):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        now = os.fstat(fd)
        # the inode listed, so a swap between the two calls cannot pass
        if (now.st_dev, now.st_ino) != (st.st_dev, st.st_ino):
            raise OSError(errno.ESTALE, "changed")
        # never past the size listed and bounded, so a file growing
        # under the read cannot make it longer
        h = hashlib.sha256()
        left = st.st_size
        while left:
            b = os.read(fd, min(left, PIECE))
            if not b:
                raise OSError(errno.ESTALE, "shrank")
            h.update(b)
            left -= len(b)
        if os.read(fd, 1):
            raise OSError(errno.ESTALE, "grew")
        return h.hexdigest()
    finally:
        os.close(fd)


def over(what, bound):
    line("WALK over %s %d" % (what, bound))
    out.flush()
    sys.exit(5)


def main():
    limit, most, total = (int(a) for a in sys.argv[1:4])
    n = 0
    held = 0
    for root in (os.fsencode(a) for a in sys.argv[4:]):
        try:
            dev = os.stat(root, follow_symlinks=False).st_dev
        except OSError as e:
            failed(e, root)
            continue
        stack = [root]
        while stack:
            path = stack.pop()
            try:
                st = os.stat(path, follow_symlinks=False)
            except OSError as e:
                failed(e, path)
                continue
            if n >= limit:
                over("entries", limit)
            n += 1
            mode = stat.S_IMODE(st.st_mode)
            kind = st.st_mode
            if stat.S_ISDIR(kind) and st.st_dev == dev:
                # each name waiting is an entry to come, so a folder wider
                # than what is left stops before it is held or sorted
                room = limit - n - len(stack)
                names = []
                try:
                    with os.scandir(path) as found:
                        for entry in found:
                            if len(names) >= room:
                                over("entries", limit)
                            names.append(entry.name)
                    names.sort(reverse=True)
                except OSError as e:
                    n -= 1
                    failed(e, path)
                    continue
                line("d %o 0 %d - %s" % (mode, st.st_nlink, escape(path)))
                stack.extend(path + b"/" + name for name in names)
            elif stat.S_ISREG(kind):
                if st.st_size > most:
                    over("file", most)
                held += st.st_size
                if held > total:
                    over("bytes", total)
                try:
                    sha = digest(path, st)
                except OSError as e:
                    n -= 1
                    held -= st.st_size
                    failed(e, path)
                    continue
                line("f %o %d %d %s %s" % (mode, st.st_size, st.st_nlink, sha, escape(path)))
            else:
                t = "l" if stat.S_ISLNK(kind) else "o"
                line("%s %o %d %d - %s" % (t, mode, st.st_size, st.st_nlink, escape(path)))
    line("WALK done %d" % n)
    out.flush()


main()
