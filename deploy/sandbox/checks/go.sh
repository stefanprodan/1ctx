# go: Go with cgo. GOROOT is read-only; GOPATH and both caches are in HOME.

go_version() {
  eq "$(minor "$(go version)")" "$EXPECT_GO"
  eq "$(go env CGO_ENABLED)" 1
}

# a module with a local replace builds with the proxy off
go_module() {
  mkdir -p lib
  printf 'module example.test/lib\n\ngo 1.21\n' >lib/go.mod
  printf 'package lib\n\nfunc Answer() int { return 42 }\n' >lib/lib.go
  cat >go.mod <<'EOF'
module example.test/app

go 1.21

require example.test/lib v0.0.0

replace example.test/lib => ./lib
EOF
  cat >main.go <<'EOF'
package main

import (
	"fmt"

	"example.test/lib"
)

func main() { fmt.Println(lib.Answer()) }
EOF
  eq "$(GOPROXY=off GOFLAGS=-mod=mod go run .)" 42
}

go_cgo() {
  printf 'module example.test/cgo\n\ngo 1.21\n' >go.mod
  cat >main.go <<'EOF'
package main

// static int twice(int x) { return 2 * x; }
import "C"
import "fmt"

func main() { fmt.Println(C.twice(21)) }
EOF
  eq "$(GOPROXY=off go run .)" 42
}

go_install() {
  printf 'module example.test/hi\n\ngo 1.21\n' >go.mod
  printf 'package main\n\nfunc main() { println("hi") }\n' >main.go
  GOPROXY=off go install .
  eq "$(command -v hi)" "$(go env GOPATH)/bin/hi"
}

offline_variant() {
  check "go is $EXPECT_GO with cgo on" go_version
  check "go builds a module with a local replace" go_module
  check "cgo builds and runs" go_cgo
  check "go install puts a binary in GOPATH/bin, on PATH" go_install
}

go_fetch() {
  printf 'module example.test/fetch\n\ngo 1.21\n' >go.mod
  printf 'package main\n\nimport (\n\t"fmt"\n\n\t"rsc.io/quote/v4"\n)\n\nfunc main() { fmt.Println(quote.Go() != "") }\n' >main.go
  go get rsc.io/quote/v4@v4.0.1
  eq "$(go run .)" true
}

online_variant() {
  check "go fetches a module through the proxy" go_fetch
}
