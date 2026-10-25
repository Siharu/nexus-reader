# Nexus Reader

Single-page manga reader. Two modes on first launch: **Manga Crawler** (no account) and **MAL Client** (MyAnimeList login).

## Important: this repository contains two separate apps

- **Nexus Reader (existing app):** the files at the repository root, including `index.html`, `api/mal.js`, `vercel.json`, `manifest.json`, and `sw.js`. Deploy this app to **Vercel**.
- **Folio Night Edition (new separate app):** lives under `folio/` and is deployed via the root `render.yaml` Blueprint to Render. The Render Blueprint starts Folio only; it does not serve the Nexus Reader root build.

Do not deploy the existing Nexus Reader as a Render Static Site: its `/api/mal.js` proxy needs Vercel's serverless function support.

## Deploy Nexus Reader (the existing root app)

1. Open [Vercel](https://vercel.com/new) and import the existing GitHub repository `Siharu/nexus-reader`.
2. Keep **Root Directory** as `./`. Framework preset: **Other**. No build command is needed; do not set a separate output directory.
3. Deploy. Vercel serves the root `index.html` and deploys `api/mal.js` as the MAL API proxy using `vercel.json`.
4. Copy the exact production URL Vercel gives you, such as `https://your-project.vercel.app/`.

### MyAnimeList login for Nexus Reader

1. Open https://myanimelist.net/apiconfig and create an app. Choose **App Type: other** for the current PKCE client.
2. Set **App Redirect URL** to the exact deployed Nexus Reader URL, including the trailing slash (for example, `https://your-project.vercel.app/`). Do not use localhost for the live app.
3. Open Nexus Reader → MAL Client. Paste the **Client ID** once, then use **Sign in with MAL**. The app uses OAuth 2.0 PKCE and does not need you to put a client secret into the HTML.
4. Never commit tokens or secrets.

## Deploy Folio Night Edition (the separate app)

Use Render's **Blueprint** flow and select this repository. Do not select **Static Site**; that form asks for a built-assets directory and will not run Folio's Node crawler backend. Render reads `render.yaml`, reconstructs the Folio source from `folio/.folio-source/`, then starts the Node service.

Folio's own MyAnimeList OAuth callback still needs to be implemented before a production MAL redirect URL can be registered. For now, the existing Nexus Reader is the more complete deployment target for MAL login.

## Nexus Reader features

- MangaDex search, covers, chapter listings, chapter images, and reading progress.
- Official external chapter links and publisher/store links when chapters are not hosted by MangaDex.
- PWA install support using `manifest.json`, `sw.js`, and the included icons.
- Start-screen artwork can be customized in Settings.

## Making an APK

For the existing Nexus Reader, deploy the root app to Vercel first so the HTTPS URL and `/api/mal` proxy work. Then use [PWA Builder](https://www.pwabuilder.com/) to package the live URL as an Android Trusted Web Activity. Set the MAL redirect URL to the exact Vercel URL.
