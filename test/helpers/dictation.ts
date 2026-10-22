// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A clip as the composer writes it: the canonical 44-byte WAV header
// over 16-bit PCM, mono, 16 kHz. A field may be overridden to make the
// headers the route refuses.

export type WavFields = {
  riff: string;
  wave: string;
  fmt: string;
  fmtSize: number;
  format: number;
  channels: number;
  rate: number;
  byteRate: number;
  blockAlign: number;
  bits: number;
  data: string;
  // the sizes the header claims; the body's own by default
  riffSize: number;
  dataSize: number;
};

export function wavOf(
  dataBytes: number,
  over: Partial<WavFields> = {},
): Uint8Array<ArrayBuffer> {
  const f: WavFields = {
    riff: "RIFF",
    wave: "WAVE",
    fmt: "fmt ",
    fmtSize: 16,
    format: 1,
    channels: 1,
    rate: 16_000,
    byteRate: 32_000,
    blockAlign: 2,
    bits: 16,
    data: "data",
    riffSize: 36 + dataBytes,
    dataSize: dataBytes,
    ...over,
  };
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, f.riff);
  view.setUint32(4, f.riffSize, true);
  tag(8, f.wave);
  tag(12, f.fmt);
  view.setUint32(16, f.fmtSize, true);
  view.setUint16(20, f.format, true);
  view.setUint16(22, f.channels, true);
  view.setUint32(24, f.rate, true);
  view.setUint32(28, f.byteRate, true);
  view.setUint16(32, f.blockAlign, true);
  view.setUint16(34, f.bits, true);
  tag(36, f.data);
  view.setUint32(40, f.dataSize, true);
  // a quiet ramp, so the samples are not all zero
  for (let i = 44; i < bytes.length; i++) bytes[i] = i % 7;
  return bytes;
}
