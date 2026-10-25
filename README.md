# Nexus Reader
Single-page manga reader. Two modes on first launch: **Manga Crawler** (no account) and **MAL Client** (MyAnimeList login).

## Deploy (needed for MAL login)
1. Push this folder to GitHub, import into Vercel (no build step). `api/mal.js` becomes the MAL proxy.
2. https://myanimelist.net/apiconfig -> Create ID. App Type: other. Redirect URL: your exact deployed URL (e.g. https://yourapp.vercel.app/).
3. Open the app -> MAL Client -> paste Client ID -> Sign in.

Crawler mode works by just opening index.html or hosting it anywhere.

## Sources
MangaDex API (chapters + covers). If a title has no hosted chapters it shows other languages, official external chapters (e.g. MANGA Plus) and official/store links.

## Making an APK
The app is a PWA (manifest.json, sw.js, icons included). Easiest route that keeps MAL login working:
1. Deploy the folder to Vercel (HTTPS URL).
2. Go to pwabuilder.com, enter the URL, choose Android -> download the package (a Trusted Web Activity). Install the .apk on your phone.
3. In your MAL API app settings, set the redirect URL to your exact Vercel URL.

Wrapping index.html alone in a local WebView (file:// or capacitor://) will break MAL login (no valid redirect) and the proxy path. Crawler mode may still work there if the source allows the requests.

## Start-screen artwork
No asset folder needed. Settings -> Start-screen artwork -> pick any image. It is resized and stored inside the app.
