#!/usr/bin/env node
// match-keywords.mjs — simple JD↔CV keyword matcher with hard gate.
//
// Usage:
//   node match-keywords.mjs <JD-URL> <tailored-html>
//
// What it does:
//   1. Fetches the JD URL via Playwright (or fallback to fetch+text)
//   2. Tokenizes JD into skill-like phrases (capitalized terms, multi-word, acronyms)
//   3. Tokenizes CV (the tailored HTML) into the same shape
//   4. For each JD phrase: present in CV?
//   5. Drops phrases matching cv-do-not-claim.txt (fabrication-tier)
//   6. Writes <tailored-html>.keywords.json with overlap stats
//   7. Exits 0 if overlap ≥ threshold, 1 otherwise (gates generate-pdf.mjs)
//
// generate-pdf.mjs reads the .keywords.json and refuses to run if missing or low.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const OVERLAP_THRESHOLD = 0.55;
const STOPWORDS = new Set([
  'and','or','of','the','a','an','in','on','at','for','with','to','from','by','as','is','are',
  'be','will','this','that','these','those','our','your','their','we','you','they','it','its',
  'all','any','each','every','some','must','should','can','may','have','has','had','plus','also',
  'including','using','via','across','about','into','over','under','between','within','without',
  'good','great','strong','solid','high','low','new','old','more','most','less','best','better',
  'role','team','company','work','job','position','candidate','experience','years','year',
  'required','preferred','requirement','required:','preferred:','responsibilities','responsibility',
  'us','usa','united','states','remote','onsite','hybrid','full','time','full-time',
  'eg','e.g.','ie','i.e.','etc','etc.',
]);

function logErr(msg) { process.stderr.write(`[match-keywords] ${msg}\n`); }

async function fetchJDText(url) {
  // Use Playwright headless to handle JS-heavy ATS pages
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130 Safari/537.36' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1500);
    return await page.evaluate(() => document.body?.innerText || '');
  } finally {
    await browser.close();
  }
}

// Pull JD's skill-like terms: capitalized words, multi-word phrases, acronyms.
function extractJDTerms(text) {
  const out = new Set();

  // 1) Multi-word capitalized phrases (e.g., "Forward Deployed Engineer", "Two-Tower Retrieval")
  const multiCap = text.match(/\b([A-Z][a-zA-Z0-9.+#]*(?:[\s/-][A-Z][a-zA-Z0-9.+#]*){1,4})\b/g) || [];
  for (const m of multiCap) {
    const t = m.trim();
    if (t.length < 4 || t.length > 60) continue;
    out.add(t);
  }

  // 2) Acronyms (2-6 letters, all caps): RAG, MCP, LLM, NDCG, AUC, BLEU, CTR, GPU, API, etc.
  const acronyms = text.match(/\b[A-Z]{2,6}\b/g) || [];
  for (const a of acronyms) {
    if (a.length < 2 || STOPWORDS.has(a.toLowerCase())) continue;
    out.add(a);
  }

  // 3) CamelCase tech words (PyTorch, TypeScript, GraphQL, JavaScript, NumPy)
  const camel = text.match(/\b([A-Z][a-z]+[A-Z][a-zA-Z0-9.+#]*)\b/g) || [];
  for (const c of camel) out.add(c);

  // 4) Hyphenated tech words (Two-Tower, fine-tuning, real-time, judge-based)
  const hyphenated = text.match(/\b([a-zA-Z][a-zA-Z0-9.+#]+(?:-[a-zA-Z0-9.+#]+){1,3})\b/g) || [];
  for (const h of hyphenated) {
    if (h.length < 4 || h.length > 50) continue;
    out.add(h);
  }

  // 5) Tools / packages (lowercase but tech-flavored): pytorch, sklearn, postgres, langchain
  const known = [
    'python','typescript','javascript','golang','java','rust','sql','bash','kotlin','swift',
    'pytorch','tensorflow','sklearn','scikit-learn','huggingface','transformers','onnx',
    'langchain','langgraph','llamaindex','openai','anthropic','openrouter','litellm',
    'nodejs','express','nestjs','fastapi','django','flask','springboot',
    'react','nextjs','vue','svelte','angular','tailwind',
    'postgresql','postgres','mysql','mongodb','redis','dynamodb','firestore','snowflake',
    'docker','kubernetes','terraform','helm','ansible','jenkins',
    'aws','azure','gcp','lambda','sqs','sns','s3','ec2','ecs','rds','aurora',
    'graphql','rest','grpc','websocket','sse','mqtt',
    'rag','mcp','sft','peft','dpo','rlhf','ann','knn','ndcg','auc','bleu','bertscore',
    'kafka','airflow','spark','databricks','dbt','prefect','dagster',
    'datadog','grafana','prometheus','sentry','newrelic','dynatrace',
  ];
  const lower = text.toLowerCase();
  for (const k of known) {
    const re = new RegExp(`\\b${k.replace(/[+]/g,'\\+').replace(/[.]/g,'\\.')}\\b`, 'i');
    if (re.test(text)) out.add(k);
  }

  // Normalize + filter
  const filtered = [];
  for (const t of out) {
    const tl = t.toLowerCase().replace(/[.,;:!?]+$/g, '').trim();
    if (!tl || tl.length < 2) continue;
    if (STOPWORDS.has(tl)) continue;
    // Single common word like "Engineer" / "Software" — drop unless 2+ words
    if (!/[\s/-]/.test(tl) && tl.length < 3) continue;
    filtered.push(tl);
  }
  return [...new Set(filtered)];
}

function loadDoNotClaim() {
  const p = 'cv-do-not-claim.txt';
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n').map(l => l.split('#')[0].trim().toLowerCase())
    .filter(l => l && l.length > 1);
}

function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchTerms(jdTerms, cvText, doNotClaim) {
  const matched = [];
  const missingHonest = [];
  const droppedFabrication = [];
  for (const term of jdTerms) {
    const fabrication = doNotClaim.find(b => term.includes(b) || b.includes(term));
    if (fabrication) {
      droppedFabrication.push({ term, blocked_by: fabrication });
      continue;
    }
    if (cvText.includes(term)) matched.push(term);
    else missingHonest.push(term);
  }
  return { matched, missingHonest, droppedFabrication };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    logErr('Usage: node match-keywords.mjs <JD-URL> <tailored-html>');
    logErr('       node match-keywords.mjs --jd-text-file <txt> <tailored-html>');
    process.exit(2);
  }

  let jdText, jdUrl;
  if (args[0] === '--jd-text-file') {
    jdText = readFileSync(args[1], 'utf-8');
    jdUrl = `file://${args[1]}`;
    args.shift(); args.shift();
  } else {
    jdUrl = args.shift();
    logErr(`Fetching JD from ${jdUrl}...`);
    jdText = await fetchJDText(jdUrl);
    logErr(`Fetched ${jdText.length} chars`);
  }

  const tailoredHtml = args[0];
  if (!existsSync(tailoredHtml)) {
    logErr(`Tailored HTML not found: ${tailoredHtml}`);
    process.exit(2);
  }

  const cvText = htmlToText(readFileSync(tailoredHtml, 'utf-8'));
  const jdTerms = extractJDTerms(jdText);
  const doNotClaim = loadDoNotClaim();
  const { matched, missingHonest, droppedFabrication } = matchTerms(jdTerms, cvText, doNotClaim);

  const total = jdTerms.length - droppedFabrication.length; // fabrication-tier doesn't count against us
  const overlap = total > 0 ? matched.length / total : 0;

  const report = {
    jd_url: jdUrl,
    tailored_html: tailoredHtml,
    timestamp: new Date().toISOString(),
    overlap,
    overlap_percent: (overlap * 100).toFixed(1),
    threshold: OVERLAP_THRESHOLD,
    pass: overlap >= OVERLAP_THRESHOLD,
    counts: {
      jd_terms_total: jdTerms.length,
      matched: matched.length,
      missing_honest: missingHonest.length,
      dropped_fabrication: droppedFabrication.length,
    },
    matched: matched.sort(),
    missing_honest: missingHonest.sort(),
    dropped_fabrication: droppedFabrication,
  };

  const jsonOut = tailoredHtml.replace(/\.html$/, '.keywords.json');
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));

  // Console summary
  console.log('━'.repeat(60));
  console.log(`KEYWORD MATCH — ${jdUrl}`);
  console.log('━'.repeat(60));
  console.log(`JD terms total:           ${jdTerms.length}`);
  console.log(`✓ Matched in CV:          ${matched.length}`);
  console.log(`⚠ Missing (add if honest):${missingHonest.length}`);
  console.log(`✗ Dropped (fabrication):  ${droppedFabrication.length}`);
  console.log(`OVERLAP:                  ${(overlap * 100).toFixed(1)}%   (threshold ${(OVERLAP_THRESHOLD * 100)}%)`);
  console.log(report.pass ? '✓ PASS — generate-pdf.mjs may proceed' : '✗ FAIL — block PDF generation');
  if (missingHonest.length) {
    console.log('\n--- Missing terms (consider adding to Skills if honest) ---');
    console.log('  ' + missingHonest.slice(0, 30).join(' · '));
    if (missingHonest.length > 30) console.log(`  …and ${missingHonest.length - 30} more`);
  }
  if (droppedFabrication.length) {
    console.log('\n--- Dropped (fabrication, do not add) ---');
    for (const d of droppedFabrication.slice(0, 10)) console.log(`  ✗ ${d.term} (matches "${d.blocked_by}")`);
  }
  console.log(`\nJSON written: ${jsonOut}`);

  process.exit(report.pass ? 0 : 1);
}

main().catch(err => {
  logErr(`Fatal: ${err.message}`);
  process.exit(2);
});
