# cc: the base image's gcc target, which go and rust build on.

cc_compile() {
  cat >x.c <<'C'
#include <stdio.h>
int main(void) { printf("%d\n", 6 * 7); return 0; }
C
  gcc -o x x.c
  eq "$(./x)" 42
}

cc_cxx() {
  cat >x.cc <<'CC'
#include <iostream>
#include <vector>
int main() { std::vector<int> v{6, 7}; std::cout << v[0] * v[1] << "\n"; }
CC
  g++ -o x x.cc
  eq "$(./x)" 42
  pkg-config --version >/dev/null
}

offline_variant() {
  check "gcc compiles and runs a C file" cc_compile
  check "g++ compiles and runs a C++ file, pkg-config runs" cc_cxx
}
