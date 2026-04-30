---
description: Quick onboarding — opens a 7-field local form to collect profile data, then writes config/profile.yml + cv.md and copies all *.example.* templates. ~2 minutes.
allowed-tools: Bash(node tools/onboarding-server.mjs:*), Bash(open *), BashOutput
---

Start the onboarding flow for a new user.

## Steps

1. **Pre-flight.** Check the working directory has `tools/onboarding-server.mjs`. If not, the user is in the wrong directory — tell them and stop.

2. **Backup warning.** If `config/profile.yml` or `cv.md` already exist, tell the user briefly that the existing files will be backed up to `*.bak` before being overwritten. Ask if they want to proceed.

3. **Launch the server.** Use the Bash tool with `run_in_background: true` to run:
   ```
   node tools/onboarding-server.mjs
   ```
   The server listens on `http://localhost:7331` and auto-opens the browser. It exits automatically after the user submits the form once.

4. **Tell the user briefly:**
   > "Form open at http://localhost:7331 — fill it in (~2 min, 7 fields, paste your resume at the bottom), click **Save and start**. I'll wait."

5. **Wait.** Use BashOutput periodically (every ~15s) to check the background shell. The server prints `✅ wrote N files:` followed by the file list when the user submits, then exits cleanly. Don't poll faster than 15s — that wastes context.

6. **Confirm.** Once the server exits, summarize what got created from the file list it printed:
   - `config/profile.yml` — your personal data (gitignored)
   - `cv.md` — pasted resume (gitignored)
   - `modes/_profile.md`, `portals.yml`, `screening-questions.json`, `cv-do-not-claim.txt`, `.env` — copied from templates (all gitignored)

   Then tell them:
   > "You're set. Try pasting a job URL to evaluate it, or run `/career-ops scan` to discover new postings."

## Notes

- The form is intentionally short (7 fields). Don't push for more — the user can refine `modes/_profile.md` and `config/profile.yml` later.
- If the server fails to start (port in use, missing js-yaml, etc.), surface the exact error to the user and offer to debug.
- If the user closes the browser without submitting, the server stays up. Tell them to either re-open `http://localhost:7331` or kill the background shell.
