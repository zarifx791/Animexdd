# Animexd — Render-ready starter

A Node.js/Express anime episode site with a public episode page and password-protected admin page.

## Important security note
This starter includes a temporary default admin password so it can boot without Render environment settings:

- Admin page: `/admin.html`
- Temporary password: `AnimeXD@2026`

**Make the GitHub repository PRIVATE before uploading these files**, because the temporary password is present in the source code. Change the password before sharing the website publicly. In Render, you can later add `ADMIN_PASSWORD` and `SESSION_SECRET` environment variables to override the defaults.

## Render settings
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

The server listens on `process.env.PORT` (Render supplies this automatically).

## Files
- `public/index.html` — public episode catalogue
- `public/admin.html` — admin panel
- `server.js` — web server and API
- `data/episodes.json` — episode metadata
- `uploads/` — uploaded videos

## Storage warning
Render's free service filesystem is ephemeral. Videos and episode metadata saved locally may be lost when the service restarts or redeploys. This is for testing; reliable public use needs persistent storage.

Only upload/distribute anime videos you own or have permission to distribute.
