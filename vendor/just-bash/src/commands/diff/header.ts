/**
 * (1ctx diff) How GNU diff 3.12 names files: in a context or unified header a
 * name holding a space, a double quote or a control character is quoted
 * C-style, and in its messages a name is quoted for the shell as coreutils
 * does. A header's time is the file's in the sandbox's TZ.
 */

const C_ESCAPES: Record<string, string> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
};

function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

function octal(code: number): string {
  return `\\${code.toString(8).padStart(3, "0")}`;
}

/** A name as a context or unified header prints it. */
export function headerName(name: string): string {
  let quote = false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (isControl(code) || name[i] === " " || name[i] === '"') quote = true;
  }
  if (!quote) return name;
  let out = '"';
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (ch === "\\" || ch === '"') out += `\\${ch}`;
    else if (C_ESCAPES[ch]) out += C_ESCAPES[ch];
    else if (isControl(code)) out += octal(code);
    else out += ch;
  }
  return `${out}"`;
}

/** Characters that make a shell word need quotes wherever they stand. */
const SHELL_SPECIAL = new Set("\t\n !\"$&'()*;<=>?[\\^`|");
/** What may sit inside double quotes with nothing escaped. */
const PLAIN = /^[A-Za-z0-9%+,\-./:\]_ ']$/;

function needsQuotes(name: string): boolean {
  if (name === "") return true;
  if (name === "{" || name === "}") return true;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (SHELL_SPECIAL.has(ch) || isControl(ch.charCodeAt(0))) return true;
    if (i === 0 && (ch === "#" || ch === "~")) return true;
  }
  return false;
}

/**
 * A name quoted for the shell as gnulib's quotearg quotes it: bare when
 * nothing in it is special, in double quotes when it holds an apostrophe
 * and only plain characters besides, else in single quotes. With
 * `escapes` (diff's messages) a control character is written `$'\n'`,
 * without (the options on the line naming each pair) as it is.
 */
function quoteShell(name: string, escapes: boolean): string {
  if (!needsQuotes(name)) return name;
  const chars = [...name];
  if (
    name.includes("'") &&
    chars.every(
      (ch, i) =>
        PLAIN.test(ch) ||
        ch.charCodeAt(0) > 0x7f ||
        (i === 0 && (ch === "#" || ch === "~")),
    )
  ) {
    return `"${name}"`;
  }
  let out = "";
  let run = "";
  let escaped = "";
  const flushRun = () => {
    if (run !== "") out += `'${run.replaceAll("'", "'\\''")}'`;
    run = "";
  };
  const flushEscaped = () => {
    if (escaped !== "") out += `$'${escaped}'`;
    escaped = "";
  };
  for (const ch of chars) {
    const code = ch.charCodeAt(0);
    if (escapes && isControl(code)) {
      flushRun();
      escaped += C_ESCAPES[ch] ?? octal(code);
    } else {
      flushEscaped();
      run += ch;
    }
  }
  flushRun();
  flushEscaped();
  return out === "" ? "''" : out;
}

/** A name as diff's messages print it, quoted for a shell when it must be. */
export function shellName(name: string): string {
  return quoteShell(name, true);
}

/** An option as the line naming each pair of a directory prints it. */
export function shellWord(arg: string): string {
  return quoteShell(arg, false);
}

/** A name as GNU's locale quoting prints it in a UTF-8 locale. */
export function localeQuote(name: string): string {
  return `\u2018${name}\u2019`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The UTC offset in minutes at `date` in `tz`, 0 when tz is unknown. */
function offsetMinutes(date: Date, tz: string | undefined): number {
  if (!tz || tz === "UTC" || tz === "UTC0" || tz === "GMT") return 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    const local = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return Math.round(
      (local - Math.floor(date.getTime() / 1000) * 1000) / 60000,
    );
  } catch {
    return 0;
  }
}

/** `2026-09-29 12:52:48.311000000 +0000`, as GNU's headers print a time. */
export function headerTime(date: Date, tz: string | undefined): string {
  const offset = offsetMinutes(date, tz);
  const local = new Date(date.getTime() + offset * 60000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.` +
    `${pad(local.getUTCMilliseconds(), 3)}000000 ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}
