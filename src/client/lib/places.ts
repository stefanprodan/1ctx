// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a time zone search matches besides the zone's own name: the
// countries the zone is in, from the runtime's own data, and the big
// cities that are not a zone's name. A zone is named after one city per
// region, so "Munich" or "San Francisco" finds nothing in the IANA ids
// alone. The runtimes know countries but not cities, so the cities are
// this list, kept short: the places people schedule from.

// the big cities that are not the name of their zone
const CITIES: Record<string, string> = {
  "America/Los_Angeles":
    "San Francisco, San Jose, Seattle, San Diego, Portland, Las Vegas, Sacramento, Oakland, Palo Alto, Silicon Valley, Pacific",
  "America/Denver": "Salt Lake City, Albuquerque, Colorado Springs, Mountain",
  "America/Phoenix": "Arizona, Tucson, Scottsdale",
  "America/Chicago":
    "Dallas, Houston, Austin, San Antonio, Minneapolis, Nashville, New Orleans, Kansas City, St Louis, Milwaukee, Central",
  "America/New_York":
    "Boston, Washington, Philadelphia, Atlanta, Miami, Pittsburgh, Charlotte, Baltimore, Orlando, Raleigh, Cleveland, Eastern",
  "America/Toronto": "Ottawa, Montreal, Quebec",
  "America/Vancouver": "Victoria, British Columbia",
  "America/Edmonton": "Calgary, Alberta",
  "America/Halifax": "Nova Scotia, Atlantic",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
  "America/Mexico_City": "Guadalajara, Monterrey, Puebla",
  "America/Sao_Paulo":
    "Rio de Janeiro, Brasilia, Belo Horizonte, Curitiba, Porto Alegre",
  "America/Argentina/Buenos_Aires": "Cordoba, Rosario",
  "America/Bogota": "Medellin, Cali",
  "America/Lima": "Arequipa",
  "America/Santiago": "Valparaiso",
  "Europe/London":
    "Manchester, Birmingham, Edinburgh, Glasgow, Liverpool, Leeds, Bristol, Cambridge, Oxford, Belfast, Cardiff",
  "Europe/Dublin": "Cork, Galway",
  "Europe/Lisbon": "Porto",
  "Europe/Madrid": "Barcelona, Valencia, Seville, Malaga, Bilbao",
  "Europe/Paris":
    "Lyon, Marseille, Toulouse, Nice, Bordeaux, Nantes, Lille, Strasbourg",
  "Europe/Brussels": "Antwerp, Ghent",
  "Europe/Amsterdam": "Rotterdam, The Hague, Utrecht, Eindhoven",
  "Europe/Berlin":
    "Munich, Hamburg, Frankfurt, Cologne, Stuttgart, Dusseldorf, Leipzig, Dresden, Hanover, Nuremberg",
  "Europe/Zurich": "Geneva, Basel, Bern, Lausanne",
  "Europe/Vienna": "Graz, Salzburg, Innsbruck",
  "Europe/Rome":
    "Milan, Naples, Turin, Florence, Bologna, Venice, Genoa, Palermo",
  "Europe/Copenhagen": "Aarhus",
  "Europe/Stockholm": "Gothenburg, Malmo, Uppsala",
  "Europe/Oslo": "Bergen, Trondheim",
  "Europe/Helsinki": "Espoo, Tampere",
  "Europe/Warsaw": "Krakow, Wroclaw, Gdansk, Poznan, Lodz",
  "Europe/Prague": "Brno",
  "Europe/Budapest": "Debrecen",
  "Europe/Bucharest":
    "Cluj, Cluj-Napoca, Iasi, Timisoara, Constanta, Brasov, Craiova, Galati, Oradea, Sibiu",
  "Europe/Sofia": "Plovdiv, Varna",
  "Europe/Athens": "Thessaloniki",
  "Europe/Istanbul": "Ankara, Izmir, Antalya, Bursa",
  "Europe/Kyiv": "Kiev, Lviv, Kharkiv, Odesa, Dnipro",
  "Europe/Moscow": "Saint Petersburg, St Petersburg, Kazan, Nizhny Novgorod",
  "Europe/Belgrade": "Novi Sad",
  "Europe/Zagreb": "Split",
  "Asia/Jerusalem": "Tel Aviv, Haifa",
  "Asia/Dubai": "Abu Dhabi, Sharjah",
  "Asia/Riyadh": "Jeddah, Mecca, Medina",
  "Asia/Karachi": "Lahore, Islamabad, Faisalabad",
  "Asia/Kolkata":
    "Mumbai, Delhi, New Delhi, Bangalore, Bengaluru, Hyderabad, Chennai, Pune, Ahmedabad, Kolkata, Calcutta, Jaipur",
  "Asia/Dhaka": "Chittagong",
  "Asia/Bangkok": "Chiang Mai, Phuket",
  "Asia/Ho_Chi_Minh": "Saigon, Hanoi, Da Nang",
  "Asia/Jakarta": "Bandung, Surabaya",
  "Asia/Makassar": "Bali, Denpasar",
  "Asia/Kuala_Lumpur": "Penang, Johor Bahru",
  "Asia/Manila": "Quezon City, Cebu, Davao",
  "Asia/Shanghai":
    "Beijing, Shenzhen, Guangzhou, Chengdu, Hangzhou, Wuhan, Nanjing, Tianjin, Xian, Chongqing, Suzhou",
  "Asia/Taipei": "Kaohsiung, Taichung",
  "Asia/Seoul": "Busan, Incheon, Daegu",
  "Asia/Tokyo": "Osaka, Kyoto, Yokohama, Nagoya, Sapporo, Fukuoka, Kobe",
  "Australia/Sydney": "Canberra, Newcastle, Wollongong",
  "Australia/Melbourne": "Geelong",
  "Australia/Brisbane": "Queensland",
  "Pacific/Auckland": "Wellington, Christchurch",
  "Africa/Johannesburg": "Cape Town, Durban, Pretoria",
  "Africa/Lagos": "Abuja, Ibadan",
  "Africa/Nairobi": "Mombasa",
  "Africa/Cairo": "Alexandria, Giza",
  "Africa/Casablanca": "Rabat, Marrakesh, Fes",
  "Etc/UTC": "Universal, Zulu, Coordinated",
};

// the ids the tz database renamed, old to new, since a runtime's zone
// list and its country data may each use either (Asia/Calcutta in one,
// Asia/Kolkata in the other) and Intl keeps the id it is given
const RENAMED: Record<string, string> = {
  Calcutta: "Kolkata",
  Saigon: "Ho_Chi_Minh",
  Kiev: "Kyiv",
  Katmandu: "Kathmandu",
  Rangoon: "Yangon",
  Godthab: "Nuuk",
  Asmera: "Asmara",
  Faeroe: "Faroe",
  Ulan_Bator: "Ulaanbaatar",
  Dacca: "Dhaka",
  Thimbu: "Thimphu",
  Ujung_Pandang: "Makassar",
  Enderbury: "Kanton",
  Truk: "Chuuk",
  Ponape: "Pohnpei",
};

// one key for a zone under either of its ids: its last segment, renamed
function keyOf(tz: string): string {
  const last = tz.slice(tz.lastIndexOf("/") + 1);
  return RENAMED[last] ?? last;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// zone key -> the countries it is in, in English, from Intl: every region
// code the runtime can name, and the zones it lists for that region.
// A runtime without Intl.Locale's time zones gets no countries
function countriesByZone(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let names: Intl.DisplayNames;
  try {
    names = new Intl.DisplayNames("en", { type: "region" });
  } catch {
    return out;
  }
  for (const a of LETTERS) {
    for (const b of LETTERS) {
      const code = `${a}${b}`;
      let name: string | undefined;
      let zones: string[] = [];
      try {
        name = names.of(code);
        const locale = new Intl.Locale(`und-${code}`) as Intl.Locale & {
          getTimeZones?: () => string[] | undefined;
        };
        zones = locale.getTimeZones?.() ?? [];
      } catch {
        continue;
      }
      if (name === undefined || name === code || zones.length === 0) continue;
      for (const zone of zones) {
        const id = keyOf(zone);
        const held = out.get(id) ?? [];
        // an old region code names the same country (DD is Germany too)
        if (!held.includes(name)) out.set(id, [...held, name]);
      }
    }
  }
  return out;
}

export type Place = { countries: string[]; cities: string };

let index: Map<string, Place> | null = null;

// the places of every zone, built once, on the first search
export function placesByZone(): Map<string, Place> {
  if (index !== null) return index;
  const countries = countriesByZone();
  const out = new Map<string, Place>();
  for (const [zone, list] of countries) {
    out.set(zone, { countries: list, cities: "" });
  }
  for (const [zone, cities] of Object.entries(CITIES)) {
    const id = keyOf(zone);
    const held = out.get(id);
    out.set(id, {
      countries: held?.countries ?? [],
      cities: held?.cities ? `${held.cities}, ${cities}` : cities,
    });
  }
  index = out;
  return out;
}

// the places of one zone, under either of its ids
export function placeOf(tz: string): Place | null {
  return placesByZone().get(keyOf(tz)) ?? null;
}
