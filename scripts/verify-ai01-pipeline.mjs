// AI-01 hosted end-to-end proof.
//
// Watches the live Supabase project while you take ONE real native capture with
// every Capso browser tab closed, and proves the background pipeline classifies
// and routes it without a browser: screenshot ingested -> job pending ->
// processing -> done, and the screenshot row gains OCR text, intent, and search
// text with processing_status = 'processed'. Prints the observed latency against
// the parity budget in 27_CLEANSHOT_DAILY_DRIVER_PARITY.md.
//
// This is a read-only observer. It never writes, and it never handles the
// capture itself — you take the capture by hand. Run it, then capture.
//
// Usage:
//   CAPSO_SERVICE_ROLE_KEY=<service_role_key> node scripts/verify-ai01-pipeline.mjs
//
// Env:
//   CAPSO_SERVICE_ROLE_KEY  (required)  Supabase service_role key. Needed to read
//                                       public.jobs, whose RLS otherwise scopes
//                                       reads to the owning session. Rotate it
//                                       after use; never commit it.
//   CAPSO_SUPABASE_URL      (optional)  defaults to the Capso project URL below.
//   CAPSO_USER_ID           (optional)  only watch captures for this owner uuid.
//   CAPSO_TIMEOUT_SECONDS   (optional)  give up after this many seconds (default 240).
//
// Exit code 0 = PASS (a real capture processed within budget), 1 = FAIL/timeout,
// 2 = misconfiguration.

const DEFAULT_URL = "https://xbxedriuelwqjypdkvex.supabase.co";
// 27_CLEANSHOT_DAILY_DRIVER_PARITY.md: suggestion latency <5s p50 / <8s p90.
// A single sample cannot measure a percentile, so we PASS under the p90 ceiling
// and flag anything over the p50 target as worth a closer look in the full run.
const BUDGET_P50_MS = 5000;
const BUDGET_P90_MS = 8000;
const POLL_MS = 1000;

const url = (process.env.CAPSO_SUPABASE_URL ?? DEFAULT_URL).replace(/\/$/, "");
const key = process.env.CAPSO_SERVICE_ROLE_KEY;
const onlyUser = process.env.CAPSO_USER_ID ?? null;
const timeoutMs = Number(process.env.CAPSO_TIMEOUT_SECONDS ?? 240) * 1000;

if (!key) {
  console.error(
    "Missing CAPSO_SERVICE_ROLE_KEY. Copy the service_role key from the Supabase\n" +
      "dashboard (Project Settings -> API), export it, and re-run. Rotate it after.",
  );
  process.exit(2);
}

const headers = { apikey: key, authorization: `Bearer ${key}` };

async function rest(path) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!response.ok) {
    throw new Error(`REST ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const userFilter = onlyUser ? `&user_id=eq.${onlyUser}` : "";

async function latestScreenshot() {
  const rows = await rest(
    `screenshots?select=id,created_at&order=created_at.desc${userFilter}&limit=1`,
  );
  return rows[0] ?? null;
}

async function screenshotById(id) {
  const rows = await rest(
    `screenshots?select=id,created_at,processing_status,simulated,title,ocr_text,` +
      `intent,summary,tags,search_text,project_thread_id,suggested_thread_id,` +
      `assignment_source,user_id&id=eq.${id}&limit=1`,
  );
  return rows[0] ?? null;
}

async function jobFor(screenshotId) {
  const rows = await rest(
    `jobs?select=id,status,attempts,max_attempts,last_error,created_at` +
      `&kind=eq.process_capture&payload->>screenshot_id=eq.${screenshotId}` +
      `&order=id.desc&limit=1`,
  );
  return rows[0] ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => Number(process.hrtime.bigint() / 1_000_000n);

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  console.log(`AI-01 hosted pipeline proof — ${url}`);
  console.log("Read-only. Establishing a baseline, then waiting for your capture.\n");

  let baseline;
  try {
    baseline = await latestScreenshot();
  } catch (error) {
    console.error(`Could not reach the project: ${error.message}`);
    console.error("Check CAPSO_SUPABASE_URL and that the service_role key is valid.");
    process.exit(2);
  }
  const baselineId = baseline?.id ?? null;
  line("Baseline capture", baselineId ? `${baselineId} @ ${baseline.created_at}` : "(none yet)");

  console.log(
    "\n>>> Now, with EVERY Capso browser tab closed, take ONE capture in the mac app.\n" +
      "    (Region is fine.) Leave the browser closed. Watching...\n",
  );

  const started = clock();
  const seen = { ingest: false, processing: false };
  let target = null;

  while (clock() - started < timeoutMs) {
    if (!target) {
      const latest = await latestScreenshot();
      if (latest && latest.id !== baselineId) {
        target = latest.id;
        seen.ingest = true;
        console.log(`Capture ingested: ${target}`);
        line("ingest observed", `+${((clock() - started) / 1000).toFixed(1)}s`);
      }
      await sleep(POLL_MS);
      continue;
    }

    const [row, job] = await Promise.all([screenshotById(target), jobFor(target)]);
    if (job && !seen.processing && job.status === "processing") {
      seen.processing = true;
      line("job processing", `attempt ${job.attempts}/${job.max_attempts}`);
    }

    if (row && row.processing_status === "processed") {
      const ingestMs = new Date(row.created_at).getTime();
      const latencyMs = Date.now() - ingestMs;
      const failures = [];
      if (row.simulated !== false) failures.push("row is still simulated (placeholder, not a real model result)");
      if (!row.ocr_text) failures.push("ocr_text is empty");
      if (!row.intent) failures.push("intent is empty");
      if (!row.search_text) failures.push("search_text is empty (not keyword-searchable)");

      console.log("\n=== Classification result (evidence) ===");
      line("screenshot_id", row.id);
      line("title", row.title ?? "(null)");
      line("intent", row.intent ?? "(null)");
      line("tags", Array.isArray(row.tags) ? row.tags.join(", ") || "(none)" : "(null)");
      line("routing", row.project_thread_id ? `auto -> ${row.project_thread_id}` : row.suggested_thread_id ? `suggested -> ${row.suggested_thread_id}` : "inbox");
      line("ocr_text", row.ocr_text ? `${row.ocr_text.slice(0, 60)}${row.ocr_text.length > 60 ? "…" : ""}` : "(empty)");
      line("ingest→processed", `${(latencyMs / 1000).toFixed(1)}s`);

      const budget = latencyMs <= BUDGET_P90_MS
        ? latencyMs <= BUDGET_P50_MS ? "within p50 target (<5s)" : "within p90 ceiling (<8s), above p50 target"
        : `OVER budget (> ${BUDGET_P90_MS / 1000}s)`;
      line("latency vs budget", budget);
      if (latencyMs > BUDGET_P90_MS) failures.push(`processing latency ${(latencyMs / 1000).toFixed(1)}s exceeds the ${BUDGET_P90_MS / 1000}s p90 ceiling`);

      console.log("");
      if (failures.length === 0) {
        console.log("PASS — a real capture was classified and routed with the browser closed.");
        console.log("Record this run as AI-01 evidence in loops/STATE.md and BUILD_LOG.md.");
        process.exit(0);
      }
      console.log("FAIL — the capture processed but did not meet the gate:");
      for (const reason of failures) console.log(`  - ${reason}`);
      process.exit(1);
    }

    if (job && job.status === "failed") {
      console.log(`\nFAIL — job ${job.id} failed terminally: ${job.last_error ?? "unknown"}`);
      console.log("Inspect the Edge function logs for v1-process-screenshot.");
      process.exit(1);
    }

    await sleep(POLL_MS);
  }

  console.log("\nTIMEOUT — no processed capture observed in time.");
  if (!seen.ingest) {
    console.log("The capture never reached Supabase. Likely causes:");
    console.log("  - the mac app is not signed in (no authenticated session), or");
    console.log("  - the durable queue could not upload (check the tray sync state).");
  } else if (!seen.processing) {
    console.log("It ingested but the worker never claimed it. Likely causes:");
    console.log("  - the pg_cron 'capso-process-screenshot' wake is not firing, or");
    console.log("  - the Vault secret / Edge function is misconfigured.");
  } else {
    console.log("It was claimed but never completed — check the Edge function logs.");
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(2);
});
