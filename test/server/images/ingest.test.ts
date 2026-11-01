// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  ingest,
  keepsPng,
  tooManyPixels,
  UNREADABLE,
} from "../../../src/server/images/ingest.ts";
import {
  contentDisposition,
  imageName,
} from "../../../src/server/images/names.ts";
import {
  AVIF_REFUSED,
  HEIC_REFUSED,
  NOT_AN_IMAGE,
  SVG_REFUSED,
  sniff,
} from "../../../src/server/images/sniff.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  gif,
  jpegSegments,
  photo,
  pixelAt,
  png,
  screenshot,
  withExif,
} from "../../helpers/images.ts";

const CAPS = { maxPixels: 50_000_000, longSide: 2048 };
const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

// a flat red left half and a blue right half, wider than tall
const halves = (width = 300, height = 200) =>
  png(width, height, (x) => (x < width / 2 ? RED : BLUE));

const jpegOf = async (bytes: Uint8Array) =>
  new Uint8Array(await new Bun.Image(bytes).jpeg({ quality: 90 }).bytes());
const webpOf = async (bytes: Uint8Array, lossless = false) =>
  new Uint8Array(
    await new Bun.Image(bytes)
      .webp(lossless ? { lossless: true } : { quality: 80 })
      .bytes(),
  );
// the colour that wins at a pixel, past a JPEG's noise
const tone = (pixel: readonly number[]) =>
  pixel[0]! > 200 && pixel[2]! < 60
    ? "red"
    : pixel[2]! > 200 && pixel[0]! < 60
      ? "blue"
      : "other";
const refused = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequest);
    return (error as Error).message;
  }
  throw new Error("not refused");
};

describe("sniff", () => {
  test("reads the four admitted types from their bytes, with their alpha", async () => {
    expect(sniff(halves())).toEqual({
      ok: true,
      image: { format: "png", alpha: false },
    });
    expect(sniff(png(2, 2, () => RED, { alpha: true }))).toEqual({
      ok: true,
      image: { format: "png", alpha: true },
    });
    expect(sniff(await jpegOf(halves()))).toEqual({
      ok: true,
      image: { format: "jpeg", alpha: false },
    });
    expect(sniff(await webpOf(halves()))).toEqual({
      ok: true,
      image: { format: "webp", alpha: false },
    });
    const clear = png(4, 4, () => [0, 0, 0, 0], { alpha: true });
    expect(sniff(await webpOf(clear, true))).toMatchObject({
      image: { format: "webp", alpha: true },
    });
    const palette: [number, number, number][] = [
      [255, 0, 0],
      [0, 0, 255],
    ];
    expect(sniff(gif(4, 2, palette, [0]))).toEqual({
      ok: true,
      image: { format: "gif", alpha: false },
    });
    expect(sniff(gif(4, 2, palette, [0], 1))).toEqual({
      ok: true,
      image: { format: "gif", alpha: true },
    });
  });

  test("refuses SVG, HEIC, AVIF and anything else with their words", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const ftyp = (brand: string) =>
      new Uint8Array([0, 0, 0, 24, ...text("ftyp"), ...text(brand), 0, 0]);
    expect(sniff(text('﻿  <svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({
      ok: false,
      words: SVG_REFUSED,
    });
    expect(sniff(text('<?xml version="1.0"?><svg/>'))).toEqual({
      ok: false,
      words: SVG_REFUSED,
    });
    expect(sniff(ftyp("heic"))).toEqual({ ok: false, words: HEIC_REFUSED });
    expect(sniff(ftyp("mif1"))).toEqual({ ok: false, words: HEIC_REFUSED });
    expect(sniff(ftyp("avif"))).toEqual({ ok: false, words: AVIF_REFUSED });
    expect(sniff(text("hello"))).toEqual({ ok: false, words: NOT_AN_IMAGE });
    expect(sniff(new Uint8Array())).toEqual({ ok: false, words: NOT_AN_IMAGE });
  });
});

describe("the JPEG or PNG choice", () => {
  test("keeps alpha as PNG, a JPEG as JPEG, and a PNG near the JPEG's size", () => {
    const png = { format: "png", alpha: false } as const;
    expect(keepsPng({ format: "png", alpha: true }, 900, null)).toBe(true);
    expect(keepsPng({ format: "jpeg", alpha: false }, null, 900)).toBe(false);
    expect(keepsPng(png, 150, 100)).toBe(true);
    expect(keepsPng(png, 151, 100)).toBe(false);
  });

  test("a screenshot stays PNG and a photo saved as PNG becomes JPEG", async () => {
    const shot = await ingest(screenshot(), CAPS);
    expect(shot).toMatchObject({
      mediaType: "image/png",
      width: 1200,
      height: 800,
    });
    const grain = await ingest(photo(), CAPS);
    expect(grain).toMatchObject({
      mediaType: "image/jpeg",
      width: 1200,
      height: 800,
    });
  });
});

describe("ingest", () => {
  test("admits each type, re-encoded with its size and digest", async () => {
    const source = halves();
    for (const bytes of [source, await jpegOf(source), await webpOf(source)]) {
      const out = await ingest(bytes, CAPS);
      expect([out.width, out.height]).toEqual([300, 200]);
      expect(out.digest).toBe(
        new Bun.CryptoHasher("sha256").update(out.data).digest("hex"),
      );
      expect(sniff(out.data)).toMatchObject({ ok: true });
    }
    const alpha = await ingest(
      png(8, 8, (x) => (x < 4 ? RED : [0, 0, 0, 0]), { alpha: true }),
      CAPS,
    );
    expect(alpha.mediaType).toBe("image/png");
    expect(pixelAt(alpha.data, 6, 2)[3]).toBe(0);
  });

  test("a GIF keeps its first frame only", async () => {
    const palette: [number, number, number][] = [
      [255, 0, 0],
      [0, 0, 255],
    ];
    const out = await ingest(gif(16, 8, palette, [0, 1, 1]), CAPS);
    expect(out.mediaType).toBe("image/png");
    expect([out.width, out.height]).toEqual([16, 8]);
    expect(pixelAt(out.data, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  test("a header past the pixel cap is refused before a decode", async () => {
    // ten pixels of data under a header claiming ten billion
    const bomb = png(10, 10, () => RED, {
      alpha: true,
      declared: [100_000, 100_000],
    });
    expect(bomb.length).toBeLessThan(200);
    expect(await refused(ingest(bomb, CAPS))).toBe(tooManyPixels(50_000_000));
    expect(
      await refused(
        ingest(halves(1200, 1000), { ...CAPS, maxPixels: 1_000_000 }),
      ),
    ).toBe("the image is larger than 1 megapixels");
  });

  test("fits the long side and applies the Exif orientation", async () => {
    const wide = await ingest(halves(3000, 1000), CAPS);
    expect([wide.width, wide.height]).toEqual([2048, 683]);
    const small = await ingest(halves(3000, 1000), { ...CAPS, longSide: 600 });
    expect([small.width, small.height]).toEqual([600, 200]);
    // 6 turns it a quarter clockwise: the red left half ends on top
    const turned = await ingest(withExif(await jpegOf(halves()), 6), CAPS);
    expect(turned.mediaType).toBe("image/jpeg");
    expect([turned.width, turned.height]).toEqual([200, 300]);
    const pixels = new Uint8Array(
      await new Bun.Image(turned.data).png().bytes(),
    );
    expect(tone(pixelAt(pixels, 100, 20))).toBe("red");
    expect(tone(pixelAt(pixels, 100, 280))).toBe("blue");
  });

  test("drops the Exif segment, its GPS IFD with it", async () => {
    const tagged = withExif(await jpegOf(halves()), 1);
    expect(jpegSegments(tagged)).toContain("Exif");
    expect(Buffer.from(tagged).includes(Buffer.from("Exif"))).toBe(true);
    const out = await ingest(tagged, CAPS);
    expect(jpegSegments(out.data)).not.toContain("Exif");
    expect(Buffer.from(out.data).includes(Buffer.from("Exif"))).toBe(false);
  });

  test("refuses what is not an admitted image, whatever it claims", async () => {
    expect(
      await refused(ingest(new TextEncoder().encode("<svg/>"), CAPS)),
    ).toBe(SVG_REFUSED);
    // a PNG signature over nothing a decoder can read
    const broken = new Uint8Array([...halves().subarray(0, 40), 1, 2, 3]);
    expect(await refused(ingest(broken, CAPS))).toBe(UNREADABLE);
  });
});

describe("names", () => {
  test("keep the last path part, drop controls and take the kept type's extension", () => {
    expect(imageName("IMG_0001.HEIC.webp", "image/jpeg")).toBe(
      "IMG_0001.HEIC.jpg",
    );
    expect(imageName("../../etc/pass\u0000wd.png", "image/png")).toBe(
      "passwd.png",
    );
    expect(imageName(null, "image/png")).toBe("image.png");
    expect(imageName("  ", "image/jpeg")).toBe("image.jpg");
    expect(imageName("x".repeat(500), "image/png")).toHaveLength(120);
  });

  test("a disposition has an ASCII fallback and the exact name encoded", () => {
    expect(contentDisposition('Ünïcode "shot" (1).png')).toBe(
      `inline; filename="_n_code _shot_ (1).png"; filename*=UTF-8''%C3%9Cn%C3%AFcode%20%22shot%22%20%281%29.png`,
    );
  });
});
