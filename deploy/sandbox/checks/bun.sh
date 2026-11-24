# bun: Bun, with node and npx running on it.

bun_version() {
  eq "$(minor "$(bun --version)")" "$EXPECT_BUN"
}

bun_node() {
  eq "$(node -e 'console.log(process.versions.bun)')" "$(bun --version)"
  printf '#!/usr/bin/env node\nconsole.log("shebang")\n' >s.js
  chmod +x s.js
  eq "$(./s.js)" shebang
}

bun_typescript() {
  printf 'const n: number = 6 * 7;\nconsole.log(n);\n' >x.ts
  eq "$(bun run x.ts)" 42
}

# a workspace dependency links from disk, no registry, and its bin
# runs through npx and bunx
bun_workspace() {
  mkdir -p lib
  echo '{"name":"lib","version":"1.0.0","main":"i.js","bin":{"lib-bin":"b.js"}}' >lib/package.json
  echo 'module.exports = 42;' >lib/i.js
  printf '#!/usr/bin/env node\nconsole.log("bin");\n' >lib/b.js
  echo '{"name":"app","private":true,"workspaces":["lib"],"dependencies":{"lib":"workspace:*"}}' >package.json
  echo 'console.log(require("lib"));' >x.js
  bun install --silent
  eq "$(bun x.js)" 42
  eq "$(npx lib-bin)" bin
  eq "$(bunx lib-bin)" bin
}

# a global from disk runs by name: bun add -g's bin is on PATH
bun_global() {
  echo '{"name":"glob-check","version":"1.0.0","bin":{"glob-check":"b.js"}}' >package.json
  printf '#!/usr/bin/env node\nconsole.log("global");\n' >b.js
  bun add -g --silent "file:$PWD"
  eq "$(glob-check)" global
}

offline_variant() {
  check "bun is $EXPECT_BUN" bun_version
  check "node and a node shebang run on bun" bun_node
  check "bun runs TypeScript" bun_typescript
  check "bun links a workspace dependency, npx and bunx run its bin" bun_workspace
  check "bun add -g puts a command on PATH" bun_global
}

# a scoped name: its registry path holds an encoded slash
bun_fetch() {
  echo '{"name":"app","private":true}' >package.json
  bun add --silent @isaacs/string-locale-compare@1.1.0
  eq "$(bun -e 'console.log(require("@isaacs/string-locale-compare")("en")("a", "b"))')" -1
}

online_variant() {
  check "bun adds a scoped package from npm" bun_fetch
}
