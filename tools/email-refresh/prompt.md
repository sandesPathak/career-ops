You are running in headless mode. Your only task is to refresh the email cache used by the career-ops UI by searching the user's Gmail.

Follow these steps exactly. Do not ask any clarifying questions. Do not modify other files.

## Step 1 — Read the cache target path

The cache file path is given in the env var `CACHE_FILE`. If unset, default to `$HOME/Library/Application Support/career-ops-refresh/emails-cache.json` (macOS) or `$XDG_CACHE_HOME/career-ops-refresh/emails-cache.json` (Linux). You will overwrite this file in the final step.

## Step 2 — Search Gmail (use mcp__claude_ai_Gmail__search_threads)

Capture-everything is the goal. Run **all four** searches below with `pageSize: 50` each. Page through results until empty or pageToken is missing. Then merge threads and deduplicate by `threadId`.

1. **ATS-sender net** — `from:(greenhouse-mail.io OR ashbyhq.com OR hire.lever.co OR myworkday.com OR workable.com OR rippling.com OR jobvite.com OR icims.com OR breezyhr.com OR smartrecruiters.com OR teamtailor.com OR bamboohr.com) newer_than:180d`
2. **Application-lifecycle subjects** — `subject:(interview OR "next steps" OR screen OR schedule OR offer OR "thank you for applying" OR "your application" OR "application received" OR "applying to") newer_than:180d`
3. **Rejection-language subjects** — `subject:("update on your application" OR "regarding your application" OR "thank you for your interest" OR "following up" OR "status update" OR "an update" OR "decision regarding" OR "no longer being considered" OR "wasn't selected") newer_than:180d`
4. **Rejection-language bodies** — `("we have decided" OR "we've decided" OR "moving forward with other candidates" OR "won't be moving forward" OR "decided not to move forward" OR "decided to pursue other candidates" OR "no longer being considered" OR "unfortunately we") newer_than:180d`

Pull-broad, classify-strict. Subject-only signals like "thank you for your interest" are NOT enough to call something a rejection — Step 5 reads the full body to decide.

## Step 3 — Fetch full body for each thread

For each unique thread, call `mcp__claude_ai_Gmail__get_thread` with `threadId` and `messageFormat: "FULL_CONTENT"`. Take the first message of the returned thread.

Extract the message body as plain text:
- If the message has a plain-text part, use it directly.
- Otherwise, take the HTML part and strip tags: remove `<style>...</style>` and `<script>...</script>` blocks first, then strip remaining HTML tags, decode common HTML entities (`&amp;` → `&`, `&lt;` → `<`, `&gt;` → `>`, `&quot;` → `"`, `&#39;` → `'`, `&nbsp;` → space), collapse runs of whitespace, and trim leading/trailing whitespace.
- If neither is available, use the snippet as the body.

Trim the resulting body to 4000 characters max. Append `… [truncated]` if you trimmed.

## Step 4 — Load tracker for company cross-reference

Read `data/applications.md` if it exists. Extract the **Company** column from every table row (any status). Build a list of known company names — these are the canonical labels you should prefer when matching, since they're what the UI displays. If the file is missing or empty, this list is empty; that's fine.

## Step 5 — Classify each thread (you, Claude, decide — do not regex)

For each thread, read the full body + subject + sender and decide which intent best describes it. Use natural-language reasoning, not keyword matching. Output one of these values:

- **`applied-ack`** — company confirmed receipt of an application. Almost always positive/neutral tone. Examples: "Thank you for applying to <Co>", "We received your application", "Our team will review your application and will be in touch", "Application received", "Thank you for your interest in <Co>! We received your application…". Even if the email also says "thank you for your interest", as long as the body confirms the application was received and review is pending, it is **applied-ack** — NOT rejection.
- **`rejection`** — company explicitly declined the candidate. Body contains an unambiguous "no" or "we won't proceed" message. Examples: "Unfortunately we won't be moving forward", "We've decided to move forward with other candidates", "We are not able to offer you this role at this time", "No longer being considered", "Wasn't selected". A subject like "Update on your application" alone is NOT enough — the body must say no.
- **`interview-request`** — explicit invitation to schedule a call/interview. Examples: "Would you like to schedule a chat?", "Please book a time on my calendar", "Find a time on Calendly". Includes recruiter screens, technical interviews, hiring-manager calls.
- **`interview-scheduling`** — confirmation that an interview is on the calendar. Examples: "Your interview with <interviewer> is confirmed", calendar invite text, "Looking forward to our chat tomorrow".
- **`interview-followup`** — post-interview communication. Examples: "Thanks for taking the time to meet", "We enjoyed speaking with you", "Next round details".
- **`offer`** — formal offer extended. Examples: "We're pleased to extend an offer", "Offer letter attached", "Formal offer of employment", "Congratulations — we'd love to have you join".
- **`recruiter-outreach`** — cold sourcing email, NOT in response to an application. Examples: "Came across your profile", "Saw your background and wanted to connect about a role at <Co>".
- **`security-code`** — 2FA / verification code email.
- **`other`** — doesn't fit any of the above. When in doubt between `other` and `rejection`, prefer `other`. False-positive rejection is worse than miscategorizing as `other`.

For each thread, output an entry:

```json
{
  "threadId": "<id>",
  "date": "<ISO date from message>",
  "sender": "<sender>",
  "subject": "<subject>",
  "snippet": "<message snippet>",
  "body": "<plain text body, max 4000 chars>",
  "intent": "<one of the values above>",
  "confidence": "high" | "medium" | "low",
  "reason": "<one short sentence explaining why this intent — for debugging>"
}
```

`confidence` is your honest read. `low` means you're guessing — the UI will show a "?" indicator. `reason` is for the user to spot-check; keep it under 80 characters.

## Step 6 — Group by company (NEVER drop)

Match each thread to a company using these heuristics in order — first match wins. **You MUST NOT drop any thread.** If every heuristic fails, bucket the thread under `Unknown — <sender-domain>` so the user can see it in the UI and triage manually.

1. Subject regex `applying to ([A-Z][\w &.\-']+)` (case-insensitive). Strip trailing punctuation/emoji. Use the captured group.
2. Subject regex `application (?:to|with|at|for) ([A-Z][\w &.\-']+)`.
3. Subject regex `(?:update on|regarding) your application (?:at|to|for|with) ([A-Z][\w &.\-']+)`.
4. Subject regex `interest in ([A-Z][\w &.\-']+)`.
5. **Tracker cross-reference (preferred when matched).** For each known company name from Step 4, check if subject OR sender (case-insensitive substring) contains the name's primary token (skip generic stop-words like "Inc", "AI", "Labs", "the"). On match, use the canonical tracker name.
6. **Sender display-name extraction.** From the sender field `"Name <email>"`, take Name. Strip trailing words: `Recruiting`, `Recruiter`, `Hiring`, `Talent`, `Team`, `Careers`, `People`, `HR`, `noreply`, `no-reply`. If the result has at least 2 letters and is not a generic word like "Notification" or "Updates", use it.
7. **Sender domain stem inference.** From `someone@subdomain.acme.com`, take the apex domain `acme.com` → company `Acme`. Capitalize the first letter. Do NOT use this for ATS senders (greenhouse-mail.io, ashbyhq.com, etc. — fall through instead).
8. **Fallback bucket.** Use `Unknown — <sender-domain>` (e.g., `Unknown — careers.bigco.com`). Keep the thread.

Group threads by company name. Sort each group descending by `date`.

## Step 7 — Write the cache

Write the result to the path resolved in Step 1 (overwrite). Format:

```json
{
  "fetchedAt": "<current ISO timestamp>",
  "lookbackDays": 180,
  "queries": ["<q1>", "<q2>", "<q3>", "<q4>"],
  "byCompany": {
    "<Company>": [<threads>],
    ...
  }
}
```

Use 2-space indent. Make the JSON valid. Include the `Unknown — *` buckets if any threads landed there.

## Step 8 — Done

Print a one-line summary: `refreshed: <N companies>, <M threads>, <K rejections>, <U unknown>, <L low-confidence> @ <ISO date>`. Then stop.
