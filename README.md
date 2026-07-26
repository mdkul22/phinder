# Phinder

A private, self-hosted companion for finding the Immich photos you love and
cleaning up the ones you do not—one photo at a time.
It uses Immich's official REST API only. It never reads photo folders, and it
never moves or duplicates originals. The optional Cleanup mode can move an
asset to Immich trash; it never empties trash or force-deletes assets.

## Features

- Source: photos uploaded today (using the browser's local-day boundary), all
  photos, favorites, or one album.
- Random shuffle is the default project order; newest-first remains available.
- A custom inclusive capture-date range can be used as a source.
- Geographic filtering uses an interactive flat world map with a selectable
  center and radius, including mouse, touch, wheel, and pinch controls.
- The Pune wedding can be selected directly by its verified December 13, 2025
  capture window and Pune location, independent of upload date or filename.
- Target: choose an Immich album or create one.
- Keep adds the existing asset to the target album.
- Skip persists a project-only rejection in local SQLite.
- Undo reverses the latest decision.
- Left/right arrows, Ctrl/Cmd+Z, and left/right swipes are supported.
- Your Picks opens a review gallery.
- Random Cleanup reviews the whole library and sends unwanted photos to Immich
  trash, with an undo action that restores the latest photo.

The API key is read only by `server.mjs` from the process environment. Browser
requests go to the app server, which proxies the minimum Immich calls. The key
is never embedded in browser files or returned by an endpoint.

## Dedicated Immich key

Create the key in **Immich → User Settings → API Keys**. Do not paste it into
chat or commit it. For a scoped key, grant the narrowest equivalents of:

- `asset.read`, `asset.view`
- `asset.delete` (required only for Cleanup and its undo/restore action)
- `album.read`, `album.create`
- `albumAsset.create`, `albumAsset.delete`
- `server.versionCheck` (optional connection check)

## WSL setup

Requires Node.js 22.13+; Node 24 LTS is recommended.

1. Copy `.env.example` to `.env`.
2. Edit only these two lines in `.env`:

   ```bash
   IMMICH_BASE_URL=http://127.0.0.1:2283
   IMMICH_API_KEY=your-dedicated-key
   ```

   If Immich is not in the same WSL environment, use its Tailnet-reachable or
   WSL-reachable base URL instead. Do not add a trailing `/api`.
3. Run `npm start`.

The server loads `.env` directly. The file is excluded from version control and
from the packaged deliverable. Do not paste its contents into chat.

Check `node --version` before starting. If it is below `v22.13.0`, install
Node.js 24 LTS in the same WSL shell where you run `npm start`. The app uses
Node's built-in SQLite driver and cannot run on legacy Node releases.

The local database is `data/triage.sqlite`. Preserve `data/` to keep decisions.

Docker is also supported; it reads the same `.env`:

```bash
docker compose up -d --build
```

The Compose configuration publishes only to WSL loopback.

## Tailnet-only exposure

On the machine running Tailscale:

```bash
tailscale serve --bg http://127.0.0.1:4173
```

Use the HTTPS URL Tailscale prints. `tailscale serve` is Tailnet-only. Do not
use `tailscale funnel`, which makes a service public.

If Tailscale runs on Windows while the app runs in WSL, first verify
`http://127.0.0.1:4173/healthz` from Windows. If WSL loopback forwarding is not
working, start with `HOST=0.0.0.0`, get the WSL address using
`wsl hostname -I`, and serve `http://<WSL-IP>:4173`. Do not create a public
Windows Firewall rule.

Stop exposure with:

```bash
tailscale serve reset
```

## Immich compatibility

The app uses the current stable REST routes for albums, album assets, metadata
and random search, server version, asset thumbnails, trash, and restore.
Immich evolves quickly, so repeat the live connection check after upgrades.
The included test suite validates browser-secret isolation and the primary
curation, map, PWA, and cleanup controls.

## Safety

- Back up `data/triage.sqlite` while the app is stopped.
- Target albums contain references to existing Immich assets, not copies.
- Pass changes only the local SQLite database.
- Undo of Keep removes album membership only; it does not delete the asset.
- Cleanup uses Immich's stable asset-delete endpoint with `force: false`, so
  unwanted photos go to Immich trash. Undo restores the latest trashed asset.
  Permanent trash emptying remains exclusively in Immich.
