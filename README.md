# Bag-viewer

Bag-viewer is a local React + Express application for looking up public Dutch address and cadastral parcel information with official APIs only.

The app supports two search routes:

1. **Without BAG API key - PDOK Locatieserver**
   `PDOK Locatieserver -> RD coordinate -> PDOK Kadastrale Kaart`
2. **With BAG API key - official BAG API**
   `BAG API -> full BAG information + RD coordinate -> PDOK Kadastrale Kaart`

The default route is PDOK Locatieserver, so the app works without a BAG API key.

## What Each Dataset Provides

BAG data describes addresses and addressable objects: street and address fields, woonplaats, BAG object IDs, pand IDs, bouwjaar, oppervlakte, gebruiksdoelen, status, and geometry.

PDOK Locatieserver is used to find an address match and RD coordinate without an API key.

PDOK Kadastrale Kaart provides public parcel map information: parcel identifier, cadastral municipality, section, parcel number, parcel size where available, and parcel boundary geometry.

PDOK Kadastrale Kaart does **not** provide ownership data, owner names, mortgages, rights, or official cadastral extracts. The public cadastral map is indicative and should not replace official cadastral research.

## Install

```bash
npm run install:all
```

## Optional BAG API Key

The PDOK route works without a key. The BAG route requires `BAG_API_KEY` in `server/.env`.

Create the env file:

```bash
cp server/.env.example server/.env
```

For PDOK-only use, you can leave `BAG_API_KEY` as the placeholder. For the BAG route, add your Kadaster key:

```env
BAG_API_KEY=your_bag_api_key_here
PORT=3001
```

The frontend never receives the key. The backend sends it to Kadaster as `X-Api-Key`.

## Run

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

The backend runs on:

```text
http://localhost:3001
```

## Batch Lookup With Excel

The frontend can process an `.xlsx` file and generate a list of parcel matches for multiple addresses.

Use the first sheet with a header row. Supported column names include:

```text
postcode
huisnummer
huisletter
huisnummertoevoeging
```

The optional columns may be left empty. The batch lookup uses the route selected in the form:

- `pdok`: works without a BAG API key.
- `bag`: requires `BAG_API_KEY` in `server/.env`.

For each row, the app returns the best parcel match, the selection method, linked parcel references from the source, other linked references, other linked candidate parcels, other spatial candidates, and any row-level error.

CSV downloads are intentionally compact parcel overviews focused on cadastral municipality, section, parcel number or parcel references, parcel size, match method, and row status. JSON downloads contain the full technical response for auditing or debugging.

## Build And Start

```bash
npm run build
npm run start
```

`npm run start` starts the built backend. For production hosting, serve `client/dist` with a static file server or hosting platform.

## Deploy On Vercel

This repository includes `vercel.json` for Vercel deployments.

Vercel uses:

- install command: `npm run install:all`
- build command: `npm run build`
- output directory: `client/dist`
- serverless API route: `/api/property/search`

If you want to use the BAG route on Vercel, add `BAG_API_KEY` as an environment variable in the Vercel project settings. The default PDOK route works without a BAG key.

## Local API

Endpoint:

```text
GET /api/property/search
```

Query parameters:

```text
postcode
huisnummer
huisletter optional
huisnummertoevoeging optional
route optional: pdok or bag
```

If `route` is missing, the backend uses:

```text
pdok
```

### Route A: PDOK Locatieserver

Uses:

```text
https://api.pdok.nl/bzk/locatieserver/search/v3_1/free
```

The backend searches the address, prefers address-level results, extracts `centroide_rd`, and uses that EPSG:28992 coordinate for the parcel lookup.

### Route B: BAG API

Uses:

```text
https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2/adressenuitgebreid
```

with `postcode`, `huisnummer`, optional `huisletter`, optional `huisnummertoevoeging`, `exacteMatch=true`, `page=1`, `pageSize=20`, `Accept: application/hal+json`, `Accept-Crs: epsg:28992`, and `X-Api-Key`.

The BAG API Individuele Bevragingen is intended for individual lookups. Do not use it for large-scale scraping or bulk collection.

### Parcel Lookup

Both routes use:

```text
https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/perceel/items
```

The backend queries a small EPSG:28992 bbox around the address coordinate and retries without CRS parameters if necessary.
