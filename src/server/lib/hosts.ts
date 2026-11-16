// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Hosts an agent's request never reaches unless an admin named them:
// loopback, private, link-local and other non-public addresses, judged
// on the URL's host alone. No lookup, so a public name that resolves
// to a private address still passes.

type V4 = [number, number, number, number];

function privateV4([a, b, c]: V4): boolean {
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function parseV4(text: string): V4 | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : 256,
  );
  return octets.every((octet) => octet <= 255) ? (octets as V4) : null;
}

// eight hextets, or null; the URL parser has already compressed and
// lowercased the address, a dotted tail is read for other callers
function parseV6(text: string): number[] | null {
  let tail: number[] = [];
  let head = text;
  const colon = text.lastIndexOf(":");
  if (text.includes(".") && colon !== -1) {
    const v4 = parseV4(text.slice(colon + 1));
    if (v4 === null) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = text.slice(0, colon + 1);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = groups(halves[0]);
  const right = halves.length === 2 ? groups(halves[1]) : [];
  const given = left.length + right.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  const hex = (group: string) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : -1;
  const hextets = [
    ...left.map(hex),
    ...new Array(8 - given).fill(0),
    ...right.map(hex),
    ...tail,
  ];
  return hextets.every((h) => h >= 0) ? hextets : null;
}

const embedded = (high: number, low: number): V4 => [
  high >>> 8,
  high & 0xff,
  low >>> 8,
  low & 0xff,
];

function privateV6(h: number[]): boolean {
  const zeros = (from: number, to: number) =>
    h.slice(from, to).every((x) => x === 0);
  // ::/96 holds :: and ::1; ::ffff:0:0/96 is IPv4-mapped
  if (zeros(0, 6) || (zeros(0, 5) && h[5] === 0xffff)) {
    return privateV4(embedded(h[6], h[7]));
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    // NAT64: the well-known prefix embeds IPv4, the local-use one is local
    return h[2] === 1 || (zeros(2, 6) && privateV4(embedded(h[6], h[7])));
  }
  if (h[0] === 0x2002) return privateV4(embedded(h[1], h[2])); // 6to4
  return (
    (h[0] & 0xfe00) === 0xfc00 || // unique local
    (h[0] & 0xffc0) === 0xfe80 || // link-local
    (h[0] & 0xffc0) === 0xfec0 || // site-local
    (h[0] & 0xff00) === 0xff00 // multicast
  );
}

// a URL's hostname as `new URL()` gives it: IPv4 always dotted decimal,
// IPv6 bracketed, a name maybe with a trailing dot
export function privateHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[") && host.endsWith("]")) {
    const hextets = parseV6(host.slice(1, -1));
    return hextets !== null && privateV6(hextets);
  }
  const v4 = parseV4(host);
  return v4 !== null && privateV4(v4);
}
