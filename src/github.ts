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
        issues.push({
          number: raw.number as number,
          title: raw.title as string,
          state: raw.state as "open" | "closed",
          body: (raw.body as string | null) ?? null,
          labels: ((raw.labels as { name: string }[]) ?? []).map((l) => l.name),
          assignees: ((raw.assignees as { login: string }[]) ?? []).map((a) => a.login),
          html_url: raw.html_url as string,
          updated_at: raw.updated_at as string,
        });
      }
      if (batch.length < 100) break;
    }
    return issues;
  }

  async blockedBy(issueNumber: number): Promise<number[]> {
    const res = await this.get(`/issues/${issueNumber}/dependencies/blocked_by?per_page=100`);
    if (res.status !== 200) return []; // dependencies API missing/empty — treat as unblocked
    return (res.json as { number: number }[]).map((i) => i.number);
  }

  async subIssues(issueNumber: number): Promise<number[]> {
    const res = await this.get(`/issues/${issueNumber}/sub_issues?per_page=100`);
    if (res.status !== 200) return [];
    return (res.json as { number: number }[]).map((i) => i.number);
  }
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
    for (const child of await gh.subIssues(map.number)) {
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
  const workers = Array.from({ length: 5 }, async () => {
    for (let issue = queue.shift(); issue; issue = queue.shift()) {
      deps[String(issue.number)] = {
        updatedAt: issue.updated_at,
        blockedBy: await gh.blockedBy(issue.number),
      };
    }
  });
  await Promise.all(workers);

  return { fetchedAt: Date.now(), issues, deps, parents };
}
