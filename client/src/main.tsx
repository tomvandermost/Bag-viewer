import React, { FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

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
  raw: Record<string, unknown>;
};

type BagCoordinate = {
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
  };
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
};

const initialFormState: FormState = {
  postcode: "",
  huisnummer: "",
  huisletter: "",
  huisnummertoevoeging: ""
};

const csvHeaders = [
  "postcode",
  "huisnummer",
  "huisletter",
  "huisnummertoevoeging",
  "openbareRuimteNaam",
  "woonplaatsNaam",
  "nummeraanduidingIdentificatie",
  "adresseerbaarObjectIdentificatie",
  "adresseerbaarObjectType",
  "pandIdentificaties",
  "oorspronkelijkBouwjaar",
  "oppervlakte",
  "gebruiksdoelen",
  "status",
  "pandStatus",
  "coordinateX",
  "coordinateY",
  "coordinateCrs",
  "parcelIdentificatie",
  "kadastraleGemeente",
  "sectie",
  "perceelnummer",
  "kadastraleAanduiding",
  "soortGrootte",
  "grootte"
] as const;

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

function fullAddress(result: BagSearchResult): string {
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

function App() {
  const [form, setForm] = useState<FormState>(initialFormState);
  const [data, setData] = useState<CombinedSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canExport = Boolean(data);
  const primaryBag = data?.bag.results[0] ?? null;
  const parcel = data?.cadastre.bestMatch ?? null;

  const normalizedPostcode = useMemo(
    () => form.postcode.replace(/\s+/g, "").toUpperCase(),
    [form.postcode]
  );

  function updateField(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setData(null);

    const params = new URLSearchParams({
      postcode: normalizedPostcode,
      huisnummer: form.huisnummer.trim()
    });

    if (form.huisletter.trim()) {
      params.set("huisletter", form.huisletter.trim());
    }

    if (form.huisnummertoevoeging.trim()) {
      params.set("huisnummertoevoeging", form.huisnummertoevoeging.trim());
    }

    try {
      const response = await fetch(`/api/property/search?${params.toString()}`);
      const body = (await response.json()) as
        | CombinedSearchResponse
        | ApiErrorResponse;

      if (!response.ok) {
        const apiError = body as ApiErrorResponse;
        setError(apiError.error?.message ?? "The combined BAG and PDOK search failed.");
        return;
      }

      setData(body as CombinedSearchResponse);
    } catch {
      setError("The local server is not reachable. Check that npm run dev is running.");
    } finally {
      setLoading(false);
    }
  }

  function exportJson() {
    if (!data) {
      return;
    }

    downloadFile(
      "bag-cadastral-result.json",
      JSON.stringify(data, null, 2),
      "application/json"
    );
  }

  function exportCsv() {
    if (!data || !primaryBag || !parcel) {
      return;
    }

    const flatRow = {
      postcode: data.input.postcode,
      huisnummer: data.input.huisnummer,
      huisletter: data.input.huisletter,
      huisnummertoevoeging: data.input.huisnummertoevoeging,
      openbareRuimteNaam: primaryBag.openbareRuimteNaam,
      woonplaatsNaam: primaryBag.woonplaatsNaam,
      nummeraanduidingIdentificatie: primaryBag.nummeraanduidingIdentificatie,
      adresseerbaarObjectIdentificatie:
        primaryBag.adresseerbaarObjectIdentificatie,
      adresseerbaarObjectType: primaryBag.adresseerbaarObjectType,
      pandIdentificaties: primaryBag.pandIdentificaties,
      oorspronkelijkBouwjaar: primaryBag.oorspronkelijkBouwjaar,
      oppervlakte: primaryBag.oppervlakte,
      gebruiksdoelen: primaryBag.gebruiksdoelen,
      status: primaryBag.status,
      pandStatus: primaryBag.pandStatus,
      coordinateX: data.coordinate.x,
      coordinateY: data.coordinate.y,
      coordinateCrs: data.coordinate.crs,
      parcelIdentificatie: parcel.identificatie,
      kadastraleGemeente: parcel.kadastraleGemeente,
      sectie: parcel.sectie,
      perceelnummer: parcel.perceelnummer,
      kadastraleAanduiding: parcel.kadastraleAanduiding,
      soortGrootte: parcel.soortGrootte,
      grootte: parcel.grootte
    };

    const rows = [
      csvHeaders.map(csvEscape).join(","),
      csvHeaders.map((header) => csvEscape(flatRow[header])).join(",")
    ];

    downloadFile("bag-cadastral-result.csv", rows.join("\n"), "text/csv;charset=utf-8");
  }

  return (
    <main>
      <section className="search-band">
        <div className="app-shell">
          <div className="intro">
            <p className="eyebrow">BAG + PDOK Kadastrale Kaart</p>
            <h1>Property lookup</h1>
            <p>
              Search the official BAG address API first, then use the BAG coordinate
              to retrieve the matching public cadastral parcel from PDOK.
            </p>
          </div>

          <form className="search-form" onSubmit={handleSubmit}>
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
              {loading ? "Searching..." : "Search BAG + cadastral parcel"}
            </button>
          </form>
        </div>
      </section>

      <section className="results-band">
        <div className="app-shell">
          <div className="toolbar">
            <div>
              <p className="eyebrow">Combined result</p>
              <h2>{data ? "BAG and cadastral parcel" : "Ready to search"}</h2>
            </div>
            <div className="export-actions">
              <button type="button" onClick={exportCsv} disabled={!canExport}>
                CSV
              </button>
              <button type="button" onClick={exportJson} disabled={!canExport}>
                JSON
              </button>
            </div>
          </div>

          {loading && (
            <div className="state-box">
              Searching BAG first, then retrieving cadastral parcel from PDOK...
            </div>
          )}

          {error && (
            <div className="state-box error" role="alert">
              {error}
            </div>
          )}

          {!loading && !error && !data && (
            <div className="state-box">
              Enter a Dutch postcode and house number to retrieve BAG address data and
              the corresponding public cadastral parcel.
            </div>
          )}

          {data && primaryBag && parcel && (
            <div className="result-stack">
              {data.warnings.length > 0 && (
                <div className="state-box warning">{data.warnings.join(" ")}</div>
              )}

              <Section eyebrow="1. Input address" title={fullAddress(primaryBag)}>
                <dl className="field-grid compact">
                  <Field label="Postcode" value={data.input.postcode} />
                  <Field label="Huisnummer" value={data.input.huisnummer} />
                  <Field label="Huisletter" value={data.input.huisletter} />
                  <Field
                    label="Toevoeging"
                    value={data.input.huisnummertoevoeging}
                  />
                  <Field label="Coordinate X" value={data.coordinate.x} />
                  <Field label="Coordinate Y" value={data.coordinate.y} />
                  <Field label="Coordinate CRS" value={data.coordinate.crs} />
                  <Field label="Coordinate source" value={data.coordinate.source} />
                </dl>
              </Section>

              <Section eyebrow="2. BAG information" title="Address and building">
                <dl className="field-grid">
                  <Field label="Full address" value={fullAddress(primaryBag)} />
                  <Field label="Woonplaats" value={primaryBag.woonplaatsNaam} />
                  <Field
                    label="Nummeraanduiding ID"
                    value={primaryBag.nummeraanduidingIdentificatie}
                  />
                  <Field
                    label="Adresseerbaar object ID"
                    value={primaryBag.adresseerbaarObjectIdentificatie}
                  />
                  <Field
                    label="Object type"
                    value={primaryBag.adresseerbaarObjectType}
                  />
                  <Field
                    label="Bouwjaar"
                    value={primaryBag.oorspronkelijkBouwjaar}
                  />
                  <Field label="Oppervlakte" value={primaryBag.oppervlakte} />
                  <Field label="Gebruiksdoelen" value={primaryBag.gebruiksdoelen} />
                  <Field label="Status" value={primaryBag.status} />
                  <Field label="Pandstatus" value={primaryBag.pandStatus} />
                  <Field label="Pand IDs" value={primaryBag.pandIdentificaties} />
                  <Field label="Adresregel 5" value={primaryBag.adresregel5} />
                  <Field label="Adresregel 6" value={primaryBag.adresregel6} />
                </dl>

                <details className="raw-details">
                  <summary>Raw BAG response</summary>
                  <pre>{JSON.stringify(primaryBag.raw, null, 2)}</pre>
                </details>
              </Section>

              <Section eyebrow="3. Cadastral parcel information" title="PDOK parcel">
                <dl className="field-grid">
                  <Field label="Parcel identifier" value={parcel.identificatie} />
                  <Field
                    label="Cadastral municipality"
                    value={parcel.kadastraleGemeente}
                  />
                  <Field label="Section" value={parcel.sectie} />
                  <Field label="Parcel number" value={parcel.perceelnummer} />
                  <Field
                    label="Cadastral indication"
                    value={parcel.kadastraleAanduiding}
                  />
                  <Field label="Parcel size" value={parcel.grootte} />
                  <Field label="Size type" value={parcel.soortGrootte} />
                  <Field label="Candidate parcels" value={data.cadastre.count} />
                </dl>

                <details className="raw-details">
                  <summary>Parcel geometry and properties</summary>
                  <pre>
                    {JSON.stringify(
                      { geometry: parcel.geometry, properties: parcel.properties },
                      null,
                      2
                    )}
                  </pre>
                </details>

                <details className="raw-details">
                  <summary>All candidate parcels</summary>
                  <pre>{JSON.stringify(data.cadastre.candidates, null, 2)}</pre>
                </details>
              </Section>
            </div>
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
