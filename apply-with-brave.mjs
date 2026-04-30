#!/usr/bin/env node
// apply-with-brave.mjs — drive Playwright through your real Brave session.
//
// Three modes (in priority order — pick one):
//
//   1. --cdp                  ATTACH to a running Brave instance via Chrome
//                             DevTools Protocol on localhost:9222. Best UX:
//                             your real cookies + macOS keychain + extensions
//                             all work natively. Brave stays open the whole
//                             time. Requires you to launch Brave with
//                             --remote-debugging-port=9222 ONCE per session
//                             (helper command below).
//
//   2. --real-profile         LAUNCH Brave pointing at your actual profile dir
//                             (~/Library/Application Support/BraveSoftware/
//                             Brave-Browser). Brave must be FULLY QUIT first
//                             (SingletonLock blocks reuse). Real cookies +
//                             keychain + everything; modifies your real
//                             profile (history, downloads, etc.).
//
//   3. (default, --clean)     LAUNCH Brave with a SEPARATE Playwright-managed
//                             profile dir. Sites will require re-login the
//                             first time. Useful for clean-room test runs.
//
// Why CDP is the right default for real-world apply:
//   - macOS Chromium browsers encrypt cookie values with a key in your
//     keychain. Copy-cookies-across-profiles → garbage decryption → Indeed
//     sees no session. CDP attaches to the *running* Brave that has
//     keychain access already.
//   - You don't need to quit Brave; we open a new tab in your existing
//     window with full real session.
//
// Setup once (recommended):
//   1. Quit Brave fully (Cmd+Q).
//   2. Launch Brave from terminal:
//        open -na "Brave Browser" --args --remote-debugging-port=9222
//      (or alias this in your shell rc as `brave-debug`)
//   3. Use Brave normally; sign into Indeed/LinkedIn/etc. as usual.
//
// Then per-apply:
//   node apply-with-brave.mjs --cdp <url> --resume <pdf> --company "<Co>" --role "<Role>"
//
// What it does in --cdp mode:
//   1. dup-guard.mjs#assertNotAlreadyApplied — HARD ABORT on duplicate
//   2. chromium.connectOverCDP('http://localhost:9222') — attach
//   3. Open new tab, navigate to URL
//   4. If --resume given and ATS detected → run typed handler (Greenhouse
//      / Ashby / Lever) + screening-bank check
//   5. STOP before Submit (you click Submit yourself in Brave). Auto-submit
//      via --auto-submit only if you trust the run.
//   6. Leave the tab open; do NOT close the Brave window.

import { chromium } from 'playwright';
import { resolve, basename } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { detectAts } from './apply-runner.mjs';
import { fillGreenhouseStandardFields, screenGreenhouseQuestions } from './apply-greenhouse.mjs';
import { fillAshbyStandardFields } from './apply-ashby.mjs';
import { fillLeverStandardFields } from './apply-lever.mjs';
import { loadProfile } from './apply-shared.mjs';
import { assertNotAlreadyApplied } from './dup-guard.mjs';

const BRAVE_EXECUTABLE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const REAL_BRAVE_PROFILE = resolve(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser');
const PW_BRAVE_PROFILE = resolve(homedir(), 'Library/Application Support/career-ops-brave-profile');
const CDP_ENDPOINT = 'http://localhost:9222';

function parseArgs(argv) {
  const args = {
    url: null, resume: null, company: null, role: null,
    headless: false, autoSubmit: false,
    mode: 'clean', // 'cdp' | 'real-profile' | 'clean'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cdp') args.mode = 'cdp';
    else if (a === '--real-profile') args.mode = 'real-profile';
    else if (a === '--clean') args.mode = 'clean';
    else if (a === '--resume') args.resume = argv[++i];
    else if (a === '--company') args.company = argv[++i];
    else if (a === '--role') args.role = argv[++i];
    else if (a === '--headless') args.headless = true;
    else if (a === '--auto-submit') args.autoSubmit = true;
    else if (a.startsWith('http')) args.url = a;
  }
  if (!args.url) {
    console.error('Usage: node apply-with-brave.mjs [--cdp|--real-profile|--clean] <url> [--resume <pdf>] [--company "<Co>"] [--role "<Role>"] [--headless] [--auto-submit]');
    console.error('');
    console.error('Setup for --cdp mode (recommended):');
    console.error('  Quit Brave (Cmd+Q), then run:');
    console.error('    open -na "Brave Browser" --args --remote-debugging-port=9222');
    console.error('  Sign into Indeed/LinkedIn/etc. in that Brave window. Then re-run this script with --cdp.');
    process.exit(2);
  }
  return args;
}

async function getContext(args) {
  if (args.mode === 'cdp') {
    console.error(`[brave] attaching to running Brave via CDP at ${CDP_ENDPOINT}`);
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch (e) {
      console.error('❌ CDP attach failed. Is Brave running with --remote-debugging-port=9222?');
      console.error('   Setup:');
      console.error('     1. Quit Brave fully (Cmd+Q)');
      console.error('     2. open -na "Brave Browser" --args --remote-debugging-port=9222');
      console.error('     3. Sign in to relevant sites in that Brave window');
      console.error('     4. Re-run this script');
      console.error(`   Underlying error: ${e.message}`);
      process.exit(3);
    }
    // Use the FIRST existing context — that's the user's logged-in session.
    const ctx = browser.contexts()[0];
    if (!ctx) {
      console.error('❌ CDP attached but no contexts found. Open at least one tab in Brave first.');
      process.exit(3);
    }
    return { ctx, browser, isCdp: true };
  }

  if (args.mode === 'real-profile') {
    console.error(`[brave] launching Brave with REAL profile at ${REAL_BRAVE_PROFILE}`);
    console.error(`[brave] WARN: Brave must be fully quit first (Cmd+Q). If you see a SingletonLock error, quit Brave and re-run.`);
    const ctx = await chromium.launchPersistentContext(REAL_BRAVE_PROFILE, {
      executablePath: BRAVE_EXECUTABLE,
      headless: args.headless,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    return { ctx, browser: null, isCdp: false };
  }

  // clean mode (default fallback) — sites will need re-login the first time
  if (!existsSync(PW_BRAVE_PROFILE)) mkdirSync(PW_BRAVE_PROFILE, { recursive: true });
  console.error(`[brave] launching Brave with clean Playwright profile at ${PW_BRAVE_PROFILE}`);
  console.error(`[brave] NOTE: clean profile = no logged-in sessions. For Indeed/LinkedIn/etc. use --cdp or --real-profile instead.`);
  const ctx = await chromium.launchPersistentContext(PW_BRAVE_PROFILE, {
    executablePath: BRAVE_EXECUTABLE,
    headless: args.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  return { ctx, browser: null, isCdp: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── HARD GATE — dup-guard before any nav.
  if (args.company) {
    try {
      assertNotAlreadyApplied({ url: args.url, company: args.company, role: args.role });
    } catch (e) {
      if (e.code === 'E_ALREADY_APPLIED') {
        console.error('❌ DUP-GUARD: aborting — already applied.');
        console.error(`   ${e.message}`);
        process.exit(2);
      }
      throw e;
    }
  } else {
    console.error('[brave] WARN: --company not provided, dup-guard skipped. Pass --company "<Name>" for safety.');
  }

  const { ctx, browser, isCdp } = await getContext(args);

  // In CDP mode, open a NEW TAB in the user's existing Brave window.
  // In launch modes, reuse the empty default page.
  const page = isCdp ? await ctx.newPage() : (ctx.pages()[0] || await ctx.newPage());
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  console.error(`[brave] navigated to ${args.url}`);

  const ats = detectAts(args.url);
  console.error(`[brave] ATS detected: ${ats || 'none'}`);

  if (args.resume && ats) {
    const profile = loadProfile();
    const resumePath = resolve(args.resume);
    if (!existsSync(resumePath)) throw new Error(`resume not found: ${resumePath}`);
    console.error(`[brave] filling ${ats} form with ${basename(resumePath)}`);
    if (ats === 'greenhouse') await fillGreenhouseStandardFields(page, { resumePath, profile });
    else if (ats === 'ashby') await fillAshbyStandardFields(page, { resumePath, profile });
    else if (ats === 'lever') await fillLeverStandardFields(page, { resumePath, profile });
    if (ats === 'greenhouse') {
      const screen = await screenGreenhouseQuestions(page);
      if (screen.discard) {
        console.error(`❌ screening bank flagged a HARD-DISCARD question. NOT submitting.`);
        for (const f of screen.flags) console.error(`   - [${f.action}] ${f.question.slice(0, 100)}`);
      }
      if (screen.flags.some(f => f.action === 'fill_and_flag')) {
        console.error(`⚠ screening bank found "fill_and_flag" question(s) — review before clicking Submit:`);
        for (const f of screen.flags.filter(f => f.action === 'fill_and_flag')) {
          console.error(`   - ${f.question.slice(0, 100)}\n     answer: ${f.honest_answer}`);
        }
      }
    }
    console.error(`[brave] form filled. ${args.autoSubmit ? 'Auto-submit ON — clicking Submit now.' : 'Auto-submit OFF — review the form in Brave and click Submit yourself.'}`);
    if (args.autoSubmit) {
      const submitBtn = page.getByRole('button', { name: /submit application|submit/i });
      if (await submitBtn.count()) {
        await submitBtn.first().click();
        await page.waitForURL(/confirmation|thank-you|thanks/i, { timeout: 15000 }).catch(() => {});
        console.error(`[brave] post-submit URL: ${page.url()}`);
      }
    }
  } else if (args.resume && !ats) {
    console.error(`[brave] resume provided but URL is not Greenhouse/Ashby/Lever. Page is open for you to drive manually.`);
    console.error(`[brave] resume location: ${resolve(args.resume)}`);
  } else {
    console.error(`[brave] no resume / no ATS detected — page open for you to drive manually.`);
  }

  if (isCdp) {
    // Detach but leave the tab open in user's Brave.
    console.error(`[brave] CDP attach: tab left open in your Brave window. Detaching cleanly.`);
    await browser.close().catch(() => {}); // close = detach in CDP mode
  } else if (!args.headless) {
    console.error(`[brave] Brave window left open. Close it when done. (Ctrl+C this process to release the profile lock.)`);
    await new Promise(() => {}); // keep alive while user drives
  } else {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('[brave] fatal:', err.message);
  process.exit(1);
});
