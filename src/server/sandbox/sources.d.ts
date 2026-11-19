// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the fixed helpers' sources, imported with type text so the binary
// carries them and passes them as exec arguments
declare module "*.py" {
  const text: string;
  export default text;
}
declare module "*.sh" {
  const text: string;
  export default text;
}
