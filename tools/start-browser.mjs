#!/usr/bin/env node
// start-browser.mjs — launch Brave or Chrome with --remote-debugging-port=9222
// so chrome-devtools-mcp + apply-*.mjs can attach to the user's real session.
//
// Usage:  node tools/start-browser.mjs   (or: npm run browser)
//
// Detection order: Brave → Chrome → Chromium → Edge. First one found wins.
// The browser opens with the user's existing profile (cookies, sessions, extensions).
// If a browser is already running on port 9222, this script no-ops.

import { existsSync } from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { platform, homedir } from 'node:os';

const PORT = 9222;
const PROFILE_DIR_OVERRIDE = process.env.CAREER_OPS_BROWSER_PROFILE; // optional

async function probePort() {
  try {
    const r = await fetch(`http://localhost:${PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

const macCandidates = [
  { name: 'Brave',    bin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',  defaultProfile: `${homedir()}/Library/Application Support/BraveSoftware/Brave-Browser` },
  { name: 'Chrome',   bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', defaultProfile: `${homedir()}/Library/Application Support/Google/Chrome` },
  { name: 'Chromium', bin: '/Applications/Chromium.app/Contents/MacOS/Chromium',           defaultProfile: `${homedir()}/Library/Application Support/Chromium` },
  { name: 'Edge',     bin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', defaultProfile: `${homedir()}/Library/Application Support/Microsoft Edge` },
];
const linuxCandidates = [
  { name: 'Brave',    bin: '/usr/bin/brave-browser',   defaultProfile: `${homedir()}/.config/BraveSoftware/Brave-Browser` },
  { name: 'Brave',    bin: '/snap/bin/brave',          defaultProfile: `${homedir()}/.config/BraveSoftware/Brave-Browser` },
  { name: 'Chrome',   bin: '/usr/bin/google-chrome',   defaultProfile: `${homedir()}/.config/google-chrome` },
  { name: 'Chromium', bin: '/usr/bin/chromium',        defaultProfile: `${homedir()}/.config/chromium` },
  { name: 'Chromium', bin: '/usr/bin/chromium-browser',defaultProfile: `${homedir()}/.config/chromium` },
];
const winCandidates = [
  { name: 'Brave',  bin: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',  defaultProfile: `${homedir()}\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data` },
  { name: 'Chrome', bin: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',              defaultProfile: `${homedir()}\\AppData\\Local\\Google\\Chrome\\User Data` },
  { name: 'Edge',   bin: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',       defaultProfile: `${homedir()}\\AppData\\Local\\Microsoft\\Edge\\User Data` },
];
const candidates = platform() === 'darwin' ? macCandidates : platform() === 'win32' ? winCandidates : linuxCandidates;

const existing = await probePort();
if (existing) {
  console.log(`✓ A browser is already attached on http://localhost:${PORT}`);
  console.log(`  ${existing.Browser || 'browser'}: ${existing.webSocketDebuggerUrl || ''}`);
  console.log('  No action needed — chrome-devtools-mcp + apply-*.mjs can connect.');
  process.exit(0);
}

const found = candidates.find(c => existsSync(c.bin));
if (!found) {
  console.error(`No supported browser found. Searched:`);
  for (const c of candidates) console.error(`  - ${c.bin}`);
  console.error(`\nInstall Brave (https://brave.com) or Chrome and rerun.`);
  process.exit(1);
}

const profile = PROFILE_DIR_OVERRIDE || found.defaultProfile;
const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`];
console.log(`Starting ${found.name} with debug port ${PORT}…`);
console.log(`  bin:     ${found.bin}`);
console.log(`  profile: ${profile}`);
console.log(`  flags:   ${args.join(' ')}`);

// Detach so the parent can exit; the browser keeps running.
const child = spawn(found.bin, args, { detached: true, stdio: 'ignore' });
child.unref();

// Verify it's actually serving CDP
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 500));
  const v = await probePort();
  if (v) {
    console.log(`\n✓ ${v.Browser || found.name} is now attached on http://localhost:${PORT}`);
    console.log(`  You can leave this browser running and use Claude Code normally.`);
    console.log(`  To stop: just close the browser window.`);
    process.exit(0);
  }
}
console.error(`\n⚠ Browser launched but port ${PORT} didn't respond within 10s.`);
console.error(`  Check that another instance with a different debug port isn't already running.`);
console.error(`  On macOS, fully quit Chrome/Brave from the Dock first, then rerun.`);
process.exit(2);
