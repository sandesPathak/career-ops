You are running in headless mode. Your only task is to refresh the email cache used by the career-ops UI by searching the user's Gmail.

Follow these steps exactly. Do not ask any clarifying questions. Do not modify other files.

## Step 1 — Read the cache target path

The cache file path is given in the env var `CACHE_FILE`. If unset, default to `$HOME/Library/Application Support/career-ops-refresh/emails-cache.json` (macOS) or `$XDG_CACHE_HOME/career-ops-refresh/emails-cache.json` (Linux). You will overwrite this file in Step 5.

## Step 2 — Search Gmail (use mcp__claude_ai_Gmail__search_threads)

Run TWO searches with `pageSize: 50` each. Page through results until empty or pageToken is missing.

1. Query: `from:(greenhouse-mail.io OR ashbyhq.com OR hire.lever.co OR myworkday.com OR workable.com OR rippling.com OR jobvite.com OR icims.com OR breezyhr.com) newer_than:180d`
2. Query: `subject:(interview OR "next steps" OR screen OR schedule OR offer OR "thank you for applying" OR "your application") newer_than:180d`

Merge threads from both queries. Deduplicate by `threadId`.

## Step 3 — Fetch full body for each thread

For each unique thread, call `mcp__claude_ai_Gmail__get_thread` with `threadId` and `messageFormat: "FULL_CONTENT"`. Take the first message of the returned thread.

Extract the message body as plain text:
- If the message has a plain-text part, use it directly.
- Otherwise, take the HTML part and strip tags: remove `<style>...</style>` and `<script>...</script>` blocks first, then strip remaining HTML tags, decode common HTML entities (`&amp;` → `&`, `&lt;` → `<`, `&gt;` → `>`, `&quot;` → `"`, `&#39;` → `'`, `&nbsp;` → space), collapse runs of whitespace, and trim leading/trailing whitespace.
- If neither is available, use the snippet as the body.

Trim the resulting body to 4000 characters max. Append `… [truncated]` if you trimmed.

## Step 4 — Classify each thread

For each thread (using its first message), produce an entry:

```json
{
  "threadId": "<id>",
  "date": "<ISO date from message>",
  "sender": "<sender>",
  "subject": "<subject>",
  "snippet": "<message snippet>",
  "body": "<plain text body, max 4000 chars>",
  "kind": "<one of: ats-ack | company-ack | security-code | other>"
}
```

Classification rules (apply in order, first match wins):
- subject contains "Security code" → `security-code`
- sender ends in `@us.greenhouse-mail.io`, `@greenhouse-mail.io`, `@ashbyhq.com`, `@hire.lever.co`, `@myworkday.com`, `@workable.com`, `@rippling.com`, `@jobvite.com`, `@icims.com`, `@breezyhr.com` → `ats-ack`
- subject starts with "Thank you for applying" or "Thank you for your application" → `company-ack`
- otherwise → `other`

## Step 5 — Group by company

Match each thread to a company using these heuristics (try each, first match wins):

1. Subject contains `applying to <Company>` (case-insensitive). Strip trailing punctuation/emoji from the matched name.
2. Subject contains `application to <Company>`.
3. Sender domain match. If the sender domain is the company's primary domain (e.g. `acme.com` for Acme), use the company name. Maintain your own domain→company map locally if needed; this prompt does not bake one in.

If no company matches, drop the thread.

Group threads by company name and sort each group descending by `date`.

## Step 6 — Write the cache

Write the result to the path resolved in Step 1 (overwrite). Format:

```json
{
  "fetchedAt": "<current ISO timestamp>",
  "lookbackDays": 180,
  "queries": [
    "<query 1>",
    "<query 2>"
  ],
  "byCompany": {
    "<Company>": [<threads>],
    ...
  }
}
```

Use 2-space indent. Make the JSON valid. Do not include any threads outside `byCompany`.

## Step 7 — Done

Print a one-line summary: `refreshed: <N companies>, <M threads> @ <ISO date>`. Then stop.
