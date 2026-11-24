# cc: the base image's gcc target, which go and rust build on.

cc_compile() {
  cat >x.c <<'C'
#include <stdio.h>
int main(void) { printf("%d\n", 6 * 7); return 0; }
C
  gcc -o x x.c
  eq "$(./x)" 42
}

offline_variant() {
  check "gcc compiles and runs a C file" cc_compile
}
