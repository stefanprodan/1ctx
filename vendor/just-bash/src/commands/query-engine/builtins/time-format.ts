/**
 * jq's time builtins as jq 1.8 on glibc runs them (1ctx jq-dates)
 *
 * A broken-down time is jq's array: year, month from 0, day, hour,
 * minute, second, weekday from Sunday, day of the year from 0. gmtime
 * and mktime are plain UTC arithmetic on the proleptic Gregorian
 * calendar, so any year works; strftime takes C's conversions in the C
 * locale, with glibc's flags and widths; strptime follows glibc's, the
 * weekday and day of the year filled in only when a date was read, and
 * the 8 and 367 jq leaves as markers otherwise. Local time is the TZ variable's zone through Intl,
 * UTC when it is unset or unknown.
 */

export type Tm = number[];

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Days from 1970-01-01 to a date, the month from 0 and either overflowing. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y0 = year + Math.floor(month / 12);
  const m = mod(month, 12);
  const y = m < 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * ((m + 10) % 12) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 2 : mp - 10;
  return [yoe + era * 400 + (month < 2 ? 1 : 0), month, day];
}

/** gmtime: the seconds cut toward zero, their fraction kept as jq does. */
export function gmtimeOf(seconds: number): Tm {
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 8.64e15) {
    throw new Error("error converting number of seconds since epoch to datetime");
  }
  const whole = Math.trunc(seconds);
  const days = Math.floor(whole / 86400);
  const rest = whole - days * 86400;
  const [year, month, day] = civilFromDays(days);
  return [
    year,
    month,
    day,
    Math.floor(rest / 3600),
    Math.floor((rest % 3600) / 60),
    (rest % 60) + (seconds - Math.floor(seconds)),
    mod(days + 4, 7),
    days - daysFromCivil(year, 0, 1),
  ];
}

/** A jq broken-down time read as C's struct tm: missing fields are 0, the year 1900. */
export function tmFields(value: unknown, fn: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${fn} requires array inputs`);
  if (!value.every((v) => typeof v === "number")) {
    throw new Error(`${fn} requires parsed datetime inputs`);
  }
  const at = (i: number, fallback = 0) =>
    Math.trunc(i < value.length ? (value[i] as number) : fallback);
  return [at(0, 1900), at(1), at(2), at(3), at(4), at(5)];
}

/** timegm over the fields of a broken-down time. */
export function timegm(fields: number[]): number {
  const [year, month, day, hour, minute, second] = fields;
  return (
    daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second
  );
}

function isoWeek(tm: Tm): [number, number] {
  const weeks = (y: number) => {
    const p = (n: number) =>
      mod(n + Math.floor(n / 4) - Math.floor(n / 100) + Math.floor(n / 400), 7);
    return p(y) === 4 || p(y - 1) === 3 ? 53 : 52;
  };
  const year = tm[0];
  const week = Math.floor((tm[7] - mod(tm[6] + 6, 7) + 10) / 7);
  if (week < 1) return [year - 1, weeks(year - 1)];
  if (week > weeks(year)) return [year + 1, 1];
  return [year, week];
}

export interface Zone {
  name: string;
  /** seconds east of UTC */
  offset: number;
}

/** strftime in the C locale over a normalized broken-down time. */
export function strftimeText(
  tm: Tm,
  format: string,
  zone: Zone,
  fn = "strftime",
): string {
  // jq formats into a buffer 100 bytes past the format and fails when the
  // text does not fit, which also bounds a width
  const room = new TextEncoder().encode(format).length + 100;
  const failure = () => new Error(`${fn}/1: unknown system failure`);
  const pad = (n: number, width = 2, fill = "0") =>
    n < 0 ? `-${String(-n).padStart(width - 1, fill)}` : String(n).padStart(width, fill);
  const [year, month, day, hour, minute] = tm;
  const second = Math.floor(tm[5]);
  const wday = tm[6];
  const yday = tm[7];
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const one = (c: string): string => {
    switch (c) {
      case "a":
        return DAYS[wday].slice(0, 3);
      case "A":
        return DAYS[wday];
      case "b":
      case "h":
        return MONTHS[month].slice(0, 3);
      case "B":
        return MONTHS[month];
      case "c":
        return `${one("a")} ${one("b")} ${one("e")} ${one("T")} ${year}`;
      case "C":
        return pad(Math.floor(year / 100));
      case "d":
        return pad(day);
      case "D":
      case "x":
        return `${pad(month + 1)}/${pad(day)}/${pad(mod(year, 100))}`;
      case "e":
        return pad(day, 2, " ");
      case "F":
        return `${year}-${pad(month + 1)}-${pad(day)}`;
      case "g":
        return pad(mod(isoWeek(tm)[0], 100));
      case "G":
        return String(isoWeek(tm)[0]);
      case "H":
        return pad(hour);
      case "I":
        return pad(hour12);
      case "j":
        return pad(yday + 1, 3);
      case "k":
        return pad(hour, 2, " ");
      case "l":
        return pad(hour12, 2, " ");
      case "m":
        return pad(month + 1);
      case "M":
        return pad(minute);
      case "n":
        return "\n";
      case "p":
        return hour < 12 ? "AM" : "PM";
      case "P":
        return hour < 12 ? "am" : "pm";
      case "r":
        return `${pad(hour12)}:${pad(minute)}:${pad(second)} ${one("p")}`;
      case "R":
        return `${pad(hour)}:${pad(minute)}`;
      case "s":
        return String(timegm([year, month, day, hour, minute, second]) - zone.offset);
      case "S":
        return pad(second);
      case "t":
        return "\t";
      case "T":
      case "X":
        return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
      case "u":
        return String(wday === 0 ? 7 : wday);
      case "U":
        return pad(Math.floor((yday + 7 - wday) / 7));
      case "V":
        return pad(isoWeek(tm)[1]);
      case "w":
        return String(wday);
      case "W":
        return pad(Math.floor((yday + 7 - mod(wday + 6, 7)) / 7));
      case "y":
        return pad(mod(year, 100));
      case "Y":
        return String(year);
      case "z": {
        const minutes = Math.abs(zone.offset) / 60;
        const sign = zone.offset < 0 ? "-" : "+";
        return `${sign}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`;
      }
      case "Z":
        return zone.name;
      case "%":
        return "%";
      default:
        return `%${c}`;
    }
  };
  // the numeric conversions: value, digits, and whether C pads with blanks
  const numeric = (c: string): [number, number, boolean] | null => {
    switch (c) {
      case "C":
        return [Math.floor(year / 100), 2, false];
      case "d":
        return [day, 2, false];
      case "e":
        return [day, 2, true];
      case "g":
        return [mod(isoWeek(tm)[0], 100), 2, false];
      case "G":
        return [isoWeek(tm)[0], 1, false];
      case "H":
        return [hour, 2, false];
      case "I":
        return [hour12, 2, false];
      case "j":
        return [yday + 1, 3, false];
      case "k":
        return [hour, 2, true];
      case "l":
        return [hour12, 2, true];
      case "m":
        return [month + 1, 2, false];
      case "M":
        return [minute, 2, false];
      case "S":
        return [second, 2, false];
      case "u":
        return [wday === 0 ? 7 : wday, 1, false];
      case "U":
        return [Math.floor((yday + 7 - wday) / 7), 2, false];
      case "V":
        return [isoWeek(tm)[1], 2, false];
      case "w":
        return [wday, 1, false];
      case "W":
        return [Math.floor((yday + 7 - mod(wday + 6, 7)) / 7), 2, false];
      case "y":
        return [mod(year, 100), 2, false];
      case "Y":
        return [year, 1, false];
      default:
        return null;
    }
  };
  // glibc's flags (- no zeros, _ blanks, 0 zeros, ^ upper case, # swap
  // case) and a width, blanks for -; E and O, which the C locale ignores,
  // where glibc takes them, and the conversion as written elsewhere
  let out = "";
  for (let i = 0; i < format.length; i++) {
    if (out.length >= room) throw failure();
    const spec = /^%([-_0^#]*)(\d*)([EO]?)(.)/s.exec(format.slice(i, i + 64));
    if (format[i] !== "%" || !spec) {
      out += format[i];
      continue;
    }
    const [whole, flags, digits, modifier, c] = spec;
    i += whole.length - 1;
    const pad = flags.replace(/[\^#]/g, "").slice(-1);
    const width = digits === "" ? 0 : Math.min(Number(digits), room);
    const taken =
      modifier === "" ||
      (modifier === "E" ? "cCxXyY" : "bBhdeHIklmMSuUVwWy").includes(c) ||
      "ntpPrRsTzZ".includes(c);
    const number = taken ? numeric(c) : null;
    if (number) {
      const [n, least, blank] = number;
      const body = String(Math.abs(n));
      const sign = n < 0 ? "-" : "";
      const size = Math.max(least, width) - sign.length;
      if (pad === "-") out += (sign + body).padStart(width, " ");
      else if (pad === "_" || (blank && pad !== "0")) {
        out += (sign + body).padStart(size + sign.length, " ");
      } else out += sign + body.padStart(size, "0");
      continue;
    }
    // an unknown conversion is written as it is, padded to the width
    let text = !taken ? `%${c}` : c === "%" ? "%" : one(c);
    if (text === `%${c}`) text = whole;
    const lower = flags.includes("#") && (c === "p" || c === "Z");
    const upper =
      flags.includes("^") ||
      (flags.includes("#") && "aAbBh".includes(c));
    if (lower || c === "P") text = text.toLowerCase();
    else if (upper) text = text.toUpperCase();
    if (text.length < width) {
      text = text.padStart(width, pad === "0" ? "0" : " ");
    }
    out += text;
  }
  if (new TextEncoder().encode(out).length >= room) throw failure();
  return out;
}

const MON_YDAY = [
  [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
  [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366],
];

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const SPACE = /\s/;

/**
 * strptime as glibc reads: a blank in the format skips any blanks, a
 * number may follow blanks and takes at most its width, names match in
 * full or by three letters in any case. Null when the text does not
 * match; what follows a blank after the match comes back as the rest.
 */
export function strptimeFields(
  input: string,
  format: string,
): { tm: Tm; rest: string } | null {
  const tm = [1900, 0, 0, 0, 0, 0, 8, 367];
  const state = {
    wantDate: false,
    haveWday: false,
    haveYday: false,
    haveMon: false,
    haveMday: false,
    hour12: false,
    pm: false,
    century: -1,
    year2: -1,
  };
  let at = 0;
  const number = (min: number, max: number, width: number): number | null => {
    while (at < input.length && SPACE.test(input[at])) at++;
    let digits = "";
    while (digits.length < width && at < input.length && /[0-9]/.test(input[at])) {
      digits += input[at++];
    }
    if (digits === "") return null;
    const n = Number(digits);
    return n < min || n > max ? null : n;
  };
  const name = (names: string[]): number | null => {
    const rest = input.slice(at).toLowerCase();
    for (let i = 0; i < names.length; i++) {
      for (const text of [names[i], names[i].slice(0, 3)]) {
        if (rest.startsWith(text.toLowerCase())) {
          at += text.length;
          return i;
        }
      }
    }
    return null;
  };
  const read = (fmt: string): boolean => {
    for (let i = 0; i < fmt.length; i++) {
      const f = fmt[i];
      if (SPACE.test(f)) {
        while (at < input.length && SPACE.test(input[at])) at++;
        continue;
      }
      if (f !== "%" || i + 1 === fmt.length) {
        if (input[at] !== f) return false;
        at++;
        continue;
      }
      const c = fmt[++i];
      let n: number | null;
      switch (c) {
        case "%":
          if (input[at] !== "%") return false;
          at++;
          break;
        case "a":
        case "A":
          n = name(DAYS);
          if (n === null) return false;
          tm[6] = n;
          state.haveWday = true;
          break;
        case "b":
        case "B":
        case "h":
          n = name(MONTHS);
          if (n === null) return false;
          tm[1] = n;
          state.haveMon = true;
          state.wantDate = true;
          break;
        case "c":
          if (!read("%a %b %e %H:%M:%S %Y")) return false;
          break;
        case "C":
          n = number(0, 99, 2);
          if (n === null) return false;
          state.century = n;
          state.wantDate = true;
          break;
        case "d":
        case "e":
          n = number(1, 31, 2);
          if (n === null) return false;
          tm[2] = n;
          state.haveMday = true;
          state.wantDate = true;
          break;
        case "D":
        case "x":
          if (!read("%m/%d/%y")) return false;
          break;
        case "F":
          if (!read("%Y-%m-%d")) return false;
          break;
        case "H":
        case "k":
          n = number(0, 23, 2);
          if (n === null) return false;
          tm[3] = n;
          state.hour12 = false;
          break;
        case "I":
        case "l":
          n = number(1, 12, 2);
          if (n === null) return false;
          tm[3] = n % 12;
          state.hour12 = true;
          break;
        case "j":
          n = number(1, 366, 3);
          if (n === null) return false;
          tm[7] = n - 1;
          state.haveYday = true;
          break;
        case "m":
          n = number(1, 12, 2);
          if (n === null) return false;
          tm[1] = n - 1;
          state.haveMon = true;
          state.wantDate = true;
          break;
        case "M":
          n = number(0, 59, 2);
          if (n === null) return false;
          tm[4] = n;
          break;
        case "n":
        case "t":
          while (at < input.length && SPACE.test(input[at])) at++;
          break;
        case "p":
        case "P": {
          const word = input.slice(at, at + 2).toUpperCase();
          if (word !== "AM" && word !== "PM") return false;
          state.pm = word === "PM";
          at += 2;
          break;
        }
        case "r":
          if (!read("%I:%M:%S %p")) return false;
          break;
        case "R":
          if (!read("%H:%M")) return false;
          break;
        case "s": {
          let digits = "";
          while (at < input.length && /[0-9]/.test(input[at])) digits += input[at++];
          if (digits === "") return false;
          const t = gmtimeOf(Number(digits));
          for (let k = 0; k < 8; k++) tm[k] = t[k];
          break;
        }
        case "S":
          n = number(0, 61, 2);
          if (n === null) return false;
          tm[5] = n;
          break;
        case "T":
        case "X":
          if (!read("%H:%M:%S")) return false;
          break;
        case "u":
          n = number(1, 7, 1);
          if (n === null) return false;
          tm[6] = n % 7;
          state.haveWday = true;
          break;
        case "w":
          n = number(0, 6, 1);
          if (n === null) return false;
          tm[6] = n;
          state.haveWday = true;
          break;
        case "U":
        case "W":
        case "V":
          if (number(0, 53, 2) === null) return false;
          break;
        case "g":
          if (number(0, 99, 2) === null) return false;
          break;
        case "G":
          if (number(0, 9999, 4) === null) return false;
          break;
        case "y":
          n = number(0, 99, 2);
          if (n === null) return false;
          state.year2 = n;
          tm[0] = n >= 69 ? 1900 + n : 2000 + n;
          state.wantDate = true;
          break;
        case "Y":
          n = number(0, 9999, 4);
          if (n === null) return false;
          tm[0] = n;
          state.century = -1;
          state.year2 = -1;
          state.wantDate = true;
          break;
        case "z": {
          if (input[at] === "Z") {
            at++;
            break;
          }
          const zone = /^[+-]\d\d(:?\d\d)?/.exec(input.slice(at));
          if (!zone) return false;
          at += zone[0].length;
          break;
        }
        case "Z":
          while (at < input.length && SPACE.test(input[at])) at++;
          while (at < input.length && !SPACE.test(input[at])) at++;
          break;
        default:
          return false;
      }
    }
    return true;
  };
  if (!read(format)) return null;
  if (at < input.length && !SPACE.test(input[at])) return null;
  if (state.hour12 && state.pm) tm[3] += 12;
  if (state.century !== -1) {
    tm[0] = state.century * 100 + (state.year2 === -1 ? 0 : state.year2);
  }
  const days = MON_YDAY[isLeap(tm[0]) ? 1 : 0];
  if (state.wantDate && !state.haveWday) {
    if (!(state.haveMon && state.haveMday) && state.haveYday) {
      let month = 0;
      while (month < 12 && days[month] <= tm[7]) month++;
      if (!state.haveMon) tm[1] = month - 1;
      if (!state.haveMday) tm[2] = tm[7] - days[month - 1] + 1;
      state.haveMon = true;
      state.haveMday = true;
    }
    tm[6] = mod(daysFromCivil(tm[0], tm[1], 1) + tm[2] - 1 + 4, 7);
  }
  if (state.wantDate && !state.haveYday) {
    tm[7] = days[mod(tm[1], 12)] + tm[2] - 1;
  }
  return { tm, rest: input.slice(at) };
}

/** The zone TZ names, or UTC when it is unset or Intl does not know it. */
export function zoneName(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** The local broken-down time of an instant in a zone, and the zone there. */
export function localtimeOf(
  seconds: number,
  tz: string,
): { tm: Tm; zone: Zone } {
  const utc = gmtimeOf(seconds);
  const whole = Math.trunc(seconds);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZoneName: "short",
  });
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format.formatToParts(new Date(whole * 1000));
  } catch {
    return { tm: utc, zone: { name: "UTC", offset: 0 } };
  }
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = timegm([
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  ]);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
  const tm = gmtimeOf(local + (seconds - whole));
  return { tm, zone: { name, offset: local - whole } };
}
