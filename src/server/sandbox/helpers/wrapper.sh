# The sandbox's command wrapper, run as
#   bash --noprofile --norc -c <this> bash <cwd> <id> <on|off> <base>
#     <python> <under> <docs 1|0> <max files> <limit> <limit words>
#     <repo limit or -> <repo words> <open source>
# with the command as its whole stdin, since the gateway refuses an
# argument past 32 KiB and a heredoc that writes a file runs longer.
# It forks nothing before the command: the final $PWD goes to
# <base>/<id>.cwd on exit, raw, the whole file being the path, and open
# copies land in <base>/<id>.opened/.
# The records' contract: the id is random per command (128 bits) and
# never reused, and the server removes the records it read. A record
# already standing for this id was planted, so the wrapper refuses to
# start (exit 126, WRAPPER records exist) and the server recycles. The
# records live where the command writes, so they are hostile: the
# command may replace them, or the functions this script calls, and the
# server checks every record it reads.
if [[ -e $4/$2.cwd || -L $4/$2.cwd || -e $4/$2.opened || -L $4/$2.opened ]]; then
  builtin echo "WRAPPER records exist" >&2
  builtin exit 126
fi
# read to the end (its status is 1 there); then the command reads no
# stdin, as in the built-in shell, so open's check and a stray read
# never wait on the exec's stream
IFS= builtin read -r -d '' __1ctx_c
exec </dev/null
builtin cd -- "$1" 2>/dev/null || builtin cd -- "$HOME" 2>/dev/null || builtin cd /
builtin printf -v __1ctx_q %q "$4/$2.cwd"
builtin trap "builtin printf %s \"\$PWD\" >| $__1ctx_q" EXIT
if [[ $3 == on ]]; then
  builtin printf -v __1ctx_q '%q ' "$5" -I -S -c "${13}" "$4/$2.opened" \
    "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}"
  builtin eval "open() { $__1ctx_q\"\$PWD\" \"\$@\"; }"
  builtin export -f open
fi
builtin unset __1ctx_q
builtin set --
builtin eval "$__1ctx_c"
