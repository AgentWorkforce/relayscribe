# White-labeling Relayscribe

Relayscribe is the brand-neutral base. Ship a fully white-labeled build —
your product name, icon, bundle id, and consent copy — without touching any
recorder logic or the sidecar. Everything lives in one config file plus one icon.

## TL;DR

```bash
# 1. Add a brand config + icon
cp branding/brands/agent-relay.json branding/brands/acme-notes.json
$EDITOR branding/brands/acme-notes.json        # name, appId, colors, consent
mkdir -p branding/assets/acme-notes
cp ~/acme-logo.svg branding/assets/acme-notes/icon.svg

# 2. Validate (no build, ~1s)
npm run branding:verify

# 3. Apply the brand, then build
npm run branding:apply -- --brand acme-notes
make dmg
```

The default `agent-relay` brand is just `branding/brands/agent-relay.json` — the
same mechanism, no special-casing.

## What a brand sets

`branding/brands/<id>.json` is validated against [`branding.schema.json`](./branding.schema.json)
and is **presentation-only** — it cannot change recorder behavior or the
Swift↔sidecar contract.

| Field | Brands |
|-------|--------|
| `productName` | App name — menu bar, window titles, About box, DMG, `Info.plist` `CFBundleDisplayName`, and `Brand.productName` in Swift |
| `shortName` | Status copy, e.g. "Sent to `<shortName>`" |
| `appId` | Bundle id (`Info.plist` `CFBundleIdentifier` + `Brand.bundleIdentifier`). Reverse-DNS, unique per brand |
| `icon` | App + DMG icon. The `.svg` is rasterized to `.icns` at build time |
| `consent.*` | macOS permission prompts → `Info.plist` `NS*UsageDescription` |
| `supportUrl` | Surfaced in-app via `Brand.supportURL` |

## How it works

`npm run branding:apply -- --brand <id>` (or `--brand-file <path>` for a brand
config living outside this repo, e.g. in a downstream overlay) reads the brand
JSON and regenerates, in place:

- `Relayscribe/Sources/Brand.swift` — product strings compiled into the app
- `Relayscribe/AppBundle/Info.plist` — display name, bundle id, consent copy
- `Relayscribe/AppBundle/Resources/icon.icns` — rasterized brand icon
- `branding/.generated/<id>/build.env` — `APP_NAME` / `DMG_NAME` etc. for the
  release workflow to `source`

The executable/bundle name stays `Relayscribe` for every brand — that's the
binary SwiftPM builds. Only presentation changes.

The base ships with the default brand already applied, so it builds without
running `apply-branding`. CI (`.github/workflows/build.yml`) re-applies the
requested brand before building.

## Downstream overlays

A private overlay can consume this repo as a git submodule, keep its own
`brands/<brand>.json` + icon + signing certificates, and run
`node <submodule>/branding/lib/apply-branding.mjs --brand-file brands/<brand>.json`
before building a signed/notarized DMG — without forking the base.
