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

If any single query returns 0 threads, that's fine — keep going. If a query returns an MCP error, log it to stderr but do not abort; complete the rest.

## Step 3 — Fetch full body for each thread

For each unique thread, call `mcp__claude_ai_Gmail__get_thread` with `threadId` and `messageFormat: "FULL_CONTENT"`. Take the first message of the returned thread.

Extract the message body as plain text:
- If the message has a plain-text part, use it directly.
- Otherwise, take the HTML part and strip tags: remove `<style>...</style>` and `<script>...</script>` blocks first, then strip remaining HTML tags, decode common HTML entities (`&amp;` → `&`, `&lt;` → `<`, `&gt;` → `>`, `&quot;` → `"`, `&#39;` → `'`, `&nbsp;` → space), collapse runs of whitespace, and trim leading/trailing whitespace.
- If neither is available, use the snippet as the body.

Trim the resulting body to 4000 characters max. Append `… [truncated]` if you trimmed.

## Step 4 — Load tracker for company cross-reference

Read `data/applications.md` if it exists. Extract the **Company** column from every table row (any status). Build a list of known company names — these are the canonical labels you should prefer when matching, since they're what the UI displays. If the file is missing or empty, this list is empty; that's fine.

## Step 5 — Classify each thread

For each thread (using its first message), produce an entry:

```json
{
  "threadId": "<id>",
  "date": "<ISO date from message>",
  "sender": "<sender>",
  "subject": "<subject>",
  "snippet": "<message snippet>",
  "body": "<plain text body, max 4000 chars>",
  "kind": "<one of: ats-ack | company-ack | rejection | interview | offer | security-code | other>"
}
```

Classification rules (apply in order, first match wins):
- subject contains "security code" or "verification code" → `security-code`
- subject + body mentions any of: "we have decided", "we've decided", "moving forward with other candidates", "won't be moving forward", "decided not to move forward", "decided to pursue other candidates", "unfortunately, we", "no longer being considered", "wasn't selected" → `rejection`
- subject contains "offer letter" / "pleased to extend" / "extending an offer" / "formal offer" → `offer`
- subject contains "interview" / "schedule a call" / "next steps" / "find a time" / "Calendly" → `interview`
- sender domain ends in `@us.greenhouse-mail.io`, `@greenhouse-mail.io`, `@ashbyhq.com`, `@hire.lever.co`, `@myworkday.com`, `@workable.com`, `@rippling.com`, `@jobvite.com`, `@icims.com`, `@breezyhr.com`, `@smartrecruiters.com`, `@teamtailor.com`, `@bamboohr.com` → `ats-ack`
- subject starts with "Thank you for applying" / "Thank you for your application" / "Application received" → `company-ack`
- otherwise → `other`

## Step 6 — Group by company (NEVER drop)

Match each thread to a company using these heuristics in order — first match wins. **You MUST NOT drop any thread.** If every heuristic fails, bucket the thread under `Unknown — <sender-domain>` so the user can see it in the UI and triage manually.

1. Subject regex `applying to ([A-Z][\w &.\-']+)` (case-insensitive). Strip trailing punctuation/emoji from the matched name. Use the captured group as the company.
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
  "queries": [
    "<query 1>",
    "<query 2>",
    "<query 3>",
    "<query 4>"
  ],
  "byCompany": {
    "<Company>": [<threads>],
    ...
  }
}
```

Use 2-space indent. Make the JSON valid. Include the `Unknown — *` buckets if any threads landed there.

## Step 8 — Done

Print a one-line summary: `refreshed: <N companies>, <M threads>, <K rejections>, <U unknown> @ <ISO date>`. Then stop.
