import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModel,
  blockerLabel,
  hasConflictingLabels,
  modeOf,
  parentOf,
  wayfinderType,
  type RawIssue,
  type Snapshot,
} from "../src/model";

function issue(
  number: number,
  labels: string[],
  options: Partial<RawIssue> = {},
): RawIssue {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    body: null,
    labels,
    assignees: [],
    html_url: `https://github.test/issues/${number}`,
    updated_at: `2026-01-${String((number % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    ...options,
  };
}

test("wayfinderType finds known labels and ignores unknown wayfinder suffixes", () => {
  assert.equal(wayfinderType(["bug", "wayfinder:research"]), "research");
  assert.equal(wayfinderType(["wayfinder:unknown", "wayfinder:task"]), "task");
  assert.equal(wayfinderType(["wayfinder:unknown", "enhancement"]), null);
  assert.equal(wayfinderType(["wayfinder:map", "wayfinder:prototype"]), "map");
});

test("wayfinderType uses conservative fixed precedence regardless of label order", () => {
  assert.equal(wayfinderType(["wayfinder:task", "wayfinder:research"]), "research");
  assert.equal(wayfinderType(["wayfinder:research", "wayfinder:task"]), "research");
  assert.equal(wayfinderType(["wayfinder:prototype", "wayfinder:map"]), "map");
});

test("hasConflictingLabels detects type and readiness conflicts", () => {
  assert.equal(hasConflictingLabels(["ready-for-agent", "ready-for-human"]), true);
  assert.equal(hasConflictingLabels(["wayfinder:task", "wayfinder:research"]), true);
  assert.equal(hasConflictingLabels(["wayfinder:task", "ready-for-agent"]), false);
});

test("parentOf reads the body fallback case-insensitively", () => {
  assert.equal(parentOf("Context\n\nPart of #429\n"), 429);
  assert.equal(parentOf("PART OF #7"), 7);
  assert.equal(parentOf("  Part of #7  \n"), 7);
  assert.equal(parentOf("This was once part of #429 in prose"), null);
  assert.equal(parentOf("Related to #429"), null);
  assert.equal(parentOf(null), null);
});

test("modeOf covers fixed modes and both task readiness labels", () => {
  assert.equal(modeOf("research", []), "AFK");
  assert.equal(modeOf("prototype", []), "HITL");
  assert.equal(modeOf("grilling", []), "HITL");
  assert.equal(modeOf("task", ["ready-for-agent"]), "AFK");
  assert.equal(modeOf("task", ["ready-for-human"]), "HITL");
  assert.equal(modeOf("task", []), "either");
});

test("buildModel forces HITL when recognized labels conflict", () => {
  const base = syntheticSnapshot();
  base.issues.push(
    issue(121, ["wayfinder:task", "ready-for-agent", "ready-for-human"]),
    issue(122, ["wayfinder:task", "wayfinder:research"]),
    issue(123, ["wayfinder:research", "wayfinder:task"]),
  );

  const tickets = new Map(
    buildModel(base).orphans.map((ticket) => [ticket.issue.number, ticket]),
  );
  assert.deepEqual(
    [121, 122, 123].map((number) => [tickets.get(number)?.type, tickets.get(number)?.mode]),
    [
      ["task", "HITL"],
      ["research", "HITL"],
      ["research", "HITL"],
    ],
  );
});

test("buildModel assigns layers, flattens cycles, and computes impact", () => {
  const model = buildModel(syntheticSnapshot());
  const map = model.maps.find((candidate) => candidate.issue.number === 100);
  assert.ok(map);
  const tickets = new Map(map.tickets.map((ticket) => [ticket.issue.number, ticket]));

  assert.equal(tickets.get(101)?.layer, 0);
  assert.equal(tickets.get(102)?.layer, 1);
  assert.equal(tickets.get(103)?.layer, 2);
  assert.equal(tickets.get(108)?.layer, 0);
  assert.equal(tickets.get(109)?.layer, 0);
  assert.equal(tickets.get(101)?.downstreamImpact, 2);
  assert.equal(tickets.get(102)?.downstreamImpact, 1);
  assert.equal(tickets.get(103)?.downstreamImpact, 0);
});

test("buildModel excludes assigned, blocked, unverified, and closed tickets from frontier", () => {
  const map = buildModel(syntheticSnapshot()).maps.find(
    (candidate) => candidate.issue.number === 100,
  );
  assert.ok(map);
  const frontier = map.tickets
    .filter((ticket) => ticket.frontier)
    .map((ticket) => ticket.issue.number);

  assert.deepEqual(frontier, [101]);
  assert.deepEqual(
    map.tickets.find((ticket) => ticket.issue.number === 106)?.openBlockers,
    [{ number: 999 }],
  );
});

test("buildModel resolves blocker state conservatively and preserves blocker identity", () => {
  const snap = syntheticSnapshot();
  snap.issues.push(
    issue(130, ["wayfinder:task"], { body: "Part of #100" }),
    issue(131, ["wayfinder:task"], { body: "Part of #100" }),
    issue(132, ["wayfinder:task"], { body: "Part of #100" }),
    issue(133, ["wayfinder:task"], { body: "Part of #100" }),
    issue(134, ["wayfinder:task"], { body: "Part of #100" }),
    issue(140, ["bug"], { state: "closed" }),
  );
  snap.deps["130"] = { updatedAt: "", blockedBy: [{ number: 140, state: "open" }] };
  snap.deps["131"] = { updatedAt: "", blockedBy: [{ number: 141, state: "open" }] };
  snap.deps["132"] = { updatedAt: "", blockedBy: [{ number: 142, state: "closed" }] };
  snap.deps["133"] = { updatedAt: "", blockedBy: [{ number: 143 }] };
  snap.deps["134"] = {
    updatedAt: "",
    blockedBy: [{ number: 144, state: "open", repo: "other/repo" }],
  };

  const map = buildModel(snap).maps.find((candidate) => candidate.issue.number === 100);
  assert.ok(map);
  const tickets = new Map(map.tickets.map((ticket) => [ticket.issue.number, ticket]));

  assert.deepEqual(tickets.get(130)?.openBlockers, []);
  assert.deepEqual(tickets.get(131)?.openBlockers, [{ number: 141, state: "open" }]);
  assert.deepEqual(tickets.get(132)?.openBlockers, []);
  assert.deepEqual(tickets.get(133)?.openBlockers, [{ number: 143 }]);
  assert.deepEqual(tickets.get(134)?.blockedBy, []);
  assert.deepEqual(tickets.get(134)?.openBlockers, [
    { number: 144, state: "open", repo: "other/repo" },
  ]);
  assert.equal(blockerLabel(tickets.get(134)!.openBlockers[0]), "other/repo#144");
  assert.equal(blockerLabel({ number: 140 }), "#140");
});

test("buildModel detects both missing-parent and parent-not-map orphans", () => {
  const model = buildModel(syntheticSnapshot());
  assert.deepEqual(
    model.orphans.map((ticket) => [ticket.issue.number, ticket.parent]),
    [
      [111, 999],
      [110, null],
    ],
  );
});

test("buildModel reports exact tallies and overall issue counts", () => {
  const model = buildModel(syntheticSnapshot());
  assert.deepEqual(model.tallies, [
    { type: "map", tally: { open: 2, total: 4 } },
    { type: "grilling", tally: { open: 1, total: 1 } },
    { type: "research", tally: { open: 1, total: 2 } },
    { type: "prototype", tally: { open: 3, total: 3 } },
    { type: "task", tally: { open: 5, total: 5 } },
  ]);
  assert.equal(model.totalIssues, 17);
  assert.equal(model.totalOpen, 14);
  assert.equal(model.maps.find((map) => map.issue.number === 100)?.resolved, 1);
  assert.equal(model.maps.find((map) => map.issue.number === 100)?.total, 9);
});

test("buildModel sorts open maps newest first and closed maps last", () => {
  assert.deepEqual(
    buildModel(syntheticSnapshot()).maps.map((map) => map.issue.number),
    [200, 100, 300, 250],
  );
});

function syntheticSnapshot(): Snapshot {
  const issues = [
    issue(100, ["wayfinder:map"]),
    issue(200, ["wayfinder:map"]),
    issue(300, ["wayfinder:map"], { state: "closed" }),
    issue(101, ["wayfinder:research"], { body: "Part of #100" }),
    issue(102, ["wayfinder:prototype"]),
    issue(103, ["wayfinder:task", "ready-for-agent"], { body: "Part of #100" }),
    issue(104, ["wayfinder:task", "ready-for-human"], {
      body: "Part of #100",
      assignees: ["octo"],
    }),
    issue(105, ["wayfinder:grilling"], { body: "Part of #100" }),
    issue(106, ["wayfinder:task"], { body: "Part of #100" }),
    issue(107, ["wayfinder:research"], { body: "Part of #100", state: "closed" }),
    issue(108, ["wayfinder:task"], { body: "Part of #100" }),
    issue(109, ["wayfinder:task"], { body: "Part of #100" }),
    issue(110, ["wayfinder:prototype"]),
    issue(111, ["wayfinder:prototype"], { body: "Part of #999" }),
    issue(999, ["bug"]),
    issue(120, ["wayfinder:unknown"]),
    issue(250, ["wayfinder:map"], { state: "closed" }),
  ];
  return {
    schemaVersion: 2,
    repo: "owner/repo",
    fetchedAt: 123,
    issues,
    parents: { "102": 100 },
    deps: {
      "101": { updatedAt: issues[3].updated_at, blockedBy: [] },
      "102": { updatedAt: issues[4].updated_at, blockedBy: [{ number: 101 }] },
      "103": { updatedAt: issues[5].updated_at, blockedBy: [{ number: 102 }] },
      "104": { updatedAt: issues[6].updated_at, blockedBy: [] },
      "105": { updatedAt: "", blockedBy: [], unverified: true },
      "106": { updatedAt: issues[8].updated_at, blockedBy: [{ number: 999 }] },
      "107": { updatedAt: issues[9].updated_at, blockedBy: [] },
      "108": { updatedAt: issues[10].updated_at, blockedBy: [{ number: 109 }] },
      "109": { updatedAt: issues[11].updated_at, blockedBy: [{ number: 108 }] },
      "110": { updatedAt: issues[12].updated_at, blockedBy: [] },
      "111": { updatedAt: issues[13].updated_at, blockedBy: [] },
    },
  };
}
