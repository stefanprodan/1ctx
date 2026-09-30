// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// the precisions OpenRouter filters its hosts by (provider.quantizations);
// unknown is a host that does not say, left out unless named
export const QUANTIZATIONS = [
  "int4",
  "int8",
  "fp4",
  "mxfp4",
  "nvfp4",
  "fp6",
  "fp8",
  "mxfp8",
  "fp16",
  "bf16",
  "fp32",
  "unknown",
] as const;
export type Quantization = (typeof QUANTIZATIONS)[number];
export const FOUR_BIT: readonly Quantization[] = [
  "int4",
  "fp4",
  "mxfp4",
  "nvfp4",
];
// every precision but 4 bits, unknown included: a host that does not say
// may be anything, and leaving them all out loses most hosts of a model
export const NOT_FOUR_BIT: readonly Quantization[] = QUANTIZATIONS.filter(
  (q) => !FOUR_BIT.includes(q),
);
export function isFourBit(quantization: string): boolean {
  return (FOUR_BIT as readonly string[]).includes(quantization.toLowerCase());
}
// an endpoint tag names its precision after the slash, deepinfra/fp4
export function isFourBitTag(tag: string): boolean {
  return tag.split("/").slice(1).some(isFourBit);
}
// the endpoint's precision decides, its tag's suffix when it does not say
export function fourBitEndpoint(e: {
  tag: string;
  quantization: string | null;
}): boolean {
  return e.quantization !== null && e.quantization.toLowerCase() !== "unknown"
    ? isFourBit(e.quantization)
    : isFourBitTag(e.tag);
}
