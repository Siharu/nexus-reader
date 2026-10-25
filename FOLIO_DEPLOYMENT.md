# Folio Night Edition deployment

Folio is included as a separate app inside this repository. The original Nexus Reader files at the repository root are preserved.

## Deploy Folio

1. In Render, choose **New + → Blueprint** and connect this repository.
2. Render will read the root `render.yaml`, reconstruct Folio from the committed archive parts, install it, and start the Node service.
3. Use the resulting Render HTTPS domain as the app homepage after deployment.

GitHub Pages cannot run Folio's Node.js crawler/API backend. The Render Blueprint is configured to deploy the full app.

## MyAnimeList OAuth

Folio currently has no completed OAuth authorization callback. Do not register a guessed callback URL in MyAnimeList yet. First implement the callback route and secure token exchange, then register the exact HTTPS callback URL assigned by the deployed app. Never commit the MyAnimeList client secret or access tokens.
