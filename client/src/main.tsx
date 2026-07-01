import React, { ChangeEvent, FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { readSheet } from "read-excel-file/browser";
import "./styles.css";

type SearchRoute = "pdok" | "bag";
type ResultTab = "overview" | "details" | "batch" | "raw";

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
  oorspronkelijkBouwjaar: string | number | Array<string | number> | null;
  oppervlakte: string | number | null;
  gebruiksdoelen: string[];
  status: string | null;
  pandStatus: string | null;
  geometrie: unknown;
  raw: Record<string, unknown>;
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
  score: string | number | null;
  centroide_rd: string | null;
  gekoppeldePercelen: string[];
  gekoppeldeAppartementen: string[];
  raw: Record<string, unknown>;
};

type Coordinate = {
  x: number;
  y: number;
  crs: string;
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
  properties: Record<string, unknown>;
  raw: Record<string, unknown>;
};

type CombinedSearchResponse = {
  input: {
    postcode: string;
    huisnummer: string;
    huisletter: string | null;
    huisnummertoevoeging: string | null;
    route: SearchRoute;
  };
  routeUsed: SearchRoute;
  source: {
    type: "PDOK Locatieserver" | "BAG API";
    count: number;
    bestMatch: PdokLocationResult | BagSearchResult | null;
    results: Array<PdokLocationResult | BagSearchResult>;
    raw: unknown;
  };
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

type ApiErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

type FormState = {
  postcode: string;
  huisnummer: string;
  huisletter: string;
  huisnummertoevoeging: string;
  route: SearchRoute;
};

type SearchRequest = {
  postcode: string;
  huisnummer: string;
  huisletter?: string;
  huisnummertoevoeging?: string;
  route: SearchRoute;
};

type BatchInputRow = {
  id: string;
  rowNumber: number;
  postcode: string;
  huisnummer: string;
  huisletter: string;
  huisnummertoevoeging: string;
};

type BatchResult = {
  row: BatchInputRow;
  status: "success" | "error";
  data?: CombinedSearchResponse;
  error?: string;
};

const initialFormState: FormState = {
  postcode: "",
  huisnummer: "",
  huisletter: "",
  huisnummertoevoeging: "",
  route: "pdok"
};

const exportHeaders = [
  "postcode",
  "huisnummer",
  "huisletter",
  "huisnummertoevoeging",
  "adres",
  "kadastraleGemeente",
  "sectie",
  "bestePerceelnummer",
  "bestePerceel",
  "grootteM2",
  "allePercelen",
  "gekoppeldePercelen",
  "andereGekoppeldePercelen",
  "andereRuimtelijkePercelen",
  "matchMethode",
  "matchReferentie",
  "route",
  "status"
] as const;

const batchCsvHeaders = [
  "rowNumber",
  ...exportHeaders,
  "error"
] as const;

const MAX_BATCH_ROWS = 100;

function isBagResult(value: unknown): value is BagSearchResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "openbareRuimteNaam" in value &&
      "nummeraanduidingIdentificatie" in value
  );
}

function isPdokLocation(value: unknown): value is PdokLocationResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "weergavenaam" in value &&
      "centroide_rd" in value
  );
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "-";
  }

  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function csvEscape(value: unknown): string {
  const text = formatValue(value).replace(/"/g, '""');
  return `"${text}"`;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.name && error.name !== "Error"
      ? `${error.name}: ${error.message}`
      : error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return fallback;
}

async function parseApiResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    const preview = text.slice(0, 220).replace(/\s+/g, " ").trim();
    throw new Error(
      response.ok
        ? "The API returned a response that could not be read as JSON."
        : `The API returned HTTP ${response.status} instead of JSON.${preview ? ` Response: ${preview}` : ""}`
    );
  }
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function bagAddress(result: BagSearchResult): string {
  return [
    result.openbareRuimteNaam,
    result.huisnummer,
    result.huisletter,
    result.huisnummertoevoeging,
    result.postcode,
    result.woonplaatsNaam
  ]
    .filter(Boolean)
    .join(" ");
}

function inputAddress(data: CombinedSearchResponse): string {
  return [
    data.input.postcode,
    data.input.huisnummer,
    data.input.huisletter,
    data.input.huisnummertoevoeging
  ]
    .filter(Boolean)
    .join(" ");
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{formatValue(value)}</dd>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  children
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="result-section">
      <div className="section-title">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function RouteBadge({ route }: { route: SearchRoute }) {
  return (
    <span className="route-badge">
      {route === "pdok" ? "No BAG key needed" : "BAG API key route"}
    </span>
  );
}

function parcelLabel(parcel: ParcelResult): string {
  return [
    parcel.kadastraleAanduiding,
    parcel.grootte ? `${parcel.grootte} m2` : null
  ]
    .filter(Boolean)
    .join(" - ");
}

function otherLinkedReferences(data: CombinedSearchResponse): string[] {
  const matchedReference = data.cadastre.selection.matchedReference;
  return data.cadastre.linkedReferences.filter(
    (reference) => reference !== matchedReference
  );
}

function otherSpatialCandidates(data: CombinedSearchResponse): ParcelResult[] {
  const parcel = data.cadastre.bestMatch;
  const otherLinked = data.cadastre.otherLinkedCandidateMatches;

  return data.cadastre.candidates.filter(
    (candidate) =>
      candidate.identificatie !== parcel.identificatie &&
      !otherLinked.some((linked) => linked.identificatie === candidate.identificatie)
  );
}

function flattenResultForExport(data: CombinedSearchResponse) {
  const parcel = data.cadastre.bestMatch;
  const source = data.source.bestMatch;
  const bag = data.bag.results[0] ?? null;
  const pdok = isPdokLocation(source) ? source : null;
  const allParcels = data.cadastre.candidates.map(parcelLabel);
  const otherLinked = data.cadastre.otherLinkedCandidateMatches.map(parcelLabel);
  const spatialOnly = otherSpatialCandidates(data).map(parcelLabel);

  return {
    postcode: data.input.postcode,
    huisnummer: data.input.huisnummer,
    huisletter: data.input.huisletter,
    huisnummertoevoeging: data.input.huisnummertoevoeging,
    adres: pdok?.weergavenaam ?? (bag ? bagAddress(bag) : inputAddress(data)),
    kadastraleGemeente: parcel.kadastraleGemeente,
    sectie: parcel.sectie,
    bestePerceelnummer: parcel.perceelnummer,
    bestePerceel: parcel.kadastraleAanduiding,
    grootteM2: parcel.grootte,
    allePercelen: allParcels,
    gekoppeldePercelen: data.cadastre.linkedReferences,
    andereGekoppeldePercelen: otherLinked.length > 0 ? otherLinked : otherLinkedReferences(data),
    andereRuimtelijkePercelen: spatialOnly,
    matchMethode: data.cadastre.selection.method,
    matchReferentie: data.cadastre.selection.matchedReference,
    route: data.routeUsed,
    status: "matched"
  };
}

async function searchProperty(request: SearchRequest): Promise<CombinedSearchResponse> {
  const params = new URLSearchParams({
    postcode: request.postcode.replace(/\s+/g, "").toUpperCase(),
    huisnummer: request.huisnummer.trim(),
    route: request.route
  });

  if (request.huisletter?.trim()) {
    params.set("huisletter", request.huisletter.trim());
  }

  if (request.huisnummertoevoeging?.trim()) {
    params.set("huisnummertoevoeging", request.huisnummertoevoeging.trim());
  }

  const requestUrl = `/api/property/search?${params.toString()}`;
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/json"
    }
  }).catch((error: unknown) => {
    throw new Error(
      `Network request failed for ${request.postcode} ${request.huisnummer}: ${getErrorMessage(
        error,
        "Unknown network error."
      )}`
    );
  });
  const body = (await parseApiResponse(response)) as
    | CombinedSearchResponse
    | ApiErrorResponse
    | null;

  if (!response.ok) {
    const apiError = body as ApiErrorResponse;
    throw new Error(
      apiError?.error?.message ??
        `The property search failed with HTTP ${response.status}.`
    );
  }

  if (!body || typeof body !== "object") {
    throw new Error("The property search returned an empty response.");
  }

  return body as CombinedSearchResponse;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getExcelValue(row: Record<string, unknown>, aliases: string[]): string {
  const normalizedAliases = aliases.map(normalizeHeader);
  const matchingKey = Object.keys(row).find((key) =>
    normalizedAliases.includes(normalizeHeader(key))
  );

  const value = matchingKey ? row[matchingKey] : "";
  if (value === null || value === undefined || value instanceof Date) {
    return "";
  }

  return String(value).replace(/\u00a0/g, " ").trim();
}

function normalizeExcelPostcode(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function normalizeExcelHouseNumber(value: string): string {
  const trimmed = value.trim();
  const wholeNumberMatch = trimmed.match(/^(\d+)(?:\.0+)?$/);
  return wholeNumberMatch ? wholeNumberMatch[1] : trimmed;
}

function validateBatchRow(row: BatchInputRow): string | null {
  if (!row.postcode || !row.huisnummer) {
    return "Postcode and huisnummer are required for this row.";
  }

  if (!/^\d{4}[A-Z]{2}$/.test(row.postcode)) {
    return "Postcode must use the Dutch format 1234AB.";
  }

  if (!/^\d+$/.test(row.huisnummer) || Number(row.huisnummer) <= 0) {
    return "Huisnummer must be a positive whole number.";
  }

  return null;
}

function parseExcelRows(rows: Record<string, unknown>[]): BatchInputRow[] {
  return rows
    .map((row, index) => ({
      id: `${index + 2}-${getExcelValue(row, ["postcode"])}`,
      rowNumber: index + 2,
      postcode: normalizeExcelPostcode(
        getExcelValue(row, ["postcode", "post code", "pc"])
      ),
      huisnummer: normalizeExcelHouseNumber(
        getExcelValue(row, [
          "huisnummer",
          "huis nummer",
          "huisnr",
          "nummer"
        ])
      ),
      huisletter: getExcelValue(row, ["huisletter", "letter"]).toUpperCase(),
      huisnummertoevoeging: getExcelValue(row, [
        "huisnummertoevoeging",
        "huisnummer toevoeging",
        "toevoeging"
      ]).toUpperCase()
    }))
    .filter((row) => row.postcode || row.huisnummer);
}

function excelRowsToRecords(rows: unknown[][]): Record<string, unknown>[] {
  const [headerRow, ...dataRows] = rows;
  if (!headerRow) {
    return [];
  }

  const headers = headerRow.map((header) => String(header ?? "").trim());

  return dataRows
    .map((row) =>
      Object.fromEntries(
        headers
          .map((header, index) => [header, row[index] ?? ""])
          .filter(([header]) => header)
      )
    )
    .filter((row) =>
      Object.values(row).some((value) => String(value ?? "").trim() !== "")
    );
}

function ParcelMatchOverview({
  parcel,
  data
}: {
  parcel: ParcelResult;
  data: CombinedSearchResponse;
}) {
  const otherLinked = data.cadastre.otherLinkedCandidateMatches;
  const linkedReferences = otherLinkedReferences(data);
  const spatialOnly = otherSpatialCandidates(data);

  return (
    <div className="match-overview">
      <div className="match-primary">
        <p className="eyebrow">Beste match</p>
        <h3>{parcelLabel(parcel) || "PDOK perceel"}</h3>
        <p>
          Gekozen via {data.cadastre.selection.method}
          {data.cadastre.selection.matchedReference
            ? ` (${data.cadastre.selection.matchedReference})`
            : ""}.
        </p>
      </div>

      <dl className="match-grid">
        <div>
          <dt>Gekoppeld in bron</dt>
          <dd>{formatValue(data.cadastre.linkedReferences)}</dd>
        </div>
        <div>
          <dt>Andere gekoppelde referenties</dt>
          <dd>{formatValue(linkedReferences)}</dd>
        </div>
        <div>
          <dt>Andere gekoppelde kandidaten</dt>
          <dd>
            {otherLinked.length > 0
              ? otherLinked.map(parcelLabel).join(", ")
              : "-"}
          </dd>
        </div>
        <div>
          <dt>Andere ruimtelijke kandidaten</dt>
          <dd>
            {spatialOnly.length > 0
              ? spatialOnly.map(parcelLabel).join(", ")
              : "-"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function PdokSourceSection({ result }: { result: PdokLocationResult }) {
  return (
    <Section eyebrow="3. Source information" title="PDOK Locatieserver match">
      <dl className="field-grid">
        <Field label="Matched address" value={result.weergavenaam} />
        <Field label="Street" value={result.straatnaam} />
        <Field label="House number" value={result.huisnummer} />
        <Field label="Huisletter" value={result.huisletter} />
        <Field label="Toevoeging" value={result.huisnummertoevoeging} />
        <Field label="Postcode" value={result.postcode} />
        <Field label="Woonplaats" value={result.woonplaatsnaam} />
        <Field label="Gemeente" value={result.gemeentenaam} />
        <Field label="Provincie" value={result.provincienaam} />
        <Field label="Result type" value={result.type} />
        <Field label="Score" value={result.score} />
        <Field label="Centroide RD" value={result.centroide_rd} />
        <Field label="Gekoppelde percelen" value={result.gekoppeldePercelen} />
        <Field
          label="Gekoppelde appartementen"
          value={result.gekoppeldeAppartementen}
        />
      </dl>
    </Section>
  );
}

function BagSourceSection({ result }: { result: BagSearchResult }) {
  return (
    <Section eyebrow="3. Source information" title="BAG address and building">
      <dl className="field-grid">
        <Field label="Full address" value={bagAddress(result)} />
        <Field label="Woonplaats" value={result.woonplaatsNaam} />
        <Field
          label="Nummeraanduiding ID"
          value={result.nummeraanduidingIdentificatie}
        />
        <Field
          label="Adresseerbaar object ID"
          value={result.adresseerbaarObjectIdentificatie}
        />
        <Field label="Object type" value={result.adresseerbaarObjectType} />
        <Field label="Bouwjaar" value={result.oorspronkelijkBouwjaar} />
        <Field label="Oppervlakte" value={result.oppervlakte} />
        <Field label="Gebruiksdoelen" value={result.gebruiksdoelen} />
        <Field label="Status" value={result.status} />
        <Field label="Pandstatus" value={result.pandStatus} />
        <Field label="Pand IDs" value={result.pandIdentificaties} />
        <Field label="Adresregel 5" value={result.adresregel5} />
        <Field label="Adresregel 6" value={result.adresregel6} />
      </dl>
    </Section>
  );
}

function RawDataSection({
  data,
  batchResults
}: {
  data: CombinedSearchResponse | null;
  batchResults: BatchResult[];
}) {
  return (
    <Section eyebrow="Raw data" title="Technical responses">
      {!data && batchResults.length === 0 && (
        <div className="state-box">No raw data available yet.</div>
      )}

      {data && (
        <div className="raw-stack">
          <details className="raw-details" open>
            <summary>Full combined response</summary>
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </details>
          <details className="raw-details">
            <summary>Source response</summary>
            <pre>{JSON.stringify(data.source.raw, null, 2)}</pre>
          </details>
          <details className="raw-details">
            <summary>BAG response</summary>
            <pre>{JSON.stringify(data.bag.raw, null, 2)}</pre>
          </details>
          <details className="raw-details">
            <summary>PDOK parcel response</summary>
            <pre>{JSON.stringify(data.cadastre.raw, null, 2)}</pre>
          </details>
          <details className="raw-details">
            <summary>Candidate parcels</summary>
            <pre>{JSON.stringify(data.cadastre.candidates, null, 2)}</pre>
          </details>
        </div>
      )}

      {batchResults.length > 0 && (
        <details className="raw-details">
          <summary>Batch results</summary>
          <pre>{JSON.stringify(batchResults, null, 2)}</pre>
        </details>
      )}
    </Section>
  );
}

function OverviewPage({
  data,
  parcel,
  primaryPdok,
  sourceBag
}: {
  data: CombinedSearchResponse;
  parcel: ParcelResult;
  primaryPdok: PdokLocationResult | null;
  sourceBag: BagSearchResult | null;
}) {
  const allParcels = data.cadastre.candidates.map(parcelLabel);
  const linkedOther = otherLinkedReferences(data);
  const spatialOther = otherSpatialCandidates(data).map(parcelLabel);
  const addressLabel =
    primaryPdok?.weergavenaam ?? (sourceBag ? bagAddress(sourceBag) : inputAddress(data));

  return (
    <div className="overview-page">
      <section className="overview-hero">
        <div>
          <p className="eyebrow">Beste perceelmatch</p>
          <h2>{parcel.kadastraleAanduiding ?? parcelLabel(parcel)}</h2>
          <p>{addressLabel}</p>
        </div>
        <div className="overview-actions">
          <RouteBadge route={data.routeUsed} />
          <span className="confidence-pill">
            {data.cadastre.selection.method === "linked parcel reference"
              ? "Bronkoppeling"
              : "Ruimtelijke match"}
          </span>
        </div>
      </section>

      <div className="overview-grid">
        <section className="overview-panel">
          <p className="eyebrow">Perceel</p>
          <dl className="summary-list">
            <div>
              <dt>Aanduiding</dt>
              <dd>{formatValue(parcel.kadastraleAanduiding)}</dd>
            </div>
            <div>
              <dt>Gemeente</dt>
              <dd>{formatValue(parcel.kadastraleGemeente)}</dd>
            </div>
            <div>
              <dt>Sectie / nummer</dt>
              <dd>{formatValue([parcel.sectie, parcel.perceelnummer].filter(Boolean).join(" "))}</dd>
            </div>
            <div>
              <dt>Grootte</dt>
              <dd>{formatValue(parcel.grootte ? `${parcel.grootte} m2` : null)}</dd>
            </div>
          </dl>
        </section>

        <section className="overview-panel">
          <p className="eyebrow">Match</p>
          <dl className="summary-list">
            <div>
              <dt>Gekozen via</dt>
              <dd>{formatValue(data.cadastre.selection.method)}</dd>
            </div>
            <div>
              <dt>Matched reference</dt>
              <dd>{formatValue(data.cadastre.selection.matchedReference)}</dd>
            </div>
            <div>
              <dt>Gekoppeld in bron</dt>
              <dd>{formatValue(data.cadastre.linkedReferences)}</dd>
            </div>
            <div>
              <dt>Alle gevonden percelen</dt>
              <dd>{formatValue(allParcels)}</dd>
            </div>
          </dl>
        </section>

        <section className="overview-panel">
          <p className="eyebrow">Adresbron</p>
          <dl className="summary-list">
            <div>
              <dt>Route</dt>
              <dd>{data.source.type}</dd>
            </div>
            <div>
              <dt>Woonplaats</dt>
              <dd>{formatValue(primaryPdok?.woonplaatsnaam ?? sourceBag?.woonplaatsNaam)}</dd>
            </div>
            <div>
              <dt>Gemeente / provincie</dt>
              <dd>{formatValue([primaryPdok?.gemeentenaam, primaryPdok?.provincienaam].filter(Boolean).join(", "))}</dd>
            </div>
            <div>
              <dt>BAG kerngegevens</dt>
              <dd>
                {sourceBag
                  ? formatValue([
                      sourceBag.oorspronkelijkBouwjaar
                        ? `bouwjaar ${sourceBag.oorspronkelijkBouwjaar}`
                        : null,
                      sourceBag.oppervlakte ? `${sourceBag.oppervlakte} m2` : null,
                      ...sourceBag.gebruiksdoelen
                    ].filter(Boolean))
                  : "-"}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {(linkedOther.length > 0 || spatialOther.length > 0) && (
        <section className="overview-panel">
          <p className="eyebrow">Let ook op</p>
          <dl className="summary-list two-column">
            <div>
              <dt>Andere gekoppelde referenties</dt>
              <dd>{formatValue(linkedOther)}</dd>
            </div>
            <div>
              <dt>Andere ruimtelijke kandidaten</dt>
              <dd>{formatValue(spatialOther)}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}

function DetailsPage({
  data,
  parcel,
  primaryPdok,
  sourceBag
}: {
  data: CombinedSearchResponse;
  parcel: ParcelResult;
  primaryPdok: PdokLocationResult | null;
  sourceBag: BagSearchResult | null;
}) {
  return (
    <div className="result-stack">
      {data.warnings.length > 0 && (
        <div className="state-box warning">{data.warnings.join(" ")}</div>
      )}

      <Section eyebrow="1. Input address" title={inputAddress(data)}>
        <dl className="field-grid compact">
          <Field label="Postcode" value={data.input.postcode} />
          <Field label="Huisnummer" value={data.input.huisnummer} />
          <Field label="Huisletter" value={data.input.huisletter} />
          <Field label="Toevoeging" value={data.input.huisnummertoevoeging} />
        </dl>
      </Section>

      <Section eyebrow="2. Route used" title={data.source.type}>
        <div className="route-summary">
          <RouteBadge route={data.routeUsed} />
          <p>
            {data.routeUsed === "pdok"
              ? "PDOK Locatieserver found an address coordinate without using a BAG API key."
              : "The official BAG API returned BAG data and a coordinate using the server-side API key."}
          </p>
        </div>
      </Section>

      {primaryPdok && <PdokSourceSection result={primaryPdok} />}
      {data.routeUsed === "bag" && sourceBag && (
        <BagSourceSection result={sourceBag} />
      )}

      <Section eyebrow="4. Coordinate used" title={data.coordinate.crs}>
        <dl className="field-grid compact">
          <Field label="X" value={data.coordinate.x} />
          <Field label="Y" value={data.coordinate.y} />
          <Field label="CRS" value={data.coordinate.crs} />
          <Field label="Source" value={data.coordinate.source} />
        </dl>
      </Section>

      <Section eyebrow="5. Cadastral parcel information" title="PDOK parcel">
        <ParcelMatchOverview parcel={parcel} data={data} />

        <dl className="field-grid">
          <Field label="Parcel identifier" value={parcel.identificatie} />
          <Field label="Cadastral municipality" value={parcel.kadastraleGemeente} />
          <Field label="Section" value={parcel.sectie} />
          <Field label="Parcel number" value={parcel.perceelnummer} />
          <Field label="Cadastral indication" value={parcel.kadastraleAanduiding} />
          <Field label="Parcel size" value={parcel.grootte} />
          <Field label="Size type" value={parcel.soortGrootte} />
          <Field label="Candidate parcels" value={data.cadastre.count} />
          <Field label="Selection method" value={data.cadastre.selection.method} />
          <Field label="Matched reference" value={data.cadastre.selection.matchedReference} />
        </dl>
      </Section>
    </div>
  );
}

function App() {
  const [form, setForm] = useState<FormState>(initialFormState);
  const [data, setData] = useState<CombinedSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [batchRows, setBatchRows] = useState<BatchInputRow[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [activeTab, setActiveTab] = useState<ResultTab>("overview");

  const parcel = data?.cadastre.bestMatch ?? null;
  const sourceMatch = data?.source.bestMatch ?? null;
  const primaryBag = data?.bag.results[0] ?? null;
  const primaryPdok = isPdokLocation(sourceMatch) ? sourceMatch : null;
  const sourceBag = isBagResult(sourceMatch) ? sourceMatch : primaryBag;

  const normalizedPostcode = useMemo(
    () => form.postcode.replace(/\s+/g, "").toUpperCase(),
    [form.postcode]
  );

  const loadingMessage =
    form.route === "pdok"
      ? "Searching address with PDOK Locatieserver, then retrieving cadastral parcel..."
      : "Searching BAG first, then retrieving cadastral parcel from PDOK...";

  function updateField(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setData(null);

    try {
      const result = await searchProperty({
        postcode: normalizedPostcode,
        huisnummer: form.huisnummer,
        huisletter: form.huisletter,
        huisnummertoevoeging: form.huisnummertoevoeging,
        route: form.route
      });
      setData(result);
      setActiveTab("overview");
    } catch (searchError) {
      setError(
        searchError instanceof Error
          ? searchError.message
          : "The property search failed. Check the input and local server."
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleBatchFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setBatchError(null);
    setBatchResults([]);
    setBatchProgress(0);

    try {
      const rows = await readSheet(file);
      const parsedRows = parseExcelRows(excelRowsToRecords(rows));

      if (parsedRows.length === 0) {
        setBatchRows([]);
        setBatchError("No rows with postcode and huisnummer were found.");
        return;
      }

      if (parsedRows.length > MAX_BATCH_ROWS) {
        setBatchRows([]);
        setBatchError(
          `This Excel contains ${parsedRows.length} address rows. The maximum batch size is ${MAX_BATCH_ROWS}. Split the file and upload a smaller batch.`
        );
        event.target.value = "";
        return;
      }

      setBatchRows(parsedRows);
      setActiveTab("batch");
    } catch (readError) {
      setBatchRows([]);
      setBatchError(
        `The Excel file could not be read: ${getErrorMessage(
          readError,
          "Unknown Excel parsing error."
        )}`
      );
    }
  }

  async function processBatch() {
    if (batchRows.length === 0) {
      setBatchError("Upload an Excel file with address rows first.");
      return;
    }

    if (batchRows.length > MAX_BATCH_ROWS) {
      setBatchError(`The maximum batch size is ${MAX_BATCH_ROWS} address rows.`);
      return;
    }

    setBatchLoading(true);
    setBatchError(null);
    setBatchResults([]);
    setBatchProgress(0);

    try {
      for (const row of batchRows) {
        const validationError = validateBatchRow(row);
        if (validationError) {
          setBatchResults((current) => [
            ...current,
            {
              row,
              status: "error",
              error: validationError
            }
          ]);
          setBatchProgress((current) => current + 1);
          continue;
        }

        try {
          const result = await searchProperty({
            postcode: row.postcode,
            huisnummer: row.huisnummer,
            huisletter: row.huisletter,
            huisnummertoevoeging: row.huisnummertoevoeging,
            route: form.route
          });
          setBatchResults((current) => [
            ...current,
            { row, status: "success", data: result }
          ]);
        } catch (searchError) {
          setBatchResults((current) => [
            ...current,
            {
              row,
              status: "error",
              error: getErrorMessage(searchError, "Search failed for this row.")
            }
          ]);
        } finally {
          setBatchProgress((current) => current + 1);
        }
      }
    } catch (batchError) {
      setBatchError(
        `Batch processing stopped unexpectedly: ${getErrorMessage(
          batchError,
          "Unknown batch error."
        )}`
      );
    } finally {
      setBatchLoading(false);
      setActiveTab("batch");
    }
  }

  function exportJson() {
    if (!data) {
      return;
    }

    downloadFile(
      "bag-viewer-property-result.json",
      JSON.stringify(data, null, 2),
      "application/json"
    );
  }

  function exportCsv() {
    if (!data || !parcel) {
      return;
    }

    const flatRow = flattenResultForExport(data);

    const rows = [
      exportHeaders.map(csvEscape).join(","),
      exportHeaders.map((header) => csvEscape(flatRow[header])).join(",")
    ];

    downloadFile(
      "percelen-overzicht.csv",
      rows.join("\n"),
      "text/csv;charset=utf-8"
    );
  }

  function exportBatchJson() {
    if (batchResults.length === 0) {
      return;
    }

    downloadFile(
      "bag-viewer-batch-results.json",
      JSON.stringify(batchResults, null, 2),
      "application/json"
    );
  }

  function exportBatchCsv() {
    if (batchResults.length === 0) {
      return;
    }

    const rows = [
      batchCsvHeaders.map(csvEscape).join(","),
      ...batchResults.map((result) => {
        const flat = result.data ? flattenResultForExport(result.data) : null;
        const row = {
          rowNumber: result.row.rowNumber,
          ...(flat ?? {}),
          postcode: flat?.postcode ?? result.row.postcode,
          huisnummer: flat?.huisnummer ?? result.row.huisnummer,
          huisletter: flat?.huisletter ?? result.row.huisletter,
          huisnummertoevoeging:
            flat?.huisnummertoevoeging ?? result.row.huisnummertoevoeging,
          status: flat?.status ?? "error",
          error: result.error ?? null
        };

        return batchCsvHeaders.map((header) => csvEscape(row[header])).join(",");
      })
    ];

    downloadFile(
      "percelen-batch-overzicht.csv",
      rows.join("\n"),
      "text/csv;charset=utf-8"
    );
  }

  return (
    <main>
      <section className="search-band">
        <div className="app-shell">
          <div className="intro">
            <p className="eyebrow">Dutch cadastral lookup</p>
            <h1>Parcel lookup</h1>
            <p>
              Search Dutch addresses and review the best cadastral parcel match,
              linked parcels and source details in one focused workspace.
            </p>
          </div>

          <form className="search-form" onSubmit={handleSubmit}>
            <fieldset className="route-selector">
              <legend>Data source</legend>
              <label className="route-option">
                <input
                  type="radio"
                  name="route"
                  value="pdok"
                  checked={form.route === "pdok"}
                  onChange={() => updateField("route", "pdok")}
                />
                <span>PDOK Locatieserver</span>
              </label>
              <label className="route-option">
                <input
                  type="radio"
                  name="route"
                  value="bag"
                  checked={form.route === "bag"}
                  onChange={() => updateField("route", "bag")}
                />
                <span>Official BAG API</span>
              </label>
            </fieldset>

            <label>
              <span>Postcode</span>
              <input
                value={form.postcode}
                onChange={(event) => updateField("postcode", event.target.value)}
                placeholder="1234 AB"
                autoComplete="postal-code"
                required
              />
            </label>

            <label>
              <span>Huisnummer</span>
              <input
                value={form.huisnummer}
                onChange={(event) => updateField("huisnummer", event.target.value)}
                placeholder="10"
                inputMode="numeric"
                required
              />
            </label>

            <label>
              <span>Huisletter</span>
              <input
                value={form.huisletter}
                onChange={(event) => updateField("huisletter", event.target.value)}
                placeholder="A"
                maxLength={1}
              />
            </label>

            <label>
              <span>Toevoeging</span>
              <input
                value={form.huisnummertoevoeging}
                onChange={(event) =>
                  updateField("huisnummertoevoeging", event.target.value)
                }
                placeholder="bis"
              />
            </label>

            <button className="primary-button" type="submit" disabled={loading}>
              {loading ? "Searching..." : "Find parcel"}
            </button>
          </form>
        </div>
      </section>

      <section className="results-band">
        <div className="app-shell">
          <div className="toolbar">
            <div>
              <p className="eyebrow">Match overview</p>
              <h2>{data ? "Best parcel and linked records" : "Ready to search"}</h2>
            </div>
            <div className="export-actions">
              <button type="button" onClick={exportCsv} disabled={!data}>
                CSV overzicht
              </button>
              <button type="button" onClick={exportJson} disabled={!data}>
                JSON volledig
              </button>
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Result views">
            <button
              type="button"
              className={activeTab === "overview" ? "active" : ""}
              onClick={() => setActiveTab("overview")}
            >
              Overzicht
            </button>
            <button
              type="button"
              className={activeTab === "details" ? "active" : ""}
              onClick={() => setActiveTab("details")}
            >
              Details
            </button>
            <button
              type="button"
              className={activeTab === "batch" ? "active" : ""}
              onClick={() => setActiveTab("batch")}
            >
              Batch
            </button>
            <button
              type="button"
              className={activeTab === "raw" ? "active" : ""}
              onClick={() => setActiveTab("raw")}
            >
              Raw data
            </button>
          </div>

          {activeTab === "batch" && (
          <section className="result-section batch-section">
            <div className="section-title">
              <p className="eyebrow">Batch lookup</p>
              <h2>Excel upload</h2>
              <p className="section-note">
                Upload maximaal {MAX_BATCH_ROWS} adressen per bestand.
              </p>
            </div>

            <div className="batch-controls">
              <label className="file-input">
                <span>Excel file</span>
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={handleBatchFile}
                  disabled={batchLoading}
                />
              </label>
              <button
                type="button"
                onClick={processBatch}
                disabled={batchLoading || batchRows.length === 0}
              >
                {batchLoading
                  ? `Processing ${batchProgress}/${batchRows.length}`
                  : "Generate parcel list"}
              </button>
              <button
                type="button"
                onClick={exportBatchCsv}
                disabled={batchResults.length === 0}
              >
                CSV overzicht
              </button>
              <button
                type="button"
                onClick={exportBatchJson}
                disabled={batchResults.length === 0}
              >
                JSON volledig
              </button>
            </div>

            {batchError && (
              <div className="state-box error batch-message" role="alert">
                {batchError}
              </div>
            )}

            {batchRows.length > 0 && (
              <div className="batch-summary">
                <span>{batchRows.length} address rows loaded</span>
                <span>Route: {form.route === "pdok" ? "PDOK Locatieserver" : "BAG API"}</span>
                {batchResults.length > 0 && (
                  <span>
                    {batchResults.filter((result) => result.status === "success").length} matched,
                    {" "}
                    {batchResults.filter((result) => result.status === "error").length} errors
                  </span>
                )}
              </div>
            )}

            {batchResults.length > 0 && (
              <div className="batch-table-wrap">
                <table className="batch-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Input</th>
                      <th>Best parcel</th>
                      <th>Match overview</th>
                      <th>All parcels</th>
                      <th>Other linked</th>
                      <th>Other spatial</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchResults.map((result) => {
                      const resultData = result.data;
                      const bestParcel = resultData?.cadastre.bestMatch ?? null;
                      const otherLinked = resultData
                        ? otherLinkedReferences(resultData)
                        : [];
                      const spatialOnly = resultData
                        ? otherSpatialCandidates(resultData).map(parcelLabel)
                        : [];
                      const allParcels = resultData
                        ? resultData.cadastre.candidates.map(parcelLabel)
                        : [];

                      return (
                        <tr key={result.row.id}>
                          <td>{result.row.rowNumber}</td>
                          <td>
                            {[
                              result.row.postcode,
                              result.row.huisnummer,
                              result.row.huisletter,
                              result.row.huisnummertoevoeging
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          </td>
                          <td>
                            {bestParcel ? parcelLabel(bestParcel) : "-"}
                          </td>
                          <td>
                            {resultData
                              ? `${resultData.cadastre.selection.method} ${
                                  resultData.cadastre.selection.matchedReference ?? ""
                                }`
                              : "-"}
                          </td>
                          <td>{formatValue(allParcels)}</td>
                          <td>{formatValue(otherLinked)}</td>
                          <td>{formatValue(spatialOnly)}</td>
                          <td>
                            {result.status === "success"
                              ? "Matched"
                              : result.error ?? "Error"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          )}

          {activeTab === "overview" && loading && (
            <div className="state-box">{loadingMessage}</div>
          )}

          {activeTab === "overview" && error && (
            <div className="state-box error" role="alert">
              {error}
            </div>
          )}

          {activeTab === "overview" && !loading && !error && !data && (
            <div className="state-box">
              The default route works without a BAG API key. Choose the BAG route only
              when you have configured `BAG_API_KEY` in `server/.env`.
            </div>
          )}

          {activeTab === "overview" && data && parcel && (
            <OverviewPage
              data={data}
              parcel={parcel}
              primaryPdok={primaryPdok}
              sourceBag={sourceBag}
            />
          )}

          {activeTab === "details" && data && parcel && (
            <DetailsPage
              data={data}
              parcel={parcel}
              primaryPdok={primaryPdok}
              sourceBag={sourceBag}
            />
          )}

          {activeTab === "details" && !data && (
            <div className="state-box">Search an address to view detailed fields.</div>
          )}

          {activeTab === "raw" && (
            <RawDataSection data={data} batchResults={batchResults} />
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
