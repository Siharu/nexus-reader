# The 13th Night — Headless Bug Test

This kit runs a browser smoke test against the real Three.js game, plus static checks for the story progression rules and interaction-distance caps.

## Quick start

1. Extract this package so `13th_night.html`, `Media/`, `headless-test.js`, and `package.json` are in the same directory.
2. Install Node.js 22 or newer.
3. In that directory, run:

   ```sh
   npm install
   npx playwright install chromium
   npm test
   ```

The game currently imports Three.js from a CDN, so the full browser run needs an internet connection unless your build has been adapted to load Three.js locally. For static source checks that do not need a browser or npm packages, run `npm run test:static` (or `node headless-test.js --static-only`).

## What it checks

- Local images/audio referenced by the HTML exist.
- All 13 nights have fieldwork entries and core-objective checks.
- Interactions are capped to the expected close-range limits.
- A report cannot be filed before primary objectives and required fieldwork are complete.
- A night cannot transition before its report and all required work are complete.
- Chromium can open the title screen and create the renderer canvas.
- A fresh game can move through both handover pages and finish the opening sequence.
- Night 1 remains incomplete at the start: primary objectives and fieldwork are still pending and no report has been filed.
- The map and pause/resume controls work.
- The built-in HUD layout audit runs at desktop and mobile sizes.
- Browser exceptions and in-game runtime errors are collected.

## AI / CI artifacts

The runner writes `.test-results/headless-report.json` with machine-readable pass/fail results, browser console errors, uncaught exceptions, failed requests, local HTTP failures, and diagnostic snapshots. It also saves desktop/mobile gameplay screenshots and a failure screenshot when possible.

A GitHub Actions workflow is included at `.github/workflows/headless-test.yml`. Commit and push the kit into the game repository to run it on pushes, pull requests, or manually from the Actions tab.

## Test another HTML file

If the game file has another name or is in another folder:

```sh
GAME_HTML="/absolute/path/to/13th_night.html" npm test
```

The HTML and its sibling `Media/` folder must stay together. In a local environment with a system Chromium installation, you can optionally run:

```sh
HEADLESS_SYSTEM_CHROMIUM=1 npm test
```

`HEADLESS_NO_GAMEPLAY=1 npm test` skips the timed opening sequence; use it only for a faster startup smoke test, not as the full bug test.
