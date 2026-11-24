# python: the base alone. uv keeps its cache, tools and Pythons in HOME.

python_venv() {
  uv venv -q --offline .venv
  mkdir -p pkg
  echo 'VALUE = 42' >pkg/mod.py
  eq "$(PYTHONPATH=pkg .venv/bin/python -c 'import mod; print(mod.VALUE)')" 42
}

python_alone() {
  local t
  for t in bun node go cargo gcc; do
    if command -v "$t" >/dev/null; then
      echo "has $t"
      return 1
    fi
  done
}

# uv tool install's bin is on PATH, so an installed tool runs by name
python_tool_bin() {
  case ":$PATH:" in
  *":$(uv tool dir --bin):"*) ;;
  *)
    echo "$(uv tool dir --bin) is not on PATH"
    return 1
    ;;
  esac
}

offline_variant() {
  check "uv makes a venv that imports a local module" python_venv
  check "uv's tool bin is on PATH" python_tool_bin
  check "no other toolchain" python_alone
}

python_fetch() {
  eq "$(uv run -q --no-project --with six==1.17.0 python -c 'import six; print(six.__version__)')" 1.17.0
}

online_variant() {
  check "uv installs a package from PyPI" python_fetch
}
