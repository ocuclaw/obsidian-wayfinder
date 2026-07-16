/**
 * GitHub REST client. HTTP transport is injected so the plugin can use
 * Obsidian's CORS-exempt requestUrl while tests use plain fetch.
 */

import type { DepEntry, RawIssue, Snapshot } from "./model";
import { wayfinderType } from "./model";

export interface HttpResponse {
  status: number;
  json: unknown;
}

export type Http = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface GitHubConfig {
  token: string;
  repo: string; // "owner/name"
}

const API = "https://api.github.com";

export class GitHubClient {
  constructor(private config: () => GitHubConfig, private http: Http) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config().token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async get(path: string): Promise<HttpResponse> {
    return this.http(`${API}/repos/${this.config().repo}${path}`, this.headers());
  }

  async listAllIssues(): Promise<RawIssue[]> {
    const issues: RawIssue[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.get(`/issues?state=all&per_page=100&page=${page}`);
      if (res.status !== 200) {
        throw new Error(`GitHub issues list failed (HTTP ${res.status}) — check token and repo`);
      }
      const batch = res.json as Record<string, unknown>[];
      for (const raw of batch) {
        if ("pull_request" in raw) continue;
        issues.push(toRawIssue(raw));
      }
      if (batch.length < 100) break;
    }
    return issues;
  }

  /** Fetch a single issue fresh — used for pre-action claim checks. */
  async issue(issueNumber: number): Promise<RawIssue | null> {
    const res = await this.get(`/issues/${issueNumber}`);
    if (res.status !== 200) return null;
    return toRawIssue(res.json as Record<string, unknown>);
  }

  async blockedBy(issueNumber: number): Promise<number[] | null> {
    const res = await this.get(`/issues/${issueNumber}/dependencies/blocked_by?per_page=100`);
    if (res.status === 404) return [];
    if (res.status !== 200) return null;
    return (res.json as { number: number }[]).map((i) => i.number);
  }

  async subIssues(issueNumber: number): Promise<number[] | null> {
    const res = await this.get(`/issues/${issueNumber}/sub_issues?per_page=100`);
    if (res.status === 404) return [];
    if (res.status !== 200) return null;
    return (res.json as { number: number }[]).map((i) => i.number);
  }

  async comments(issueNumber: number): Promise<IssueComment[]> {
    const res = await this.get(`/issues/${issueNumber}/comments?per_page=100`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return (res.json as Record<string, unknown>[]).map((c) => ({
      author: (c.user as { login: string } | null)?.login ?? "unknown",
      createdAt: c.created_at as string,
      body: (c.body as string | null) ?? "",
    }));
  }
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

function toRawIssue(raw: Record<string, unknown>): RawIssue {
  return {
    number: raw.number as number,
    title: raw.title as string,
    state: raw.state as "open" | "closed",
    body: (raw.body as string | null) ?? null,
    labels: ((raw.labels as { name: string }[]) ?? []).map((l) => l.name),
    assignees: ((raw.assignees as { login: string }[]) ?? []).map((a) => a.login),
    html_url: raw.html_url as string,
    updated_at: raw.updated_at as string,
  };
}

/**
 * Fetch a full snapshot. Dependency lookups are the expensive part (one
 * request per ticket), so entries are reused from `prev` when the issue's
 * updated_at hasn't moved — unless `full` forces a re-fetch of everything.
 */
export async function fetchSnapshot(
  gh: GitHubClient,
  prev: Snapshot | null,
  full: boolean,
): Promise<Snapshot> {
  const issues = await gh.listAllIssues();
  const targets = issues.filter((i) => {
    const t = wayfinderType(i.labels);
    return t !== null && t !== "map";
  });

  // Native sub-issues are the canonical parent relationship ("Part of #N" in
  // the body is only a fallback). One request per map — always fresh.
  const parents: Record<string, number> = {};
  const maps = issues.filter((i) => wayfinderType(i.labels) === "map");
  for (const map of maps) {
    const children = await gh.subIssues(map.number);
    if (children === null) {
      for (const [child, parent] of Object.entries(prev?.parents ?? {})) {
        if (parent === map.number) parents[child] = parent;
      }
      continue;
    }
    for (const child of children) {
      parents[String(child)] = map.number;
    }
  }

  const deps: Record<string, DepEntry> = {};
  const stale = targets.filter((i) => {
    const prevDep = prev?.deps[String(i.number)];
    if (!full && prevDep && prevDep.updatedAt === i.updated_at) {
      deps[String(i.number)] = prevDep;
      return false;
    }
    return true;
  });

  // Small concurrency pool — polite to the API, fast enough for ~60 tickets.
  const queue = [...stale];
  const workers = Array.from({ length: 10 }, async () => {
    for (let issue = queue.shift(); issue; issue = queue.shift()) {
      const key = String(issue.number);
      const blockedBy = await gh.blockedBy(issue.number);
      deps[key] =
        blockedBy === null
          ? (prev?.deps[key] ?? { updatedAt: "", blockedBy: [], unverified: true })
          : { updatedAt: issue.updated_at, blockedBy };
    }
  });
  await Promise.all(workers);

  return { fetchedAt: Date.now(), issues, deps, parents };
}
