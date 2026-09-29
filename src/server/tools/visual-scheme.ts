// Each function runs inside the frame from its source text, so none may
// reach outside its own body.

// A sandboxed frame answers prefers-color-scheme from the system, not the
// chat's theme, so a visual that switches palettes on it can draw dark in a
// light chat. Its media queries are rewritten to features that hold or fail
// by the chat's theme instead.
export function visualSchemeQuery(
  text: string,
  scheme: "light" | "dark",
): string {
  return text.replace(
    /\(\s*prefers-color-scheme\s*(?::\s*([a-z-]+)\s*)?\)/gi,
    (_match, value?: string) =>
      !value || value.toLowerCase() === scheme
        ? "(min-width: 0px)"
        : "(max-width: 0px)",
  );
}

// How a whole page meets the chat's ground. It goes bare when its text
// reads there and it draws no image. Otherwise a page that paints no
// background of its own gets the plain backdrop a browser's canvas would
// give it, light or dark, whichever its text reads on, since the frame
// itself is see-through.
export function visualGround(
  page: {
    text: number[] | null;
    chat: number[] | null;
    image: boolean;
    color: boolean;
  },
  contrast: (a: number[], b: number[]) => number,
): { bare: boolean; backdrop: "light" | "dark" | null } {
  const { text, chat } = page;
  if (!text) return { bare: false, backdrop: null };
  if (!page.image && chat && contrast(text, chat) >= 4.5)
    return { bare: true, backdrop: null };
  if (page.image || page.color) return { bare: false, backdrop: null };
  return {
    bare: false,
    backdrop:
      contrast(text, [255, 255, 255]) >= contrast(text, [0, 0, 0])
        ? "light"
        : "dark",
  };
}

// The WCAG contrast ratio of two opaque sRGB colours.
export function visualContrast(a: number[], b: number[]): number {
  const luminance = ([r, g, b]: number[]) => {
    const [x, y, z] = [r, g, b].map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * x + 0.7152 * y + 0.0722 * z;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
