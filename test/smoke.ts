/**
 * Smoke test: runs the real fetch + model pipeline against the live repo
 * using plain fetch and a token from GH_TOKEN. Verifies the structural facts
 * we established by hand for map #429 (hermes release watcher).
 *
 * Usage: GH_TOKEN=$(gh auth token) npm run smoke
 */
import { GitHubClient, fetchSnapshot, type Http } from "../src/github";
import { buildModel } from "../src/model";

const token = process.env.GH_TOKEN;
if (!token) {
  console.error("Set GH_TOKEN");
  process.exit(1);
}

const http: Http = async (url, headers) => {
  const res = await fetch(url, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const gh = new GitHubClient(() => ({ token, repo: "OcuClawhub/evenclaw" }), http);

const t0 = Date.now();
const snapshot = await fetchSnapshot(gh, null, true);
console.log(`fetched ${snapshot.issues.length} issues in ${Date.now() - t0}ms`);

const model = buildModel(snapshot);

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

console.log("\n— tallies —");
for (const { type, tally } of model.tallies) {
  console.log(`  ${type}: ${tally.open}/${tally.total}`);
}
console.log(`  total: ${model.totalOpen}/${model.totalIssues}\n`);

check("has 6 maps", model.maps.length === 6);
check("no orphans right now", model.orphans.length === 0);

const sdkRelay = model.maps.find((m) => m.issue.number === 368);
check("map #368 (native sub-issues, no body links) has 17 tickets", sdkRelay?.total === 17);

const watcher = model.maps.find((m) => m.issue.number === 429);
check("map #429 exists", !!watcher);
if (watcher) {
  check("#429 has 9 tickets", watcher.total === 9);
  const t436 = watcher.tickets.find((t) => t.issue.number === 436);
  check("#436 blockedBy includes 432,434,435,454",
    !!t436 && [432, 434, 435, 454].every((n) => t436.blockedBy.includes(n)));
  const t437 = watcher.tickets.find((t) => t.issue.number === 437);
  const t435 = watcher.tickets.find((t) => t.issue.number === 435);
  check("layering: 435 < 436 < 437",
    !!t435 && !!t436 && !!t437 && t435.layer < t436.layer && t436.layer < t437.layer);
  const t430 = watcher.tickets.find((t) => t.issue.number === 430);
  check("#430 is research/AFK on layer 0",
    !!t430 && t430.type === "research" && t430.mode === "AFK" && t430.layer === 0);
  console.log("\n— #429 layers —");
  watcher.layers.forEach((layer, i) =>
    console.log(
      `  L${i}: ${layer
        .map((t) => `#${t.issue.number}${t.frontier ? "*" : ""}${t.issue.state === "closed" ? "✓" : ""}`)
        .join("  ")}`,
    ),
  );
  console.log("\n— frontier across all maps —");
  for (const m of model.maps) {
    const f = m.tickets.filter((t) => t.frontier).map((t) => `#${t.issue.number} ${t.issue.title}`);
    if (f.length) console.log(`  ${m.issue.title}\n    ${f.join("\n    ")}`);
  }
}

// Incremental sync: nothing changed, so zero dependency re-fetches.
let depCalls = 0;
const countingHttp: Http = async (url, headers) => {
  if (url.includes("/dependencies/")) depCalls++;
  return http(url, headers);
};
const gh2 = new GitHubClient(() => ({ token, repo: "OcuClawhub/evenclaw" }), countingHttp);
await fetchSnapshot(gh2, snapshot, false);
check(`incremental sync makes 0 dependency calls (made ${depCalls})`, depCalls === 0);

for (const o of model.orphans) {
  console.log(`ORPHAN #${o.issue.number} [${o.issue.state}] parent=${o.parent} — ${o.issue.title}`);
  console.log(`  body head: ${JSON.stringify((o.issue.body ?? "").slice(0, 120))}`);
}

process.exit(failures ? 1 : 0);
