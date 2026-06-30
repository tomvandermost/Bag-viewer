import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";

dotenv.config();

const PORT = Number(process.env.PORT ?? 3001);
const BAG_BASE_URL =
  "https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2";
const PDOK_LOCATIESERVER_BASE_URL =
  "https://api.pdok.nl/bzk/locatieserver/search/v3_1";
const PDOK_CADASTRE_BASE_URL =
  "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1";
const EPSG_28992_URI = "http://www.opengis.net/def/crs/EPSG/0/28992";

type RawObject = Record<string, unknown>;
type SearchRoute = "pdok" | "bag";

type SearchInput = {
  postcode: string;
  huisnummer: string;
  huisletter: string | null;
  huisnummertoevoeging: string | null;
  route: SearchRoute;
};

type BagSearchResult = {
  openbareRuimteNaam: string | null;
  huisnummer: number | string | null;
  huisletter: string | null;
  huisnummertoevoeging: string | null;
  postcode: string | null;
  woonplaatsNaam: string | null;
  adresregel5: string | null;
  adresregel6: string | null;
  nummeraanduidingIdentificatie: string | null;
  adresseerbaarObjectIdentificatie: string | null;
  adresseerbaarObjectType: string | null;
  pandIdentificaties: string[];
  oorspronkelijkBouwjaar: string | number | null;
  oppervlakte: number | string | null;
  gebruiksdoelen: string[];
  status: string | null;
  pandStatus: string | null;
  geometrie: unknown;
  raw: RawObject;
};

type PdokLocationResult = {
  weergavenaam: string | null;
  straatnaam: string | null;
  huisnummer: number | string | null;
  huisletter: string | null;
  huisnummertoevoeging: string | null;
  postcode: string | null;
  woonplaatsnaam: string | null;
  gemeentenaam: string | null;
  provincienaam: string | null;
  type: string | null;
  score: number | string | null;
  centroide_rd: string | null;
  gekoppeldePercelen: string[];
  gekoppeldeAppartementen: string[];
  raw: RawObject;
};

type Coordinate = {
  x: number;
  y: number;
  crs: "EPSG:28992";
  source: string;
};

type ParcelResult = {
  identificatie: string | null;
  kadastraleGemeente: string | null;
  sectie: string | null;
  perceelnummer: string | number | null;
  kadastraleAanduiding: string | null;
  soortGrootte: string | null;
  grootte: string | number | null;
  geometry: unknown;
  properties: RawObject;
  raw: RawObject;
};

type SourceResult = {
  type: "PDOK Locatieserver" | "BAG API";
  count: number;
  bestMatch: PdokLocationResult | BagSearchResult | null;
  results: Array<PdokLocationResult | BagSearchResult>;
  raw: unknown;
};

type CombinedSearchResponse = {
  input: SearchInput;
  routeUsed: SearchRoute;
  source: SourceResult;
  bag: {
    count: number;
    results: BagSearchResult[];
    raw: unknown;
  };
  coordinate: Coordinate;
  cadastre: {
    count: number;
    bestMatch: ParcelResult;
    candidates: ParcelResult[];
    raw: unknown;
    selection: {
      method: string;
      matchedReference: string | null;
    };
    linkedReferences: string[];
    linkedCandidateMatches: ParcelResult[];
    otherLinkedCandidateMatches: ParcelResult[];
  };
  warnings: string[];
};

type ApiErrorCode =
  | "MISSING_API_KEY"
  | "MISSING_PARAMETERS"
  | "INVALID_POSTCODE"
  | "INVALID_HUISNUMMER"
  | "INVALID_ROUTE"
  | "BAG_AUTHORIZATION_ERROR"
  | "BAG_RATE_LIMIT"
  | "NO_BAG_RESULT"
  | "NO_PDOK_LOCATION_RESULT"
  | "NO_USABLE_COORDINATE"
  | "PDOK_REQUEST_FAILED"
  | "NO_CADASTRAL_PARCEL"
  | "BAG_API_ERROR";

type ApiError = {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
};

class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: ApiErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

const app = express();

app.use(
  cors({
    origin: "http://localhost:5173"
  })
);

function sendError(
  response: Response,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown
) {
  const error: ApiError = { code, message };
  if (details !== undefined) {
    error.details = details;
  }

  response.status(statusCode).json({ error });
}

function handleError(response: Response, error: unknown) {
  if (error instanceof HttpError) {
    sendError(response, error.statusCode, error.code, error.message, error.details);
    return;
  }

  sendError(
    response,
    500,
    "BAG_API_ERROR",
    "An unexpected server error occurred.",
    error instanceof Error ? error.message : error
  );
}

function getSingleQueryValue(value: Request["query"][string]): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function cleanPostcode(postcode: string): string {
  return postcode.replace(/\s+/g, "").toUpperCase();
}

function optionalTrim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseInput(request: Request): SearchInput {
  const postcode = optionalTrim(getSingleQueryValue(request.query.postcode));
  const huisnummer = optionalTrim(getSingleQueryValue(request.query.huisnummer));
  const huisletter = optionalTrim(getSingleQueryValue(request.query.huisletter));
  const huisnummertoevoeging = optionalTrim(
    getSingleQueryValue(request.query.huisnummertoevoeging)
  );
  const routeQuery = optionalTrim(getSingleQueryValue(request.query.route)) ?? "pdok";

  if (!postcode) {
    throw new HttpError(400, "MISSING_PARAMETERS", "Postcode is required.");
  }

  if (!huisnummer) {
    throw new HttpError(400, "MISSING_PARAMETERS", "Huisnummer is required.");
  }

  const cleanedPostcode = cleanPostcode(postcode);
  if (!/^\d{4}[A-Z]{2}$/.test(cleanedPostcode)) {
    throw new HttpError(
      400,
      "INVALID_POSTCODE",
      "Postcode must use the Dutch format 1234AB."
    );
  }

  if (!/^\d+$/.test(huisnummer) || Number(huisnummer) <= 0) {
    throw new HttpError(
      400,
      "INVALID_HUISNUMMER",
      "Huisnummer must be a positive whole number."
    );
  }

  if (routeQuery !== "pdok" && routeQuery !== "bag") {
    throw new HttpError(
      400,
      "INVALID_ROUTE",
      "Route must be either pdok or bag."
    );
  }

  return {
    postcode: cleanedPostcode,
    huisnummer,
    huisletter: huisletter?.toUpperCase() ?? null,
    huisnummertoevoeging: huisnummertoevoeging?.toUpperCase() ?? null,
    route: routeQuery
  };
}

function getApiKey(): string {
  const apiKey = process.env.BAG_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(
      500,
      "MISSING_API_KEY",
      "BAG_API_KEY is missing. Use the PDOK Locatieserver route or add BAG_API_KEY to server/.env."
    );
  }

  return apiKey;
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function getNumberOrString(value: unknown): number | string | null {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }

  return null;
}

function getObject(value: unknown): RawObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawObject)
    : undefined;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compactStrings(values: unknown[]): string[] {
  return values
    .map((value) => getString(value))
    .filter((value): value is string => Boolean(value));
}

function firstValue(source: RawObject, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }

  return undefined;
}

function nestedFirst(source: RawObject, paths: string[][]): unknown {
  for (const path of paths) {
    let current: unknown = source;

    for (const segment of path) {
      const object = getObject(current);
      if (!object || object[segment] === undefined || object[segment] === null) {
        current = undefined;
        break;
      }

      current = object[segment];
    }

    if (current !== undefined && current !== null) {
      return current;
    }
  }

  return undefined;
}

async function readResponseBody(response: globalThis.Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? response.json() : response.text();
}

function extractPandIdentificaties(item: RawObject): string[] {
  const direct = getArray(
    firstValue(item, ["pandIdentificaties", "pandidentificaties"])
  );
  const embeddedPanden = getArray(nestedFirst(item, [["_embedded", "panden"]]));
  const panden = getArray(firstValue(item, ["panden"]));

  const fromObjects = [...embeddedPanden, ...panden].flatMap((pand) => {
    const object = getObject(pand);
    return object
      ? [
          object["identificatie"],
          object["pandIdentificatie"],
          object["pandidentificatie"]
        ]
      : [];
  });

  return Array.from(new Set(compactStrings([...direct, ...fromObjects])));
}

function extractGebruiksdoelen(item: RawObject): string[] {
  const direct = getArray(firstValue(item, ["gebruiksdoelen", "gebruiksdoel"]));
  const verblijfsobject = getObject(
    firstValue(item, ["verblijfsobject", "adresseerbaarObject"])
  );
  const nested = verblijfsobject
    ? getArray(firstValue(verblijfsobject, ["gebruiksdoelen", "gebruiksdoel"]))
    : [];

  return Array.from(new Set(compactStrings([...direct, ...nested])));
}

function extractBagItems(data: unknown): RawObject[] {
  const root = getObject(data);
  if (!root) {
    return [];
  }

  const embedded = getObject(root["_embedded"]);
  const possibleArrays = [
    root["adressen"],
    root["adressenUitgebreid"],
    root["adressenuitgebreid"],
    embedded?.["adressen"],
    embedded?.["adressenUitgebreid"],
    embedded?.["adressenuitgebreid"]
  ];

  for (const possibleArray of possibleArrays) {
    const items = getArray(possibleArray)
      .map((item) => getObject(item))
      .filter((item): item is RawObject => Boolean(item));

    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function normalizeBagItem(item: RawObject): BagSearchResult {
  const nummeraanduiding = getObject(
    firstValue(item, ["nummeraanduiding", "nummerAanduiding"])
  );
  const object = getObject(
    firstValue(item, [
      "adresseerbaarObject",
      "verblijfsobject",
      "ligplaats",
      "standplaats"
    ])
  );
  const pand = getObject(firstValue(item, ["pand", "pandGegevens"]));
  const woonplaats = getObject(firstValue(item, ["woonplaats"]));
  const openbareRuimte = getObject(
    firstValue(item, ["openbareRuimte", "openbareruimte"])
  );

  const geometrie =
    firstValue(item, ["geometrie", "adresseerbaarObjectGeometrie"]) ??
    firstValue(object ?? {}, ["geometrie", "punt", "vlak"]) ??
    firstValue(nummeraanduiding ?? {}, ["geometrie"]);

  return {
    openbareRuimteNaam: getString(
      firstValue(item, ["openbareRuimteNaam", "straat", "straatnaam"]) ??
        firstValue(openbareRuimte ?? {}, ["naam", "openbareRuimteNaam"])
    ),
    huisnummer: getNumberOrString(
      firstValue(item, ["huisnummer"]) ??
        firstValue(nummeraanduiding ?? {}, ["huisnummer"])
    ),
    huisletter: getString(
      firstValue(item, ["huisletter"]) ??
        firstValue(nummeraanduiding ?? {}, ["huisletter"])
    ),
    huisnummertoevoeging: getString(
      firstValue(item, ["huisnummertoevoeging", "huisnummerToevoeging"]) ??
        firstValue(nummeraanduiding ?? {}, [
          "huisnummertoevoeging",
          "huisnummerToevoeging"
        ])
    ),
    postcode: getString(
      firstValue(item, ["postcode"]) ?? firstValue(nummeraanduiding ?? {}, ["postcode"])
    ),
    woonplaatsNaam: getString(
      firstValue(item, ["woonplaatsNaam", "woonplaats"]) ??
        firstValue(woonplaats ?? {}, ["naam", "woonplaatsNaam"])
    ),
    adresregel5: getString(
      firstValue(item, ["adresregel5"]) ??
        firstValue(nummeraanduiding ?? {}, ["adresregel5"])
    ),
    adresregel6: getString(
      firstValue(item, ["adresregel6"]) ??
        firstValue(nummeraanduiding ?? {}, ["adresregel6"])
    ),
    nummeraanduidingIdentificatie: getString(
      firstValue(item, [
        "nummeraanduidingIdentificatie",
        "nummeraanduidingidentificatie"
      ]) ?? firstValue(nummeraanduiding ?? {}, ["identificatie"])
    ),
    adresseerbaarObjectIdentificatie: getString(
      firstValue(item, [
        "adresseerbaarObjectIdentificatie",
        "adresseerbaarobjectidentificatie",
        "verblijfsobjectIdentificatie",
        "ligplaatsIdentificatie",
        "standplaatsIdentificatie"
      ]) ?? firstValue(object ?? {}, ["identificatie"])
    ),
    adresseerbaarObjectType: getString(
      firstValue(item, ["adresseerbaarObjectType", "adresseerbaarobjecttype", "type"]) ??
        firstValue(object ?? {}, ["type"])
    ),
    pandIdentificaties: extractPandIdentificaties(item),
    oorspronkelijkBouwjaar: getNumberOrString(
      firstValue(item, ["oorspronkelijkBouwjaar", "oorspronkelijkbouwjaar"]) ??
        firstValue(pand ?? {}, ["oorspronkelijkBouwjaar", "oorspronkelijkbouwjaar"])
    ),
    oppervlakte: getNumberOrString(
      firstValue(item, ["oppervlakte", "oppervlakteVerblijfsobject"]) ??
        firstValue(object ?? {}, ["oppervlakte", "oppervlakteVerblijfsobject"])
    ),
    gebruiksdoelen: extractGebruiksdoelen(item),
    status: getString(firstValue(item, ["status"]) ?? firstValue(object ?? {}, ["status"])),
    pandStatus: getString(
      firstValue(item, ["pandStatus", "pandstatus"]) ??
        firstValue(pand ?? {}, ["status", "pandStatus", "pandstatus"])
    ),
    geometrie: geometrie ?? null,
    raw: item
  };
}

function normalizePdokLocationResult(item: RawObject): PdokLocationResult {
  return {
    weergavenaam: getString(firstValue(item, ["weergavenaam", "suggest"])),
    straatnaam: getString(firstValue(item, ["straatnaam", "straatnaam_verkort"])),
    huisnummer: getNumberOrString(firstValue(item, ["huisnummer"])),
    huisletter: getString(firstValue(item, ["huisletter"])),
    huisnummertoevoeging: getString(firstValue(item, ["huisnummertoevoeging"])),
    postcode: getString(firstValue(item, ["postcode"])),
    woonplaatsnaam: getString(firstValue(item, ["woonplaatsnaam"])),
    gemeentenaam: getString(firstValue(item, ["gemeentenaam"])),
    provincienaam: getString(firstValue(item, ["provincienaam"])),
    type: getString(firstValue(item, ["type"])),
    score: getNumberOrString(firstValue(item, ["score", "sortering", "typesortering"])),
    centroide_rd: getString(firstValue(item, ["centroide_rd", "geometrie_rd"])),
    gekoppeldePercelen: compactStrings(getArray(firstValue(item, ["gekoppeld_perceel"]))),
    gekoppeldeAppartementen: compactStrings(
      getArray(firstValue(item, ["gekoppeld_appartement"]))
    ),
    raw: item
  };
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function average(points: Array<[number, number]>): [number, number] | null {
  if (points.length === 0) {
    return null;
  }

  const total = points.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
    [0, 0]
  );

  return [total[0] / points.length, total[1] / points.length];
}

function flattenNumberPairs(value: unknown): Array<[number, number]> {
  if (isNumberPair(value)) {
    return [[value[0], value[1]]];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => flattenNumberPairs(item));
}

function parsePointText(value: string | null): [number, number] | null {
  if (!value) {
    return null;
  }

  const match = value.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!match) {
    return null;
  }

  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function coordinateFromGeometry(value: unknown, source: string): Coordinate | null {
  const object = getObject(value);

  if (object) {
    const type = getString(object["type"])?.toLowerCase();
    const coordinates = object["coordinates"];

    if (type === "point" && isNumberPair(coordinates)) {
      return {
        x: coordinates[0],
        y: coordinates[1],
        crs: "EPSG:28992",
        source
      };
    }

    if ((type === "polygon" || type === "multipolygon") && coordinates) {
      const centroid = average(flattenNumberPairs(coordinates));
      if (centroid) {
        return {
          x: centroid[0],
          y: centroid[1],
          crs: "EPSG:28992",
          source: `${source} centroid`
        };
      }
    }

    for (const key of [
      "punt",
      "point",
      "geometrie",
      "geometry",
      "vlak",
      "polygon",
      "centroide"
    ]) {
      if (object[key] !== undefined) {
        const nested = coordinateFromGeometry(object[key], `${source}.${key}`);
        if (nested) {
          return nested;
        }
      }
    }
  }

  if (isNumberPair(value)) {
    return {
      x: value[0],
      y: value[1],
      crs: "EPSG:28992",
      source
    };
  }

  if (typeof value === "string") {
    const point = parsePointText(value);
    if (point) {
      return {
        x: point[0],
        y: point[1],
        crs: "EPSG:28992",
        source
      };
    }
  }

  return null;
}

function extractCoordinateFromBagResult(result: BagSearchResult): Coordinate | null {
  const rawObject = result.raw;
  const object = getObject(
    firstValue(rawObject, [
      "adresseerbaarObject",
      "verblijfsobject",
      "ligplaats",
      "standplaats"
    ])
  );

  const candidates: Array<[unknown, string]> = [
    [result.geometrie, "BAG geometry"],
    [firstValue(object ?? {}, ["geometrie", "punt", "vlak"]), "BAG geometry"],
    [firstValue(rawObject, ["geometrie", "adresseerbaarObjectGeometrie"]), "BAG geometry"],
    [rawObject, "BAG geometry"]
  ];

  for (const [candidate, source] of candidates) {
    const coordinate = coordinateFromGeometry(candidate, source);
    if (coordinate) {
      return coordinate;
    }
  }

  return null;
}

function extractCoordinateFromPdokLocationResult(
  result: PdokLocationResult
): Coordinate | null {
  const point = parsePointText(result.centroide_rd);
  if (!point) {
    return null;
  }

  return {
    x: point[0],
    y: point[1],
    crs: "EPSG:28992",
    source: "PDOK Locatieserver centroide_rd"
  };
}

function normalizeParcelReference(value: unknown): string | null {
  const text = getString(value)?.trim().toUpperCase();
  if (!text) {
    return null;
  }

  return text.replace(/\s+/g, "");
}

function buildParcelReference(
  gemeenteCode: unknown,
  sectie: unknown,
  perceelnummer: unknown
): string | null {
  const code = normalizeParcelReference(gemeenteCode);
  const section = normalizeParcelReference(sectie);
  const number = normalizeParcelReference(perceelnummer);

  if (!code || !section || !number) {
    return null;
  }

  return `${code}-${section}-${number}`;
}

function parcelReferences(parcel: ParcelResult): string[] {
  const propertyCode =
    firstValue(parcel.properties, [
      "akr_kadastrale_gemeente_code_waarde",
      "kadastraleGemeenteCode",
      "kadastrale_gemeente_code_waarde"
    ]) ?? parcel.kadastraleAanduiding;

  return [
    buildParcelReference(propertyCode, parcel.sectie, parcel.perceelnummer),
    normalizeParcelReference(parcel.kadastraleAanduiding)
  ].filter((value): value is string => Boolean(value));
}

function selectBestParcel(
  candidates: ParcelResult[],
  preferredParcelReferences: string[]
): {
  bestMatch: ParcelResult;
  selection: { method: string; matchedReference: string | null };
  linkedReferences: string[];
  linkedCandidateMatches: ParcelResult[];
  otherLinkedCandidateMatches: ParcelResult[];
  warnings: string[];
} {
  const normalizedPreferred = Array.from(
    new Set(
      preferredParcelReferences
        .map(normalizeParcelReference)
        .filter((value): value is string => Boolean(value))
    )
  );

  const linkedCandidateMatches = candidates.filter((candidate) => {
    const references = parcelReferences(candidate);
    return normalizedPreferred.some((preferred) => references.includes(preferred));
  });

  for (const preferred of normalizedPreferred) {
    const matchingCandidate = candidates.find((candidate) =>
      parcelReferences(candidate).includes(preferred)
    );

    if (matchingCandidate) {
      return {
        bestMatch: matchingCandidate,
        selection: {
          method: "linked parcel reference",
          matchedReference: preferred
        },
        linkedReferences: normalizedPreferred,
        linkedCandidateMatches,
        otherLinkedCandidateMatches: linkedCandidateMatches.filter(
          (candidate) => candidate.identificatie !== matchingCandidate.identificatie
        ),
        warnings: []
      };
    }
  }

  const bestMatch = candidates[0];

  return {
    bestMatch,
    selection: {
      method: "first spatial candidate",
      matchedReference: null
    },
    linkedReferences: normalizedPreferred,
    linkedCandidateMatches,
    otherLinkedCandidateMatches: linkedCandidateMatches.filter(
      (candidate) => candidate.identificatie !== bestMatch.identificatie
    ),
    warnings:
      normalizedPreferred.length > 0
        ? [
            `Linked parcel reference ${normalizedPreferred.join(
              ", "
            )} was not present in the Kadastrale Kaart candidates; first spatial candidate was used.`
          ]
        : []
  };
}

async function searchBag(input: SearchInput) {
  const apiKey = getApiKey();
  const searchParams = new URLSearchParams({
    postcode: input.postcode,
    huisnummer: input.huisnummer,
    exacteMatch: "true",
    page: "1",
    pageSize: "20"
  });

  if (input.huisletter) {
    searchParams.set("huisletter", input.huisletter);
  }

  if (input.huisnummertoevoeging) {
    searchParams.set("huisnummertoevoeging", input.huisnummertoevoeging);
  }

  const bagUrl = `${BAG_BASE_URL}/adressenuitgebreid?${searchParams.toString()}`;
  const bagResponse = await fetch(bagUrl, {
    headers: {
      Accept: "application/hal+json",
      "Accept-Crs": "epsg:28992",
      "X-Api-Key": apiKey
    }
  });
  const bagBody = await readResponseBody(bagResponse);

  if (bagResponse.status === 401 || bagResponse.status === 403) {
    throw new HttpError(
      bagResponse.status,
      "BAG_AUTHORIZATION_ERROR",
      "The BAG API key was rejected or is not authorized for this endpoint.",
      bagBody
    );
  }

  if (bagResponse.status === 429) {
    throw new HttpError(
      429,
      "BAG_RATE_LIMIT",
      "The BAG API rate limit was exceeded. Try again later.",
      bagBody
    );
  }

  if (!bagResponse.ok) {
    throw new HttpError(
      bagResponse.status,
      "BAG_API_ERROR",
      "The BAG API returned an error.",
      bagBody
    );
  }

  const rawItems = extractBagItems(bagBody);
  if (rawItems.length === 0) {
    throw new HttpError(
      404,
      "NO_BAG_RESULT",
      "No BAG result was found for this exact postcode and house number.",
      bagBody
    );
  }

  return {
    count: rawItems.length,
    results: rawItems.map(normalizeBagItem),
    raw: bagBody
  };
}

function buildPdokLocationQuery(input: SearchInput): string {
  const house = [
    input.huisnummer,
    input.huisletter,
    input.huisnummertoevoeging
  ]
    .filter(Boolean)
    .join("");

  return `${input.postcode} ${house}`;
}

function scorePdokLocation(result: PdokLocationResult, input: SearchInput): number {
  let score = 0;

  if (result.type === "adres") {
    score += 100;
  }

  if (result.postcode?.toUpperCase() === input.postcode) {
    score += 40;
  }

  if (String(result.huisnummer) === input.huisnummer) {
    score += 30;
  }

  if ((result.huisletter ?? null) === input.huisletter) {
    score += 10;
  } else if (!input.huisletter && !result.huisletter) {
    score += 10;
  }

  if ((result.huisnummertoevoeging ?? null) === input.huisnummertoevoeging) {
    score += 10;
  } else if (!input.huisnummertoevoeging && !result.huisnummertoevoeging) {
    score += 10;
  }

  const numericScore = Number(result.score);
  if (Number.isFinite(numericScore)) {
    score += numericScore;
  }

  return score;
}

async function searchPdokLocation(input: SearchInput) {
  const url = new URL(`${PDOK_LOCATIESERVER_BASE_URL}/free`);
  url.searchParams.set("q", buildPdokLocationQuery(input));
  url.searchParams.set("rows", "10");
  url.searchParams.set("fl", "*,score");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new HttpError(
      502,
      "PDOK_REQUEST_FAILED",
      "PDOK Locatieserver request failed.",
      body
    );
  }

  const root = getObject(body);
  const docs = getArray(nestedFirst(root ?? {}, [["response", "docs"]]))
    .map((item) => getObject(item))
    .filter((item): item is RawObject => Boolean(item))
    .map(normalizePdokLocationResult)
    .sort((a, b) => scorePdokLocation(b, input) - scorePdokLocation(a, input));

  const addressMatches = docs.filter((result) => result.type === "adres");
  const results = addressMatches.length > 0 ? addressMatches : docs;
  const bestMatch = results[0];

  if (!bestMatch) {
    throw new HttpError(
      404,
      "NO_PDOK_LOCATION_RESULT",
      "No PDOK Locatieserver result was found for this address.",
      body
    );
  }

  return {
    count: results.length,
    bestMatch,
    results,
    raw: body
  };
}

function normalizeParcel(feature: unknown): ParcelResult | null {
  const featureObject = getObject(feature);
  if (!featureObject) {
    return null;
  }

  const properties = getObject(featureObject["properties"]) ?? {};
  const identificatie =
    getString(featureObject["id"]) ??
    getString(firstValue(properties, ["identificatie", "identificatie_lokaal_id"]));
  const kadastraleGemeente = getString(
    firstValue(properties, [
      "kadastraleGemeente",
      "kadastrale_gemeente_waarde",
      "kadastraleGemeenteNaam"
    ])
  );
  const sectie = getString(firstValue(properties, ["sectie"]));
  const perceelnummer = getNumberOrString(
    firstValue(properties, ["perceelnummer", "perceelNummer"])
  );
  const akrGemeenteCode = firstValue(properties, [
    "akr_kadastrale_gemeente_code_waarde",
    "kadastraleGemeenteCode",
    "kadastrale_gemeente_code_waarde"
  ]);
  const composedAanduiding = buildParcelReference(
    akrGemeenteCode,
    sectie,
    perceelnummer
  );
  const kadastraleAanduiding =
    composedAanduiding ||
    getString(
      firstValue(properties, [
        "kadastraleAanduiding",
        "kadastrale_aanduiding",
        "akr_kadastrale_gemeente_code_waarde"
      ])
    ) ||
    null;

  return {
    identificatie,
    kadastraleGemeente,
    sectie,
    perceelnummer,
    kadastraleAanduiding,
    soortGrootte: getString(
      firstValue(properties, ["soortGrootte", "soort_grootte_waarde"])
    ),
    grootte: getNumberOrString(
      firstValue(properties, ["grootte", "kadastrale_grootte_waarde"])
    ),
    geometry: featureObject["geometry"] ?? null,
    properties,
    raw: featureObject
  };
}

function extractPdokFeatures(data: unknown): RawObject[] {
  const root = getObject(data);
  return getArray(root?.["features"])
    .map((feature) => getObject(feature))
    .filter((feature): feature is RawObject => Boolean(feature));
}

async function fetchPdok(url: URL): Promise<{ body: unknown; response: globalThis.Response }> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/geo+json, application/json"
    }
  });
  const body = await readResponseBody(response);
  return { body, response };
}

async function searchPdokCadastre(
  coordinate: Coordinate,
  preferredParcelReferences: string[] = []
) {
  const warnings: string[] = [];
  const minX = coordinate.x - 2;
  const minY = coordinate.y - 2;
  const maxX = coordinate.x + 2;
  const maxY = coordinate.y + 2;

  const bboxUrl = new URL(`${PDOK_CADASTRE_BASE_URL}/collections/perceel/items`);
  bboxUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
  bboxUrl.searchParams.set("bbox-crs", EPSG_28992_URI);
  bboxUrl.searchParams.set("crs", EPSG_28992_URI);
  bboxUrl.searchParams.set("limit", "10");
  bboxUrl.searchParams.set("f", "json");

  let result = await fetchPdok(bboxUrl);

  if (!result.response.ok) {
    warnings.push("PDOK Kadastrale Kaart rejected CRS parameters; bbox retry without CRS was used.");

    const fallbackUrl = new URL(`${PDOK_CADASTRE_BASE_URL}/collections/perceel/items`);
    fallbackUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
    fallbackUrl.searchParams.set("limit", "10");
    fallbackUrl.searchParams.set("f", "json");
    result = await fetchPdok(fallbackUrl);
  }

  if (!result.response.ok) {
    throw new HttpError(
      502,
      "PDOK_REQUEST_FAILED",
      "PDOK Kadastrale Kaart request failed.",
      result.body
    );
  }

  const candidates = extractPdokFeatures(result.body)
    .map((feature) => normalizeParcel(feature))
    .filter((feature): feature is ParcelResult => Boolean(feature));

  if (candidates.length === 0) {
    throw new HttpError(
      404,
      "NO_CADASTRAL_PARCEL",
      "No cadastral parcel was found near the coordinate.",
      result.body
    );
  }

  const selection = selectBestParcel(candidates, preferredParcelReferences);

  return {
    count: candidates.length,
    bestMatch: selection.bestMatch,
    candidates,
    raw: result.body,
    selection: selection.selection,
    linkedReferences: selection.linkedReferences,
    linkedCandidateMatches: selection.linkedCandidateMatches,
    otherLinkedCandidateMatches: selection.otherLinkedCandidateMatches,
    warnings: [...warnings, ...selection.warnings]
  };
}

async function runCombinedSearch(input: SearchInput): Promise<CombinedSearchResponse> {
  const emptyBag = {
    count: 0,
    results: [] as BagSearchResult[],
    raw: null
  };

  if (input.route === "bag") {
    const bag = await searchBag(input);
    const coordinate = extractCoordinateFromBagResult(bag.results[0]);

    if (!coordinate) {
      throw new HttpError(
        422,
        "NO_USABLE_COORDINATE",
        "A BAG result was found, but no usable EPSG:28992 coordinate could be extracted.",
        bag.results[0]?.raw
      );
    }

    const cadastre = await searchPdokCadastre(coordinate);

    return {
      input,
      routeUsed: "bag",
      source: {
        type: "BAG API",
        count: bag.count,
        bestMatch: bag.results[0],
        results: bag.results,
        raw: bag.raw
      },
      bag,
      coordinate,
      cadastre: {
        count: cadastre.count,
        bestMatch: cadastre.bestMatch,
        candidates: cadastre.candidates,
        raw: cadastre.raw,
        selection: cadastre.selection,
        linkedReferences: cadastre.linkedReferences,
        linkedCandidateMatches: cadastre.linkedCandidateMatches,
        otherLinkedCandidateMatches: cadastre.otherLinkedCandidateMatches
      },
      warnings: cadastre.warnings
    };
  }

  const pdokLocation = await searchPdokLocation(input);
  const coordinate = extractCoordinateFromPdokLocationResult(pdokLocation.bestMatch);

  if (!coordinate) {
    throw new HttpError(
      422,
      "NO_USABLE_COORDINATE",
      "A PDOK Locatieserver result was found, but no usable EPSG:28992 coordinate could be extracted.",
      pdokLocation.bestMatch.raw
    );
  }

  const cadastre = await searchPdokCadastre(
    coordinate,
    pdokLocation.bestMatch.gekoppeldePercelen
  );

  return {
    input,
    routeUsed: "pdok",
    source: {
      type: "PDOK Locatieserver",
      count: pdokLocation.count,
      bestMatch: pdokLocation.bestMatch,
      results: pdokLocation.results,
      raw: pdokLocation.raw
    },
    bag: emptyBag,
    coordinate,
    cadastre: {
      count: cadastre.count,
      bestMatch: cadastre.bestMatch,
      candidates: cadastre.candidates,
      raw: cadastre.raw,
      selection: cadastre.selection,
      linkedReferences: cadastre.linkedReferences,
      linkedCandidateMatches: cadastre.linkedCandidateMatches,
      otherLinkedCandidateMatches: cadastre.otherLinkedCandidateMatches
    },
    warnings: cadastre.warnings
  };
}

app.get("/api/property/search", async (request, response) => {
  try {
    const input = parseInput(request);
    response.json(await runCombinedSearch(input));
  } catch (error) {
    handleError(response, error);
  }
});

app.get("/api/bag/search", async (request, response) => {
  try {
    const input = { ...parseInput(request), route: "bag" as const };
    const bag = await searchBag(input);
    response.json({
      query: input,
      count: bag.count,
      results: bag.results,
      raw: bag.raw
    });
  } catch (error) {
    handleError(response, error);
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`BAG + PDOK proxy server listening on http://localhost:${PORT}`);
  });
}

export default app;
