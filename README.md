# BAG + Cadastral Parcel Lookup

This local web application searches an address in the official Kadaster BAG API by Dutch postcode and house number. It then uses the BAG coordinate to query the PDOK Kadastrale Kaart OGC API Features service for the corresponding public cadastral parcel.

The browser only talks to the local Express backend. The BAG API key stays in `server/.env` and is never exposed to frontend code.

## What The App Does

1. You enter a postcode, huisnummer, and optional huisletter or huisnummertoevoeging.
2. The backend queries the BAG API Individuele Bevragingen v2 endpoint `/adressenuitgebreid`.
3. The backend normalizes BAG address, building, geometry, object ID, status, usage, surface, and bouwjaar fields.
4. The backend extracts the best BAG coordinate in EPSG:28992.
5. The backend queries PDOK Kadastrale Kaart collection `perceel`.
6. The frontend displays the input address, BAG information, and cadastral parcel information separately.

## BAG And PDOK Are Different

BAG data describes addresses and addressable objects: street/address fields, woonplaats, verblijfsobject or other object IDs, pand IDs, bouwjaar, oppervlakte, gebruiksdoelen, object type, status, and geometry.

PDOK Kadastrale Kaart data describes public parcel map information: cadastral parcel identifier, cadastral municipality, section, parcel number, parcel size where available, and parcel boundary geometry.

PDOK Kadastrale Kaart does not provide ownership data, owner names, mortgages, rights, or official cadastral extracts. The public cadastral map is indicative and should not replace official cadastral research.

## Install Dependencies

```bash
npm run install:all
```

## Add The BAG API Key

Create a local env file:

```bash
cp server/.env.example server/.env
```

Then set your Kadaster BAG API key:

```env
BAG_API_KEY=your_bag_api_key_here
PORT=3001
```

The backend forwards the key to Kadaster with:

```text
X-Api-Key: <your key>
```

## Run The App

Start both the Express backend and Vite frontend:

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

## Build And Start

```bash
npm run build
npm run start
```

`npm run start` starts the built backend. For production hosting, serve the files from `client/dist` with a static file server or hosting platform.

## Local API

The combined endpoint is:

```text
GET /api/property/search
```

Query parameters:

```text
postcode
huisnummer
huisletter optional
huisnummertoevoeging optional
```

The backend uses BAG:

```text
https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2/adressenuitgebreid
```

with `exacteMatch=true`, `page=1`, `pageSize=20`, `Accept: application/hal+json`, `Accept-Crs: epsg:28992`, and `X-Api-Key`.

The backend uses PDOK:

```text
https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/perceel/items
```

It first tries a CQL2 spatial filter and falls back to a small EPSG:28992 bbox around the BAG coordinate.

The BAG API Individuele Bevragingen is intended for individual lookups. Do not use this app for large-scale scraping or bulk collection.
