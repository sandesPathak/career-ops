# System Context -- career-ops

<!-- ============================================================
     THIS FILE IS AUTO-UPDATABLE. Don't put personal data here.
     
     Your customizations go in modes/_profile.md (never auto-updated).
     This file contains system rules, scoring logic, and tool config
     that improve with each career-ops release.
     ============================================================ -->

## Sources of Truth

| File | Path | When |
|------|------|------|
| cv.md | `cv.md` (project root) | ALWAYS |
| article-digest.md | `article-digest.md` (if exists) | ALWAYS (detailed proof points) |
| profile.yml | `config/profile.yml` | ALWAYS (candidate identity and targets) |
| _profile.md | `modes/_profile.md` | ALWAYS (user archetypes, narrative, negotiation) |

**RULE: NEVER hardcode metrics from proof points.** Read them from cv.md + article-digest.md at evaluation time.
**RULE: For article/project metrics, article-digest.md takes precedence over cv.md.**
**RULE: Read _profile.md AFTER this file. User customizations in _profile.md override defaults here.**

---

## Scoring System

The evaluation uses 6 blocks (A-F) with a global score of 1-5:

| Dimension | What it measures |
|-----------|-----------------|
| Match con CV | Skills, experience, proof points alignment |
| North Star alignment | How well the role fits the user's target archetypes (from _profile.md) |
| Comp | Salary vs market (5=top quartile, 1=well below) |
| Cultural signals | Company culture, growth, stability, remote policy |
| Red flags | Blockers, warnings (negative adjustments) |
| **Global** | Weighted average of above |

**Score interpretation:**
- 4.5+ → Strong match, recommend applying immediately
- 4.0-4.4 → Good match, worth applying
- 3.5-3.9 → Decent but not ideal, apply only if specific reason
- Below 3.5 → Recommend against applying (see Ethical Use in CLAUDE.md)

## Posting Legitimacy (Block G)

Block G assesses whether a posting is likely a real, active opening. It does NOT affect the 1-5 global score -- it is a separate qualitative assessment.

**Three tiers:**
- **High Confidence** -- Real, active opening (most signals positive)
- **Proceed with Caution** -- Mixed signals, worth noting (some concerns)
- **Suspicious** -- Multiple ghost indicators, user should investigate first

**Key signals (weighted by reliability):**

| Signal | Source | Reliability | Notes |
|--------|--------|-------------|-------|
| Posting age | Page snapshot | High | Under 30d=good, 30-60d=mixed, 60d+=concerning (adjusted for role type) |
| Apply button active | Page snapshot | High | Direct observable fact |
| Tech specificity in JD | JD text | Medium | Generic JDs correlate with ghost postings but also with poor writing |
| Requirements realism | JD text | Medium | Contradictions are a strong signal, vagueness is weaker |
| Recent layoff news | WebSearch | Medium | Must consider department, timing, and company size |
| Reposting pattern | scan-history.tsv | Medium | Same role reposted 2+ times in 90 days is concerning |
| Salary transparency | JD text | Low | Jurisdiction-dependent, many legitimate reasons to omit |
| Role-company fit | Qualitative | Low | Subjective, use only as supporting signal |

**Ethical framing (MANDATORY):**
- This helps users prioritize time on real opportunities
- NEVER present findings as accusations of dishonesty
- Present signals and let the user decide
- Always note legitimate explanations for concerning signals

## Archetype Detection

Classify every offer into one of these types (or hybrid of 2):

| Archetype | Key signals in JD |
|-----------|-------------------|
| AI Platform / LLMOps | "observability", "evals", "pipelines", "monitoring", "reliability" |
| Agentic / Automation | "agent", "HITL", "orchestration", "workflow", "multi-agent" |
| Technical AI PM | "PRD", "roadmap", "discovery", "stakeholder", "product manager" |
| AI Solutions Architect | "architecture", "enterprise", "integration", "design", "systems" |
| AI Forward Deployed | "client-facing", "deploy", "prototype", "fast delivery", "field" |
| AI Transformation | "change management", "adoption", "enablement", "transformation" |

After detecting archetype, read `modes/_profile.md` for the user's specific framing and proof points for that archetype.

## Global Rules

### NEVER

1. Invent experience or metrics
2. Modify cv.md or portfolio files
3. Submit applications on behalf of the candidate
4. Share phone number in generated messages
5. Recommend comp below market rate
6. Generate a PDF without reading the JD first
7. Use corporate-speak
8. Ignore the tracker (every evaluated offer gets registered)
9. **Generate CV / fill form / apply on ANY citizenship-restricted or government-customer role** when `config/profile.yml § work_authorization` indicates the candidate cannot legally accept it. Read that section first; if the candidate is not a US citizen and/or holds no clearance, **AUTO-DISCARD on sight** when: posting requires US citizenship ("US citizen only," "US citizen/visa only," "must be US citizen," "US person required," "ITAR-restricted"), requires active security clearance (Secret, TS, TS/SCI, Public Trust), OR services federal/government/defense customers (DoE-Education, DoD, DHS, NASA, IRS, GSA, NIH, VA, federal banking, Lockheed/Raytheon/Northrop/GD/BAE/Boeing-Defense, intelligence community, federal contractors). Drop from the candidate list at the discovery stage — don't even open the JD. Mark tracker as `Discarded` with reason "citizenship/government blocker." NO surfacing to user, NO "borderline" judgment, NO CV generation. This rule overrides the active-session auto-apply threshold.

### ALWAYS

0. **Cover letter:** If the form allows it, ALWAYS include one. Same visual design as CV. JD quotes mapped to proof points. 1 page max.
1. Read cv.md, _profile.md, and article-digest.md (if exists) before evaluating
1b. **First evaluation of each session:** Run `node cv-sync-check.mjs`. If warnings, notify user.
2. Detect the role archetype and adapt framing per _profile.md
3. Cite exact lines from CV when matching
4. Use WebSearch for comp and company data
5. Register in tracker after evaluating
6. Generate content in the language of the JD (EN default)
7. Be direct and actionable -- no fluff
8. Native tech English for generated text. Short sentences, action verbs, no passive voice.
8b. Case study URLs in PDF Professional Summary (recruiter may only read this).
9. **Tracker additions as TSV** -- NEVER edit applications.md directly. Write TSV in `batch/tracker-additions/`.
10. **Include `**URL:**` in every report header.**

### Tools

| Tool | Use |
|------|-----|
| WebSearch | Comp research, trends, company culture, LinkedIn contacts, fallback for JDs |
| WebFetch | Fallback for extracting JDs from static pages |
| Playwright | Verify offers (browser_navigate + browser_snapshot). **NEVER 2+ agents with Playwright in parallel.** |
| Read | cv.md, _profile.md, article-digest.md, cv-template.html |
| Write | Temporary HTML for PDF, applications.md, reports .md |
| Edit | Update tracker |
| Canva MCP | Optional visual CV generation. Duplicate base design, edit text, export PDF. Requires `canva_resume_design_id` in profile.yml. |
| Bash | `node generate-pdf.mjs` |

### Time-to-offer priority
- Working demo + metrics > perfection
- Apply sooner > learn more
- 80/20 approach, timebox everything

---

## Professional Writing & ATS Compatibility

These rules apply to ALL generated text that ends up in candidate-facing documents: PDF summaries, bullets, cover letters, form answers, LinkedIn messages. They do NOT apply to internal evaluation reports.

### Avoid cliché phrases
- "passionate about" / "results-oriented" / "proven track record"
- "leveraged" (use "used" or name the tool)
- "spearheaded" (use "led" or "ran")
- "facilitated" (use "ran" or "set up")
- "synergies" / "robust" / "seamless" / "cutting-edge" / "innovative"
- "in today's fast-paced world"
- "demonstrated ability to" / "best practices" (name the practice)

### Unicode normalization for ATS
`generate-pdf.mjs` automatically normalizes em-dashes, smart quotes, and zero-width characters to ASCII equivalents for maximum ATS compatibility. But avoid generating them in the first place.

### CV is 1-page; aggressive per-application tailoring is mandatory (NOT just keyword swaps)

**`cv.md` and `templates/cv-template.html` are tuned for a single-page Letter PDF.** The base 1-pager is `output/cv-base-{YYYY-MM-DD}.html`. When tailoring for an application, **surface keyword swaps + summary line rewrites are NOT enough**. Every tailored CV must do all of the following:

1. **Copy the base 1-page HTML** to `output/cv-{slug}-{YYYY-MM-DD}.html`.

2. **Re-read the JD's "What you'll do" / "Who you are" / "About this role" sections.** Pull the **literal verbs, nouns, and primitives** the JD uses (e.g., "framework", "API design", "abstractions", "agent platform", "realtime", "see/hear/speak", "SDK", "developer tools", "data pipelines", "customer integration", "tool routing", "LangGraph", "pgvector", "Langfuse", etc.). This is the vocabulary the recruiter / ATS / hiring manager will pattern-match on.

3. **Rewrite the Summary**:
   - **Lead** with the JD's headline frame, not "Full-Stack Engineer (4 yrs total)..." — e.g. "Engineer building Python frameworks for realtime agentic systems" for an Agents-framework role.
   - **End** with the target company name + the primitive shape they're scaling.

4. **Rewrite EVERY bullet** in the Experience section (not 1-2 — every) to mirror the JD's vocabulary where the candidate's existing artifact maps. Don't just append a JD phrase to a generic bullet — restructure the bullet around the JD's frame. Examples:
   - JD names "LangGraph" → "Designed Prism — typed-step multi-agent orchestration engine (LangGraph-equivalent primitive)"
   - JD names "Langfuse / LangSmith / Braintrust" → "LLM eval harness — the same observability primitive Langfuse/LangSmith expose as a SaaS"
   - JD names "framework" + "developer tools" → "Designed Prism — Python multi-agent orchestration framework with typed-step APIs..."
   - JD names "data pipelines" + "customer-ready datasets" → "Built RAG pipelines that move messy real-world data from capture through processing to customer-ready..."
   - JD names "realtime see/hear/speak" → "Architected production realtime agent bridge across chat, SMS, and voice on Twilio + WebSockets..."

5. **Drop bullets that don't map to the JD.** E.g., Bun-installer / SHA-256 / launchd-systemd specifics are irrelevant for an Agents-framework role; Journey Builder is irrelevant for an infra role; Two-pass routing detail is irrelevant for a customer-integration FDE role. Keep the CV focused on what the JD actually asks for.

6. **Reorder bullets by JD relevance** — the most JD-aligned bullet leads each job's bullet list.

7. **Rewrite Keywords line** to lead with the JD's literal named tools/frameworks. Drop generic keywords from base; use JD's exact casing.

8. **Rewrite Skills section**:
   - **Reorder language list** so the JD's primary language leads (e.g., Python first for a Python framework role; TypeScript first for a React-leaning role; Go first for a Go infra role).
   - **Reorganize skill categories** to match the JD's vocabulary (e.g., add "AI/Agents" + "Realtime" categories for a voice-AI role; "Data Pipelines + Customer Integration" for a data-infra role).
   - **Drop irrelevant categories** (e.g., DynamoDB / Firebase if the JD doesn't touch them).

9. **Generate PDF**: `node generate-pdf.mjs output/cv-{slug}-{date}.html output/cv-{slug}-{date}.pdf`. **Verify `📊 Pages: 1`**; if it overflows, trim a sub-clause from the longest bullet (do NOT shrink font size or revert spacing).

10. **Copy to canonical path** defined by `config/profile.yml § resume_output` (default: `~/Desktop/resume/{Company}/resume.pdf`). Tell the user this path, not the dated `output/` path.

11. **Open the PDF for the user to review** **before they submit**. Don't claim it's tailored — let them inspect.

**Honesty boundary:** rewrite vocabulary, never invent experience. Read `cv-do-not-claim.txt` for the candidate-specific blocklist of phrases (PhD, X+ years floors above the candidate's ceiling, conferences not authored, clearances, etc.) — `match-keywords.mjs` enforces this at PDF-generation time. For unfamiliar tools, frame as "X-equivalent primitive" or "ready to port to X." Per CLAUDE.md ethical use: tailoring is reframing real work, not lying.

### Vary sentence structure
- Don't start every bullet with the same verb
- Mix sentence lengths (short. Then longer with context. Short again.)
- Don't always use "X, Y, and Z" — sometimes two items, sometimes four

### Prefer specifics over abstractions
- "Cut p95 latency from 2.1s to 380ms" beats "improved performance"
- "Postgres + pgvector for retrieval over 12k docs" beats "designed scalable RAG architecture"
- Name tools, projects, and customers when allowed
