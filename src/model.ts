/**
 * Pure data model for wayfinder trees — no Obsidian imports so it can be
 * smoke-tested with plain Node against the real GitHub API.
 *
 * Semantics (from the wayfinder skill, ~/.agents/skills/wayfinder/SKILL.md):
 *  - A map is an issue labeled `wayfinder:map`; tickets are child issues
 *    whose body contains "Part of #<map>".
 *  - Ticket type is the `wayfinder:*` label. Mode is derived:
 *    research=AFK, prototype/grilling=HITL, task=either (disambiguated by
 *    ready-for-agent / ready-for-human triage labels).
 *  - Blocking uses GitHub's native issue dependencies. The frontier is the
 *    open, unblocked, unassigned tickets.
 */

export type TicketType = "grilling" | "research" | "prototype" | "task";
export type Mode = "AFK" | "HITL" | "either";

export interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string | null;
  labels: string[];
  assignees: string[];
  html_url: string;
  updated_at: string;
}

export interface DepEntry {
  updatedAt: string;
  blockedBy: number[];
  unverified?: true;
}

export interface Snapshot {
  fetchedAt: number;
  issues: RawIssue[];
  deps: Record<string, DepEntry>;
  /** child issue number -> map issue number, from GitHub native sub-issues */
  parents: Record<string, number>;
}

export interface Ticket {
  issue: RawIssue;
  type: TicketType;
  mode: Mode;
  parent: number | null;
  blockedBy: number[];
  openBlockers: number[];
  unverified: boolean;
  frontier: boolean;
  layer: number;
}

export interface MapTree {
  issue: RawIssue;
  tickets: Ticket[];
  layers: Ticket[][];
  resolved: number;
  total: number;
}

export interface Tally {
  open: number;
  total: number;
}

export interface Model {
  maps: MapTree[];
  orphans: Ticket[];
  tallies: { type: "map" | TicketType; tally: Tally }[];
  totalIssues: number;
  totalOpen: number;
  fetchedAt: number;
}

const TYPES: TicketType[] = ["grilling", "research", "prototype", "task"];

export function wayfinderType(labels: string[]): "map" | TicketType | null {
  for (const l of labels) {
    if (!l.startsWith("wayfinder:")) continue;
    const t = l.slice("wayfinder:".length);
    if (t === "map" || (TYPES as string[]).includes(t)) return t as "map" | TicketType;
  }
  return null;
}

export function parentOf(body: string | null): number | null {
  const m = body?.match(/part of #(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

export function modeOf(type: TicketType, labels: string[]): Mode {
  if (type === "research") return "AFK";
  if (type === "prototype" || type === "grilling") return "HITL";
  if (labels.includes("ready-for-agent")) return "AFK";
  if (labels.includes("ready-for-human")) return "HITL";
  return "either";
}

/** The ticket body minus the "Part of #N" line — used for hover excerpts. */
export function descriptionOf(body: string | null): string {
  if (!body) return "";
  return body
    .replace(/^\s*part of #\d+\s*$/gim, "")
    .replace(/^#+\s*question\s*$/gim, "")
    .replace(/^#+\s*destination\s*$/gim, "")
    .trim();
}

export function buildModel(snap: Snapshot): Model {
  const byNumber = new Map(snap.issues.map((i) => [i.number, i]));
  const mapIssues = snap.issues.filter((i) => wayfinderType(i.labels) === "map");
  const mapNumbers = new Set(mapIssues.map((i) => i.number));

  const tickets: Ticket[] = [];
  for (const issue of snap.issues) {
    const type = wayfinderType(issue.labels);
    if (!type || type === "map") continue;
    const dep = snap.deps[String(issue.number)];
    const blockedBy = dep?.blockedBy ?? [];
    const openBlockers = blockedBy.filter((n) => byNumber.get(n)?.state === "open");
    const unverified = dep?.unverified === true;
    tickets.push({
      issue,
      type,
      mode: modeOf(type, issue.labels),
      parent: snap.parents?.[String(issue.number)] ?? parentOf(issue.body),
      blockedBy,
      openBlockers,
      unverified,
      frontier:
        !unverified &&
        issue.state === "open" &&
        openBlockers.length === 0 &&
        issue.assignees.length === 0,
      layer: 0,
    });
  }

  const byMap = new Map<number, Ticket[]>();
  const orphans: Ticket[] = [];
  for (const t of tickets) {
    if (t.parent !== null && mapNumbers.has(t.parent)) {
      let arr = byMap.get(t.parent);
      if (!arr) byMap.set(t.parent, (arr = []));
      arr.push(t);
    } else {
      orphans.push(t);
    }
  }

  const maps: MapTree[] = mapIssues.map((issue) => {
    const kids = (byMap.get(issue.number) ?? []).sort((a, b) => a.issue.number - b.issue.number);
    assignLayers(kids);
    const layers: Ticket[][] = [];
    for (const t of kids) (layers[t.layer] ??= []).push(t);
    orderWithinLayers(layers);
    return {
      issue,
      tickets: kids,
      layers,
      resolved: kids.filter((t) => t.issue.state === "closed").length,
      total: kids.length,
    };
  });

  // Open maps first, newest effort on top; then closed maps, newest first.
  maps.sort((a, b) => {
    if (a.issue.state !== b.issue.state) return a.issue.state === "open" ? -1 : 1;
    return b.issue.number - a.issue.number;
  });

  const tallyMap = new Map<"map" | TicketType, Tally>([
    ["map", { open: 0, total: 0 }],
    ...TYPES.map((t): ["map" | TicketType, Tally] => [t, { open: 0, total: 0 }]),
  ]);
  let totalOpen = 0;
  for (const issue of snap.issues) {
    if (issue.state === "open") totalOpen++;
    const type = wayfinderType(issue.labels);
    if (!type) continue;
    const tally = tallyMap.get(type)!;
    tally.total++;
    if (issue.state === "open") tally.open++;
  }

  return {
    maps,
    orphans: orphans.sort((a, b) => b.issue.number - a.issue.number),
    tallies: [...tallyMap.entries()].map(([type, tally]) => ({ type, tally })),
    totalIssues: snap.issues.length,
    totalOpen,
    fetchedAt: snap.fetchedAt,
  };
}

/** Longest-path layering over in-map blocking edges, with a cycle guard. */
function assignLayers(tickets: Ticket[]): void {
  const inMap = new Map(tickets.map((t) => [t.issue.number, t]));
  const memo = new Map<number, number>();
  const visiting = new Set<number>();

  const layerOf = (t: Ticket): number => {
    const cached = memo.get(t.issue.number);
    if (cached !== undefined) return cached;
    if (visiting.has(t.issue.number)) return 0; // cycle — flatten rather than crash
    visiting.add(t.issue.number);
    let layer = 0;
    for (const b of t.blockedBy) {
      const blocker = inMap.get(b);
      if (blocker) layer = Math.max(layer, layerOf(blocker) + 1);
    }
    visiting.delete(t.issue.number);
    memo.set(t.issue.number, layer);
    return layer;
  };

  for (const t of tickets) t.layer = layerOf(t);
}

/** Sort each layer so children sit near the mean position of their blockers. */
function orderWithinLayers(layers: Ticket[][]): void {
  const pos = new Map<number, number>();
  layers[0]?.forEach((t, i) => pos.set(t.issue.number, i));
  for (let l = 1; l < layers.length; l++) {
    const layer = layers[l];
    if (!layer) continue;
    const key = (t: Ticket): number => {
      const ps = t.blockedBy.map((b) => pos.get(b)).filter((p): p is number => p !== undefined);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : t.issue.number;
    };
    layer.sort((a, b) => key(a) - key(b) || a.issue.number - b.issue.number);
    layer.forEach((t, i) => pos.set(t.issue.number, i));
  }
}
