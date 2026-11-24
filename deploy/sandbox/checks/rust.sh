# rust: rustup and cargo, both homes in HOME and owned by the sandbox
# user, since /usr is read-only.

rust_version() {
  eq "$(minor "$(rustc --version)")" "$EXPECT_RUST"
  eq "$(minor "$(cargo --version)")" "$EXPECT_RUST"
}

# the copied homes belong to the sandbox user all the way down, so
# rustup and cargo can write anywhere in them
rust_homes() {
  rustup show active-toolchain >/dev/null
  local foreign
  foreign=$(find "$RUSTUP_HOME" "$CARGO_HOME" ! -user "$(id -u)" -print -quit)
  eq "${foreign:-none}" none
}

# a path dependency builds with no registry
rust_crate() {
  cargo new -q --offline --lib lib
  echo 'pub fn answer() -> u32 { 42 }' >lib/src/lib.rs
  cargo new -q --offline app
  cd app
  echo 'lib = { path = "../lib" }' >>Cargo.toml
  echo 'fn main() { println!("{}", lib::answer()); }' >src/main.rs
  eq "$(cargo run -q --offline)" 42
}

rust_install() {
  cargo new -q --offline hi-check
  cargo install -q --offline --path hi-check
  eq "$(command -v hi-check)" "$CARGO_HOME/bin/hi-check"
  eq "$(hi-check)" "Hello, world!"
}

offline_variant() {
  check "rustc and cargo are $EXPECT_RUST" rust_version
  check "rustup and cargo own their homes in HOME" rust_homes
  check "cargo builds a crate with a path dependency" rust_crate
  check "cargo install puts a binary in CARGO_HOME/bin, on PATH" rust_install
}

# a crate from crates.io, built for a target rustup adds into the
# copied home
rust_fetch() {
  rustup target add wasm32-unknown-unknown
  cargo new -q --offline app
  cd app
  echo 'itoa = "=1.0.15"' >>Cargo.toml
  echo 'fn main() { println!("{}", itoa::Buffer::new().format(42)); }' >src/main.rs
  eq "$(cargo run -q)" 42
  cargo build -q --target wasm32-unknown-unknown
  test -f target/wasm32-unknown-unknown/debug/app.wasm
}

online_variant() {
  check "cargo adds a crate from crates.io, rustup adds a target" rust_fetch
}
