#!/usr/bin/env node
'use strict';

/*
 * The 13th Night — headless bug-test runner
 *
 * Run:
 *   npm install
 *   npx playwright install chromium
 *   npm test
 *
 * Optional:
 *   GAME_HTML=/path/to/13th_night.html npm test
 *   HEADLESS_SYSTEM_CHROMIUM=1 npm test   # use /usr/bin/chromium when present
 *   HEADLESS_NO_GAMEPLAY=1 npm test        # static + browser startup smoke only
 *
 * This intentionally produces machine-readable JSON and screenshots so an AI or CI job
 * can inspect both the result and the failing screen instead of relying on terminal text.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');

const CWD = process.cwd();
const OUT_DIR = path.resolve(process.env.HEADLESS_OUT_DIR || path.join(CWD, '.test-results'));
const NO_GAMEPLAY = /^(1|true|yes)$/i.test(process.env.HEADLESS_NO_GAMEPLAY || '');
const STATIC_ONLY = process.argv.includes('--static-only') || /^(1|true|yes)$/i.test(process.env.HEADLESS_STATIC_ONLY || '');
const checks = [];
const warnings = [];
const failures = [];
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const httpErrors = [];
let browser;
let server;
let page;
let gamePath;
let serverOrigin;

function record(name, status, details = '') {
  const item = { name, status, details };
  checks.push(item);
  const tag = status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : 'FAIL';
  console.log(`[${tag}] ${name}${details ? ` — ${typeof details === 'string' ? details : JSON.stringify(details)}` : ''}`);
  if (status === 'FAIL') failures.push(item);
  if (status === 'WARN') warnings.push(item);
  return item;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveGameHtml() {
  const candidates = [];
  if (process.env.GAME_HTML) candidates.push(path.resolve(process.env.GAME_HTML));
  candidates.push(
    path.join(CWD, '13th_night.html'),
    path.join(CWD, 'The_13th_Night_Interaction_Fix.html'),
    path.join(CWD, 'The_13th_Night_Updated.html'),
    path.join(CWD, 'index.html'),
    path.join(CWD, 'The_13th_Night_Headless_Test_Kit', '13th_night.html')
  );
  const found = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) {
    throw new Error(
      'Could not find the game HTML. Put 13th_night.html beside this script, or set GAME_HTML=/absolute/path/to/game.html.'
    );
  }
  return found;
}

function runStaticChecks(html, htmlPath) {
  const basename = path.basename(htmlPath);
  record('Game HTML found', 'PASS', `${basename} (${Math.round(Buffer.byteLength(html) / 1024)} KiB)`);

  const requiredIds = [
    'titleScreen', 'newGameBtn', 'continueBtn', 'settingsBtn', 'hud', 'chapterLabel',
    'objective', 'roomName', 'hint', 'interactBtn', 'pauseBtn', 'mapBtn',
    'openingReadingMode', 'openingReadNext', 'nightCardScreen', 'nightCardContinueBtn',
    'noteScreen', 'puzzleScreen', 'endingScreen', 'hudDebug'
  ];
  const missingIds = requiredIds.filter(id => !new RegExp(`\\bid=["']${id}["']`).test(html));
  record('Required game controls exist in HTML', missingIds.length ? 'FAIL' : 'PASS',
    missingIds.length ? `Missing: ${missingIds.join(', ')}` : `${requiredIds.length} required IDs present`);

  const localRefs = [];
  // Collect direct HTML references plus string literals used by CSS/JavaScript (for example audio paths).
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) localRefs.push(match[2].trim());
  for (const match of html.matchAll(/(["'`])(Media\/[A-Za-z0-9_./-]+)\1/g)) localRefs.push(match[2]);
  const normalizedMediaRefs = localRefs.flatMap(ref => {
    if (!ref || /^(?:https?:|data:|blob:|#|javascript:)/i.test(ref)) return [];
    const clean = decodeURIComponent(ref.split(/[?#]/, 1)[0]).replace(/^\.\//, '');
    return clean.startsWith('Media/') ? [clean] : [];
  });
  const missingAssets = [...new Set(normalizedMediaRefs)].filter(ref => !fs.existsSync(path.join(path.dirname(htmlPath), ref)));
  record('Referenced local Media assets exist', missingAssets.length ? 'FAIL' : 'PASS',
    missingAssets.length ? `Missing: ${missingAssets.join(', ')}` : `${new Set(normalizedMediaRefs).size} local media paths checked`);

  const fieldworkStart = html.indexOf('const NIGHT_FIELDWORK={');
  const fieldworkEnd = html.indexOf('const NIGHT_FIELDWORK_FLAT=', fieldworkStart);
  const fieldworkText = fieldworkStart >= 0 && fieldworkEnd > fieldworkStart ? html.slice(fieldworkStart, fieldworkEnd) : '';
  const fieldworkNights = [...fieldworkText.matchAll(/^\s*(\d+)\s*:\s*\[/gm)].map(m => Number(m[1]));
  const missingNights = Array.from({ length: 13 }, (_, i) => i + 1).filter(n => !fieldworkNights.includes(n));
  record('Fieldwork exists for all 13 nights', missingNights.length ? 'FAIL' : 'PASS',
    missingNights.length ? `Missing nights: ${missingNights.join(', ')}` : `${fieldworkNights.length} night sections found`);
  const fieldworkCounts = {};
  const fieldworkEntries = [...fieldworkText.matchAll(/^\s*(\d+)\s*:\s*\[/gm)];
  for (let i = 0; i < fieldworkEntries.length; i++) {
    const entry = fieldworkEntries[i];
    const start = entry.index;
    const end = i + 1 < fieldworkEntries.length ? fieldworkEntries[i + 1].index : fieldworkText.length;
    fieldworkCounts[Number(entry[1])] = (fieldworkText.slice(start, end).match(/storyTask\(/g) || []).length;
  }
  const shortNights = Array.from({ length: 13 }, (_, i) => i + 1).filter(n => (fieldworkCounts[n] || 0) < 5);
  record('Each night has at least five exploration tasks', shortNights.length ? 'FAIL' : 'PASS',
    shortNights.length ? `Too few tasks: ${shortNights.map(n => `Night ${n} (${fieldworkCounts[n] || 0})`).join(', ')}` : fieldworkCounts);

  const coreStart = html.indexOf('function storyNightCoreChecks(');
  const coreEnd = html.indexOf('function storyNightCoreMissing(', coreStart);
  const coreText = coreStart >= 0 && coreEnd > coreStart ? html.slice(coreStart, coreEnd) : '';
  const coreNights = [...coreText.matchAll(/case\s+(\d+)\s*:/g)].map(m => Number(m[1]));
  const missingCoreNights = Array.from({ length: 13 }, (_, i) => i + 1).filter(n => !coreNights.includes(n));
  record('Core objectives exist for all 13 nights', missingCoreNights.length ? 'FAIL' : 'PASS',
    missingCoreNights.length ? `Missing nights: ${missingCoreNights.join(', ')}` : `${coreNights.length} night cases found`);

  const rangeStart = html.indexOf('function interactionRange(h)');
  const rangeEnd = html.indexOf('function nearestTarget()', rangeStart);
  const rangeText = rangeStart >= 0 && rangeEnd > rangeStart ? html.slice(rangeStart, rangeEnd) : '';
  const expectedCaps = { door: 1.55, puzzle: 1.40, console: 1.35, hide: 1.30 };
  const parsedCaps = {};
  const capMatch = rangeText.match(/const\s+closeRange\s*=\s*\{([^}]+)\}/);
  if (capMatch) {
    for (const part of capMatch[1].split(',')) {
      const pair = part.trim().match(/([\w]+)\s*:\s*([\d.]+)/);
      if (pair) parsedCaps[pair[1]] = Number(pair[2]);
    }
  }
  const rangeProblems = [];
  if (!rangeText.includes('Math.min(Number.isFinite(h.radius)?h.radius:cap,cap)')) {
    rangeProblems.push('interactionRange does not cap authored hotspot radius');
  }
  for (const [type, value] of Object.entries(expectedCaps)) {
    if (parsedCaps[type] !== value) rangeProblems.push(`${type} cap expected ${value}, got ${parsedCaps[type] ?? 'missing'}`);
  }
  if (!rangeText.includes('const cap=closeRange[h.type]??1.25')) rangeProblems.push('default item cap should be 1.25 units');
  record('Interaction distance caps are present', rangeProblems.length ? 'FAIL' : 'PASS',
    rangeProblems.length ? rangeProblems.join('; ') : parsedCaps);

  const reportStart = html.indexOf('function submitNightReport(){');
  const reportEnd = html.indexOf('\nfunction refreshNightStoryItems(', reportStart);
  const reportText = reportStart >= 0 && reportEnd > reportStart ? html.slice(reportStart, reportEnd) : '';
  const assignmentAt = reportText.indexOf("game.visits['nightReport'+n]=true");
  const coreGuardAt = reportText.indexOf('if(coreMissing.length)');
  const fieldworkGuardAt = reportText.indexOf('if(pending.length)');
  const reportGatingOkay = assignmentAt > -1 && coreGuardAt > -1 && fieldworkGuardAt > -1 &&
    coreGuardAt < assignmentAt && fieldworkGuardAt < assignmentAt &&
    reportText.includes('if(coreMissing.length){showToast(') && reportText.includes('if(pending.length){showToast(');
  record('Shift reports are gated by core objectives and fieldwork', reportGatingOkay ? 'PASS' : 'FAIL',
    reportGatingOkay ? 'Report cannot be filed until both checks pass' : 'Report guards missing or occur after the filed flag');

  const progressStart = html.indexOf('function evaluateStoryNightProgress(){');
  const progressEnd = html.indexOf('\nfunction updateNightWatcher(', progressStart);
  const progressText = progressStart >= 0 && progressEnd > progressStart ? html.slice(progressStart, progressEnd) : '';
  const progressGatingOkay = progressText.includes("game.visits?.['nightReport'+n]") &&
    progressText.includes('storyNightCoreMissing(n).length===0') &&
    progressText.includes('storyNightPendingTasks(n).length===0');
  record('Night transition requires report + all objectives + all fieldwork', progressGatingOkay ? 'PASS' : 'FAIL',
    progressGatingOkay ? 'Transition gate contains all three prerequisites' : 'Night transition prerequisite missing');

  const diagnostics = [
    'window.__the13thNightStoryDiagnostics',
    'window.__midnightOpeningDiagnostics',
    'window.__midnightHudAudit',
    'window.__midnightHudTest'
  ];
  const missingDiagnostics = diagnostics.filter(name => !html.includes(name));
  record('AI-readable diagnostics hooks exist', missingDiagnostics.length ? 'FAIL' : 'PASS',
    missingDiagnostics.length ? `Missing: ${missingDiagnostics.join(', ')}` : diagnostics.join(', '));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8'
  })[ext] || 'application/octet-stream';
}

async function startStaticServer(rootDir, entryHtml) {
  const root = path.resolve(rootDir);
  const entryName = path.basename(entryHtml);
  server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let requestedPath = decodeURIComponent(url.pathname);
      if (requestedPath === '/') requestedPath = `/${entryName}`;
      const resolved = path.resolve(root, `.${requestedPath}`);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      fs.stat(resolved, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Not found: ${requestedPath}`);
          return;
        }
        res.writeHead(200, {
          'Content-Type': contentType(resolved),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        fs.createReadStream(resolved).pipe(res);
      });
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Bad request: ${error.message}`);
    }
  });
  const listenHost = process.env.HEADLESS_HOST || '127.0.0.1';
  server.listen(0, listenHost);
  await once(server, 'listening');
  const addr = server.address();
  const connectHost = process.env.HEADLESS_CONNECT_HOST || (listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost);
  serverOrigin = `http://${connectHost}:${addr.port}`;
  return `${serverOrigin}/${encodeURIComponent(entryName)}`;
}

async function maybeRunBrowserChecks(htmlUrl) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (error) {
    throw new Error('Playwright is not installed. Run `npm install` and `npx playwright install chromium`, then rerun `npm test`.');
  }
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=Vulkan'
    ]
  };
  const systemChromium = process.env.CHROMIUM_PATH || (process.env.HEADLESS_SYSTEM_CHROMIUM === '1' && fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null);
  if (systemChromium) launchOptions.executablePath = systemChromium;
  browser = await playwright.chromium.launch(launchOptions);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block'
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push({ text: msg.text(), location: msg.location() });
  });
  page.on('pageerror', error => pageErrors.push({ message: error.message, stack: error.stack || '' }));
  page.on('requestfailed', request => {
    failedRequests.push({ url: request.url(), failure: request.failure()?.errorText || 'unknown' });
  });
  page.on('response', response => {
    if (response.url().startsWith(serverOrigin) && response.status() >= 400) {
      httpErrors.push({ status: response.status(), url: response.url() });
    }
  });

  let testUrl = `${htmlUrl}?compat=mobile&device=pc&debugHUD=1&headlessTest=1`;
  try {
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (navigationError) {
    // Some managed environments block loopback HTTP URLs even for a server created by this test.
    // In that case, retry the same local build with file:// so startup diagnostics can still run.
    if (!/ERR_BLOCKED_BY_ADMINISTRATOR|blocked by administrator/i.test(String(navigationError.message || navigationError))) throw navigationError;
    record('Loopback HTTP navigation', 'WARN', 'Environment blocked localhost; retrying the game from its local file URL.');
    testUrl = `${pathToFileURL(gamePath).href}?compat=mobile&device=pc&debugHUD=1&headlessTest=1`;
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  // Skip the two studio cards deterministically; the actual title UI and game boot remain real.
  await page.waitForSelector('#splashLogo', { state: 'attached', timeout: 10000 });
  await page.evaluate(() => document.getElementById('splashLogo')?.click());
  await page.waitForFunction(() => {
    const title = document.getElementById('titleScreen');
    return !!document.getElementById('startupErrorDetail') || (!!document.getElementById('newGameBtn') && title && !title.hidden);
  }, null, { timeout: 45000 });

  const startupFailure = await page.locator('#startupErrorDetail').count();
  if (startupFailure) {
    const report = await page.locator('#startupErrorDetail').inputValue().catch(() => 'Startup screen appeared without readable diagnostic text.');
    throw new Error(`The game displayed its startup-failure screen:\n${report}`);
  }
  const titleInfo = await page.evaluate(() => ({
    titleVisible: !document.getElementById('titleScreen').hidden,
    newGameText: document.getElementById('newGameBtn')?.innerText?.trim(),
    rendererCanvas: !!document.querySelector('#game > canvas'),
    canvasWidth: document.querySelector('#game > canvas')?.width || 0,
    canvasHeight: document.querySelector('#game > canvas')?.height || 0,
    threeRevision: window.THREE?.REVISION || null
  }));
  assert(titleInfo.titleVisible && titleInfo.newGameText, 'Title screen or New Game control did not appear');
  assert(titleInfo.rendererCanvas && titleInfo.canvasWidth > 0 && titleInfo.canvasHeight > 0, 'Three.js renderer canvas is missing or has zero size');
  record('Headless browser starts the title screen and renderer', 'PASS', titleInfo);

  if (NO_GAMEPLAY) {
    record('Interactive gameplay sequence', 'WARN', 'Skipped because HEADLESS_NO_GAMEPLAY=1');
    return;
  }

  await page.locator('#newGameBtn').click();
  // Night 1 opening: wake, then a free-roam Reception routine. Completing it (not a timer) triggers the blackout.
  const diag = () => page.evaluate(() => window.__midnightOpeningDiagnostics());
  await page.waitForFunction(() => window.__midnightOpeningDiagnostics?.().stage === 'free', null, { timeout: 30000 });
  assert((await diag()).powerCut === false, 'Power must still be on when the player first takes control');
  await page.waitForTimeout(3000);
  assert((await diag()).stage === 'free' && (await diag()).active, 'Opening must wait for the player, not a timer');
  const useTarget = async (x, z, id) => {
    await page.evaluate(([x, z]) => window.__midnightOpeningTest.teleport(x, z), [x, z]);
    await page.waitForFunction(id => window.__midnightOpeningTest.target() === id, id, { timeout: 5000 });
    await page.keyboard.press('KeyE');
  };
  await useTarget(0.40, 3.2, 'openingCheckin');
  await page.waitForTimeout(300);
  assert((await diag()).stage === 'free', 'Check-in must not complete the routine early');
  await useTarget(-0.30, 3.2, 'openingHandover');
  await page.waitForFunction(() => document.getElementById('openingReadingMode')?.getAttribute('data-page') === '1' && !document.getElementById('openingReadingMode').hidden, null, { timeout: 5000 });
  await page.waitForTimeout(2500);
  assert(await page.locator('#openingReadingMode').getAttribute('data-page') === '1', 'Handover must not auto-turn');
  await page.locator('#openingReadNext').click();
  await page.waitForFunction(() => document.getElementById('openingReadingMode')?.getAttribute('data-page') === '2', null, { timeout: 5000 });
  await page.locator('#openingReadNext').click();
  await page.waitForFunction(() => window.__midnightOpeningDiagnostics().tasks.report === true && window.__midnightOpeningDiagnostics().stage === 'free', null, { timeout: 5000 });
  await useTarget(-3.4, 3.0, 'openingRadio');
  await useTarget(-3.0, -1.5, 'openingClock');
  await page.waitForFunction(() => window.__midnightOpeningDiagnostics().tasks.clock === true && window.__midnightOpeningDiagnostics().tasks.radio === true, null, { timeout: 20000 });
  assert((await diag()).active && !(await diag()).powerCut, 'Power must stay on until the check-in is filed');
  await useTarget(0.40, 3.2, 'openingCheckin');
  await page.waitForFunction(() => window.__midnightOpeningDiagnostics().stage === 'finale', null, { timeout: 5000 });
  await page.waitForFunction(() => !window.__midnightOpeningDiagnostics().active, null, { timeout: 120000 });
  record('New Game: free-roam Reception routine, check-in, 13th feed, knocks, then power cut', 'PASS', await diag());

  const story = await page.evaluate(() => typeof window.__the13thNightStoryDiagnostics === 'function' ? window.__the13thNightStoryDiagnostics() : null);
  assert(story && story.night === 1, `Fresh game should begin Night 1; got ${JSON.stringify(story)}`);
  assert(story.reportFiled === false, 'A fresh Night 1 should not already have a filed report');
  assert(Array.isArray(story.coreMissing) && story.coreMissing.length >= 3, `Night 1 should still require its core objectives, got ${JSON.stringify(story.coreMissing)}`);
  assert(story.fieldwork && story.fieldwork.total >= 5 && story.fieldwork.done === 0, `Night 1 should require multiple fieldwork discoveries, got ${JSON.stringify(story.fieldwork)}`);
  assert(story.transitionPending === false, 'Night 1 must not transition automatically at the start');
  record('Night 1 starts with required work still outstanding', 'PASS', {
    night: story.night, coreObjectivesRemaining: story.coreMissing.length,
    fieldwork: story.fieldwork, reportFiled: story.reportFiled, transitionPending: story.transitionPending
  });

  const desktopAudit = await page.evaluate(() => window.__midnightHudAudit?.() || null);
  assert(desktopAudit, 'HUD diagnostic hook was not exposed in the browser');
  if (desktopAudit.issues?.length) {
    record('Desktop HUD layout audit', 'FAIL', { result: desktopAudit.result, issues: desktopAudit.issues, warnings: desktopAudit.warnings });
  } else {
    record('Desktop HUD layout audit', 'PASS', { result: desktopAudit.result, warnings: desktopAudit.warnings });
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'desktop-gameplay.png'), fullPage: true, animations: 'disabled' }).catch(() => {});

  // Smoke-test interactions that should be safe without walking the whole story.
  await page.locator('#mapBtn').click();
  const mapOpened = await page.locator('#mapPanel').evaluate(el => !el.hidden);
  assert(mapOpened, 'Map button failed to open the map panel');
  await page.locator('#mapCloseBtn').click();
  const mapClosed = await page.locator('#mapPanel').evaluate(el => el.hidden);
  assert(mapClosed, 'Map close button failed to close the map panel');
  record('Map open/close control works', 'PASS');

  await page.locator('#pauseBtn').click();
  const pauseOpened = await page.locator('#pauseScreen').evaluate(el => !el.hidden);
  assert(pauseOpened, 'Pause button failed to open the pause menu');
  await page.locator('#resumeBtn').click();
  await page.waitForFunction(() => document.getElementById('pauseScreen')?.hidden === true, null, { timeout: 3000 });
  record('Pause and resume controls work', 'PASS');

  // Re-run the in-game HUD audit at a common phone viewport to catch clipping/overlaps.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.body.classList.remove('pc-mode'); document.body.classList.add('touch-mode'); });
  await page.waitForTimeout(250);
  const mobileAudit = await page.evaluate(() => window.__midnightHudAudit?.() || null);
  assert(mobileAudit, 'HUD diagnostic hook disappeared at mobile viewport');
  if (mobileAudit.issues?.length) {
    record('Mobile HUD layout audit (390×844)', 'FAIL', { result: mobileAudit.result, issues: mobileAudit.issues, warnings: mobileAudit.warnings });
  } else {
    record('Mobile HUD layout audit (390×844)', 'PASS', { result: mobileAudit.result, warnings: mobileAudit.warnings });
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'mobile-gameplay.png'), fullPage: true, animations: 'disabled' }).catch(() => {});

  const liveErrors = await page.evaluate(() => window.__midnightHudLastReport?.runtimeErrors || []);
  assert(pageErrors.length === 0, `Uncaught browser errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
  assert(liveErrors.length === 0, `Game HUD diagnostics recorded runtime errors: ${JSON.stringify(liveErrors.slice(0, 5))}`);
  record('No uncaught JavaScript errors during smoke test', 'PASS', 'No pageerror events or in-game runtime errors observed');

  const criticalHttpErrors = httpErrors.filter(e => !/favicon\.ico(?:$|\?)/i.test(e.url));
  assert(criticalHttpErrors.length === 0, `Local game assets returned HTTP errors: ${JSON.stringify(criticalHttpErrors)}`);
  record('No local game assets return HTTP errors', 'PASS');

  if (consoleErrors.length) {
    // A successful fallback CDN import can emit an error for the first attempted source;
    // preserve those for the AI report, but fail on the common Three.js/application errors.
    const serious = consoleErrors.filter(e => /uncaught|three\.js|webglrenderer|failed to load|typeerror|referenceerror|syntaxerror|startup failure/i.test(e.text));
    if (serious.length) record('Browser console error audit', 'FAIL', serious.slice(0, 8));
    else record('Browser console error audit', 'WARN', consoleErrors.slice(0, 8));
  } else {
    record('Browser console error audit', 'PASS', 'No console.error messages');
  }
}

async function writeFinalReport(fatalError) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const result = failures.length || fatalError ? 'FAIL' : warnings.length ? 'WARN' : 'PASS';
  const report = {
    schemaVersion: 1,
    suite: 'The 13th Night headless bug test',
    result,
    startedAt: startTime,
    finishedAt: new Date().toISOString(),
    gameHtml: gamePath || null,
    url: serverOrigin || null,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      headless: true,
      noGameplay: NO_GAMEPLAY,
      userAgent: await page?.evaluate(() => navigator.userAgent).catch(() => null) || null
    },
    summary: { passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length, warnings: checks.filter(c => c.status === 'WARN').length },
    checks,
    warnings,
    failures,
    fatalError: fatalError ? { message: fatalError.message, stack: fatalError.stack || '' } : null,
    browserConsoleErrors: consoleErrors,
    uncaughtPageErrors: pageErrors,
    failedRequests,
    localHttpErrors: httpErrors,
    artifacts: ['headless-report.json', 'desktop-gameplay.png', 'mobile-gameplay.png', 'failure.png'].filter(name => fs.existsSync(path.join(OUT_DIR, name)))
  };
  fs.writeFileSync(path.join(OUT_DIR, 'headless-report.json'), JSON.stringify(report, null, 2));
  return report;
}

const startTime = new Date().toISOString();
(async () => {
  let fatalError = null;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    gamePath = resolveGameHtml();
    const html = fs.readFileSync(gamePath, 'utf8');
    runStaticChecks(html, gamePath);
    if (STATIC_ONLY) {
      record('Browser runtime tests', 'WARN', 'Skipped because HEADLESS_STATIC_ONLY=1');
    } else {
      const url = await startStaticServer(path.dirname(gamePath), gamePath);
      await maybeRunBrowserChecks(url);
    }
  } catch (error) {
    fatalError = error;
    console.error('\n[FAIL] Headless test run stopped:', error.stack || error.message || String(error));
    if (page) {
      await page.screenshot({ path: path.join(OUT_DIR, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
      const diagnostics = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        titleScreenVisible: !!document.getElementById('titleScreen') && !document.getElementById('titleScreen').hidden,
        startupError: document.getElementById('startupErrorDetail')?.value || null,
        opening: window.__midnightOpeningDiagnostics?.() || null,
        story: window.__the13thNightStoryDiagnostics?.() || null,
        hud: window.__midnightHudAudit?.() || null,
        bodyText: (document.body?.innerText || '').slice(0, 6000)
      })).catch(e => ({ diagnosticsError: e.message }));
      record('Failure diagnostic snapshot captured', 'WARN', diagnostics);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve)).catch(() => {});
    const report = await writeFinalReport(fatalError);
    console.log(`\nResult: ${report.result} | Passed ${report.summary.passed} | Failed ${report.summary.failed} | Warnings ${report.summary.warnings}`);
    console.log(`Machine-readable report: ${path.join(OUT_DIR, 'headless-report.json')}`);
    if (fatalError || failures.length) process.exitCode = 1;
  }
})();
