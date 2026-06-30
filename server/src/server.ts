import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";

dotenv.config();

const PORT = Number(process.env.PORT ?? 3001);
const BAG_BASE_URL =
  "https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2";
const PDOK_BASE_URL =
  "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1";
const EPSG_28992_URI = "http://www.opengis.net/def/crs/EPSG/0/28992";

type RawObject = Record<string, unknown>;

type BagSearchInput = {
  postcode: string;
  huisnummer: string;
  huisletter: string | null;
  huisnummertoevoeging: string | null;
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

type BagCoordinate = {
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

type CombinedSearchResponse = {
  input: BagSearchInput;
  bag: {
    count: number;
    results: BagSearchResult[];
    raw: unknown;
  };
  coordinate: BagCoordinate;
  cadastre: {
    count: number;
    bestMatch: ParcelResult;
    candidates: ParcelResult[];
    raw: unknown;
  };
  warnings: string[];
};

type ApiErrorCode =
  | "MISSING_API_KEY"
  | "MISSING_PARAMETERS"
  | "INVALID_POSTCODE"
  | "INVALID_HUISNUMMER"
  | "BAG_AUTHORIZATION_ERROR"
  | "BAG_RATE_LIMIT"
  | "NO_BAG_RESULT"
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

function parseInput(request: Request): BagSearchInput {
  const postcode = optionalTrim(getSingleQueryValue(request.query.postcode));
  const huisnummer = optionalTrim(getSingleQueryValue(request.query.huisnummer));
  const huisletter = optionalTrim(getSingleQueryValue(request.query.huisletter));
  const huisnummertoevoeging = optionalTrim(
    getSingleQueryValue(request.query.huisnummertoevoeging)
  );

  if (!postcode || !huisnummer) {
    throw new HttpError(
      400,
      "MISSING_PARAMETERS",
      "Postcode and huisnummer are required."
    );
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

  return {
    postcode: cleanedPostcode,
    huisnummer,
    huisletter: huisletter?.toUpperCase() ?? null,
    huisnummertoevoeging: huisnummertoevoeging?.toUpperCase() ?? null
  };
}

function getApiKey(): string {
  const apiKey = process.env.BAG_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(
      500,
      "MISSING_API_KEY",
      "BAG API key is missing. Add BAG_API_KEY to server/.env."
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

function coordinateFromGeometry(
  value: unknown,
  source: string
): BagCoordinate | null {
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

  return null;
}

function extractCoordinateFromBagResult(result: BagSearchResult): BagCoordinate | null {
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
    [firstValue(object ?? {}, ["geometrie", "punt", "vlak"]), "BAG addressable object geometry"],
    [firstValue(rawObject, ["geometrie", "adresseerbaarObjectGeometrie"]), "BAG raw geometry"],
    [rawObject, "BAG result geometry"]
  ];

  for (const [candidate, source] of candidates) {
    const coordinate = coordinateFromGeometry(candidate, source);
    if (coordinate) {
      return coordinate;
    }
  }

  return null;
}

async function searchBag(input: BagSearchInput) {
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
  const kadastraleAanduiding =
    getString(
      firstValue(properties, [
        "kadastraleAanduiding",
        "kadastrale_aanduiding",
        "akr_kadastrale_gemeente_code_waarde"
      ])
    ) ??
    [kadastraleGemeente, sectie, perceelnummer].filter(Boolean).join(" ") ??
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

async function searchPdokCadastre(coordinate: BagCoordinate) {
  const warnings: string[] = [];
  const cqlUrl = new URL(`${PDOK_BASE_URL}/collections/perceel/items`);
  cqlUrl.searchParams.set("filter-lang", "cql2-text");
  cqlUrl.searchParams.set(
    "filter",
    `INTERSECTS(geometry,POINT(${coordinate.x} ${coordinate.y}))`
  );
  cqlUrl.searchParams.set("crs", EPSG_28992_URI);
  cqlUrl.searchParams.set("limit", "10");
  cqlUrl.searchParams.set("f", "json");

  let body: unknown;
  let features: RawObject[] = [];

  try {
    const cql = await fetchPdok(cqlUrl);
    if (cql.response.ok) {
      body = cql.body;
      features = extractPdokFeatures(cql.body);
    } else {
      warnings.push("PDOK CQL2 spatial filter failed; bbox fallback was used.");
    }
  } catch {
    warnings.push("PDOK CQL2 spatial filter failed; bbox fallback was used.");
  }

  if (features.length === 0) {
    const minX = coordinate.x - 2;
    const minY = coordinate.y - 2;
    const maxX = coordinate.x + 2;
    const maxY = coordinate.y + 2;

    const bboxUrl = new URL(`${PDOK_BASE_URL}/collections/perceel/items`);
    bboxUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
    bboxUrl.searchParams.set("bbox-crs", EPSG_28992_URI);
    bboxUrl.searchParams.set("crs", EPSG_28992_URI);
    bboxUrl.searchParams.set("limit", "10");
    bboxUrl.searchParams.set("f", "json");

    let bbox = await fetchPdok(bboxUrl);

    if (!bbox.response.ok) {
      const simpleBboxUrl = new URL(`${PDOK_BASE_URL}/collections/perceel/items`);
      simpleBboxUrl.searchParams.set("bbox", `${minX},${minY},${maxX},${maxY}`);
      simpleBboxUrl.searchParams.set("limit", "10");
      simpleBboxUrl.searchParams.set("f", "json");
      bbox = await fetchPdok(simpleBboxUrl);
    }

    if (!bbox.response.ok) {
      throw new HttpError(
        502,
        "PDOK_REQUEST_FAILED",
        "PDOK Kadastrale Kaart request failed.",
        bbox.body
      );
    }

    body = bbox.body;
    features = extractPdokFeatures(bbox.body);
  }

  const candidates = features
    .map((feature) => normalizeParcel(feature))
    .filter((feature): feature is ParcelResult => Boolean(feature));

  if (candidates.length === 0) {
    throw new HttpError(
      404,
      "NO_CADASTRAL_PARCEL",
      "No cadastral parcel was found near the BAG coordinate.",
      body
    );
  }

  return {
    count: candidates.length,
    bestMatch: candidates[0],
    candidates,
    raw: body,
    warnings
  };
}

async function runCombinedSearch(input: BagSearchInput): Promise<CombinedSearchResponse> {
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
    bag,
    coordinate,
    cadastre: {
      count: cadastre.count,
      bestMatch: cadastre.bestMatch,
      candidates: cadastre.candidates,
      raw: cadastre.raw
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
    const input = parseInput(request);
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

app.listen(PORT, () => {
  console.log(`BAG + PDOK proxy server listening on http://localhost:${PORT}`);
});
