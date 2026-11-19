# The sandbox's fence, run as
#   bash --noprofile --norc -c <this> fence <keep pid> <keep start time>
# Stops every process of its own uid but pid 1, the keep-alive and
# itself, round after round until a round stops none, then kills them
# all and checks none is left. Bash builtins only, no command
# substitution, pipe or subshell: the fence forks nothing, so it never
# lists a child of its own. Exits 3 when the rounds never settle, 4 when
# a process survives the kill, 5 on a bad argument or no /proc, 6 when
# the keep-alive is gone or its pid now names another process.
keep=$1
born=$2
me=$$
[[ $keep =~ ^[1-9][0-9]*$ && $born =~ ^[0-9]+$ && -d /proc/self ]] ||
  { builtin echo "FENCE usage"; builtin exit 5; }
# the start time, field 22 of stat: read whole and cut after the last ),
# since the command name before it may hold ) and newlines; the split
# runs with globbing off, which list's /proc/[1-9]* needs back on
builtin read -r -d '' stat 2>/dev/null <"/proc/$keep/stat"
builtin set -f
fields=(${stat##*)})
builtin set +f
started=${fields[19]}
[[ $started == "$born" ]] || { builtin echo "FENCE keep"; builtin exit 6; }

# L: every pid of our uid but the spared and the zombies, each as
# pid:state. Uid and State come from status, where the kernel escapes
# the name, so no name can forge a line; a zombie holds nothing and
# cannot be stopped, and any other state counts as alive
list() {
  L=()
  local d p k v rest uid state
  for d in /proc/[1-9]*; do
    p=${d#/proc/}
    [[ $p == 1 || $p == "$keep" || $p == "$me" ]] && continue
    uid=
    state=
    while builtin read -r k v rest; do
      [[ $k == State: && -z $state ]] && state=$v
      [[ $k == Uid: ]] && { uid=$v; break; }
    done 2>/dev/null <"$d/status"
    [[ -n $uid && $uid == "$UID" ]] || continue
    # a leader that exited alone reads Z while its other threads run:
    # the group is alive while any thread is not Z, and takes its state
    [[ $state == Z ]] && { live "$d"; [[ -z $T ]] && continue; state=$T; }
    L+=("$p:${state:-?}")
  done
}

# T: the state of the first thread of $1 that is not a zombie, or empty
live() {
  T=
  local t k v rest s
  for t in "$1"/task/[1-9]*; do
    s=
    while builtin read -r k v rest; do
      [[ $k == State: ]] && { s=$v; break; }
    done 2>/dev/null <"$t/status"
    [[ -n $s && $s != Z ]] && { T=$s; return; }
  done
}

stopped=0
round=0
while ((round < 200)); do
  round=$((round + 1))
  new=0
  list
  for e in "${L[@]}"; do
    [[ ${e#*:} == T || ${e#*:} == t ]] && continue
    builtin kill -STOP "${e%%:*}" 2>/dev/null
    new=$((new + 1))
  done
  ((new == 0)) && break
  stopped=$((stopped + new))
done
((new != 0)) && { builtin echo "FENCE unstable"; builtin exit 3; }

list
for e in "${L[@]}"; do builtin kill -KILL "${e%%:*}" 2>/dev/null; done
# a killed process leaves the list once it is a zombie. The wait is a
# read timing out on a pty master nothing writes to, never a sleep,
# which would fork; /dev/null answers at once, so without a pty the
# rounds only run faster
builtin exec {pause}<>/dev/ptmx 2>/dev/null || builtin exec {pause}</dev/null
for ((i = 0; i < 100; i++)); do
  list
  ((${#L[@]} == 0)) && break
  builtin read -r -t 0.02 -u "$pause" _ 2>/dev/null
done
((${#L[@]} != 0)) && { builtin echo "FENCE survivors ${#L[@]}"; builtin exit 4; }
builtin echo "FENCE ok stopped=$stopped rounds=$round"
