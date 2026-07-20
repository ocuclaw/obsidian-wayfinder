import assert from "node:assert/strict";
import test from "node:test";
import type { MapTree, Model, RawIssue, Ticket } from "../src/model";
import {
  groupTicketsByActionability,
  parseViewMode,
  projectView,
  type ViewFilters,
} from "../src/view-state";

function issue(number: number, state: "open" | "closed" = "open"): RawIssue {
  return {
    number,
    title: `Issue ${number}`,
    state,
    body: null,
    labels: [],
    assignees: [],
    html_url: `https://github.test/issues/${number}`,
    updated_at: "2026-07-20T00:00:00Z",
  };
}

function ticket(
  repo: string,
  number: number,
  options: {
    state?: "open" | "closed";
    frontier?: boolean;
    claimed?: boolean;
    blocked?: boolean;
    unverified?: boolean;
  } = {},
): Ticket {
  const raw = issue(number, options.state);
  if (options.claimed) raw.assignees = ["octo"];
  return {
    repo,
    issue: raw,
    type: "task",
    mode: "either",
    parent: 10,
    blockers: [],
    blockedBy: [],
    openBlockers: options.blocked ? [{ number: 999, state: "open" }] : [],
    unverified: options.unverified ?? false,
    frontier: options.frontier ?? false,
    downstreamImpact: 0,
    layer: 0,
  };
}

function map(
  repo: string,
  number: number,
  state: "open" | "closed",
  tickets: Ticket[],
  layers: Ticket[][] = [tickets],
): MapTree {
  return {
    repo,
    issue: issue(number, state),
    tickets,
    layers,
    resolved: tickets.filter((candidate) => candidate.issue.state === "closed").length,
    total: tickets.length,
  };
}

function model(): Model {
  const openOne = ticket("owner/one", 101, { frontier: true });
  const closedOne = ticket("owner/one", 102, { state: "closed" });
  const openTwo = ticket("owner/one", 103, { claimed: true });
  const closedTwo = ticket("owner/one", 104, { state: "closed" });
  const first = map(
    "owner/one",
    10,
    "open",
    [openOne, closedOne, openTwo, closedTwo],
    [[closedOne, openOne], [closedTwo], [openTwo]],
  );
  const duplicateNumber = map("owner/two", 10, "open", [ticket("owner/two", 201)]);
  const completed = map("owner/one", 30, "closed", [ticket("owner/one", 301)]);
  return {
    maps: [first, duplicateNumber, completed],
    orphans: [ticket("owner/one", 401), ticket("owner/one", 402, { state: "closed" })],
    tallies: [{ type: "map", tally: { open: 2, total: 3 } }],
    totalIssues: 12,
    totalOpen: 8,
    fetchedAt: 123,
  };
}

const defaults: ViewFilters = {
  selectedMapKey: null,
  showCompletedMaps: true,
  incompleteTicketsOnly: false,
};

test("parseViewMode accepts every view mode and rejects malformed values", () => {
  assert.equal(parseViewMode("tree"), "tree");
  assert.equal(parseViewMode("list"), "list");
  assert.equal(parseViewMode("hybrid"), "hybrid");
  assert.equal(parseViewMode("TREE"), null);
  assert.equal(parseViewMode("grid"), null);
  assert.equal(parseViewMode(null), null);
});

test("projectView filters completed maps without changing canonical order or tallies", () => {
  const source = model();
  const projected = projectView(source, { ...defaults, showCompletedMaps: false }).model;

  assert.deepEqual(
    projected.maps.map((candidate) => `${candidate.repo}#${candidate.issue.number}`),
    ["owner/one#10", "owner/two#10"],
  );
  assert.strictEqual(projected.tallies, source.tallies);
  assert.equal(projected.totalIssues, 12);
  assert.equal(projected.totalOpen, 8);
});

test("focused map identity is repository-qualified and hides orphans", () => {
  const projection = projectView(model(), {
    ...defaults,
    selectedMapKey: "owner/two#10",
  });

  assert.equal(projection.selectedMapKey, "owner/two#10");
  assert.deepEqual(
    projection.model.maps.map((candidate) => candidate.repo),
    ["owner/two"],
  );
  assert.deepEqual(projection.model.orphans, []);
});

test("missing, hidden-repository, and completed-filtered focus falls back to All maps", () => {
  const source = model();
  for (const selectedMapKey of ["deleted/repo#99", "hidden/repo#10"]) {
    const projection = projectView(source, { ...defaults, selectedMapKey });
    assert.equal(projection.selectedMapKey, null);
    assert.equal(projection.model.maps.length, 3);
    assert.equal(projection.model.orphans.length, 2);
  }

  const filtered = projectView(source, {
    ...defaults,
    selectedMapKey: "owner/one#30",
    showCompletedMaps: false,
  });
  assert.equal(filtered.selectedMapKey, null);
  assert.deepEqual(
    filtered.model.maps.map((candidate) => candidate.issue.number),
    [10, 10],
  );
});

test("incomplete projection filters tickets, layers, and orphans while preserving order", () => {
  const projected = projectView(model(), {
    ...defaults,
    incompleteTicketsOnly: true,
  }).model;
  const first = projected.maps[0];

  assert.deepEqual(first.tickets.map((candidate) => candidate.issue.number), [101, 103]);
  assert.deepEqual(
    first.layers.map((layer) => layer.map((candidate) => candidate.issue.number)),
    [[101], [103]],
  );
  assert.deepEqual(projected.orphans.map((candidate) => candidate.issue.number), [401]);
  assert.equal(first.resolved, 2);
  assert.equal(first.total, 4);
});

test("projectView never mutates source models, maps, tickets, or arrays", () => {
  const source = model();
  const before = structuredClone(source);
  const sourceMaps = source.maps;
  const sourceTickets = source.maps[0].tickets;
  const sourceLayers = source.maps[0].layers;
  const projection = projectView(source, {
    ...defaults,
    incompleteTicketsOnly: true,
  });

  assert.deepEqual(source, before);
  assert.strictEqual(source.maps, sourceMaps);
  assert.strictEqual(source.maps[0].tickets, sourceTickets);
  assert.strictEqual(source.maps[0].layers, sourceLayers);
  assert.notStrictEqual(projection.model.maps, sourceMaps);
  assert.notStrictEqual(projection.model.maps[0].tickets, sourceTickets);
  assert.strictEqual(projection.model.maps[0].tickets[0], sourceTickets[0]);
});

test("actionability grouping preserves fail-closed unverified behavior", () => {
  const tickets = [
    ticket("owner/one", 1, { frontier: true }),
    ticket("owner/one", 2, { claimed: true }),
    ticket("owner/one", 3, { blocked: true }),
    ticket("owner/one", 4, { unverified: true }),
    ticket("owner/one", 5, { state: "closed" }),
  ];
  const groups = groupTicketsByActionability(tickets);

  assert.deepEqual(
    groups.map((group) => [group.label, group.tickets.map((item) => item.issue.number)]),
    [
      ["Takeable", [1]],
      ["Claimed", [2]],
      ["Blocked", [3, 4]],
      ["Resolved", [5]],
    ],
  );
});

test("incomplete projection leaves no tickets in the Resolved group", () => {
  const projected = projectView(model(), {
    ...defaults,
    incompleteTicketsOnly: true,
  }).model;
  const resolved = groupTicketsByActionability(projected.maps[0].tickets).find(
    (group) => group.label === "Resolved",
  );

  assert.deepEqual(resolved?.tickets, []);
});
