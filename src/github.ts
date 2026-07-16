/**
 * GitHub REST client. HTTP transport is injected so the plugin can use
 * Obsidian's CORS-exempt requestUrl while tests use plain fetch.
 */

import type { BlockerRef, DepEntry, RawIssue, Snapshot } from "./model";
import { wayfinderType } from "./model";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

export type Http = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface GitHubConfig {
  token: string;
  repo: string; // "owner/name"
}

const API = "https://api.github.com";

export function classifyError(
  status: number,
  headers: Record<string, string>,
  message?: string,
): string {
  if (status === 401) {
    return "GitHub token is invalid or expired — replace it in Settings → Wayfinder.";
  }
  if (
    (status === 403 || status === 429) &&
    headers["x-ratelimit-remaining"]?.trim() === "0"
  ) {
    const resetSeconds = Number(headers["x-ratelimit-reset"]);
    const resetTime = Number.isFinite(resetSeconds)
      ? new Date(resetSeconds * 1000).toLocaleString()
      : "an unknown time";
    return `GitHub rate limit hit — resets at ${resetTime}.`;
  }
  if (status === 429) {
    return "GitHub is rate limiting requests — retry shortly.";
  }
  if (
    status === 403 &&
    (headers["retry-after"] !== undefined || /secondary rate limit|abuse/i.test(message ?? ""))
  ) {
    const retryAfter = headers["retry-after"]?.trim();
    return retryAfter
      ? `GitHub is rate limiting requests — retry in ${retryAfter}s.`
      : "GitHub is rate limiting requests — retry shortly.";
  }
  if (status === 403) {
    return "Token lacks permission for this repo (needs read-only Issues).";
  }
  if (status === 404) {
    return "Repo not found (check owner/name) or token has no access to it.";
  }
  if (status >= 500 && status <= 599) {
    return `GitHub is having problems (HTTP ${status}) — will retry on next sync.`;
  }
  return `GitHub request failed (HTTP ${status}).`;
}

export interface IssueListResult {
  issues: RawIssue[];
  truncated: boolean;
}

export class GitHubClient {
  private dependencyErrorMessage: string | null = null;

  constructor(private config: () => GitHubConfig, private http: Http) {}

  get repo(): string {
    return this.config().repo;
  }

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

  async listAllIssues(): Promise<IssueListResult> {
    const issues: RawIssue[] = [];
    let truncated = false;
    for (let page = 1; page <= 50; page++) {
      const res = await this.get(`/issues?state=all&per_page=100&page=${page}`);
      if (res.status !== 200) {
        throw new Error(classifyError(res.status, res.headers, responseMessage(res.json)));
      }
      const batch = res.json as Record<string, unknown>[];
      for (const raw of batch) {
        if ("pull_request" in raw) continue;
        issues.push(toRawIssue(raw));
      }
      if (batch.length < 100) break;
      if (page === 50) truncated = true;
    }
    return { issues, truncated };
  }

  async testConnection(): Promise<string> {
    const res = await this.get("");
    if (res.status !== 200) {
      throw new Error(classifyError(res.status, res.headers, responseMessage(res.json)));
    }
    const fullName = (res.json as { full_name: string }).full_name;
    const issues = await this.get("/issues?state=all&per_page=1");
    if (issues.status !== 200) {
      throw new Error(
        classifyError(issues.status, issues.headers, responseMessage(issues.json)),
      );
    }
    return fullName;
  }

  /** Fetch a single issue fresh — used for pre-action claim checks. */
  async issue(issueNumber: number): Promise<RawIssue | null> {
    const res = await this.get(`/issues/${issueNumber}`);
    if (res.status !== 200) return null;
    return toRawIssue(res.json as Record<string, unknown>);
  }

  async blockedBy(issueNumber: number): Promise<BlockerRef[] | null> {
    const issues: BlockerRef[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.get(
        `/issues/${issueNumber}/dependencies/blocked_by?per_page=100&page=${page}`,
      );
      if (res.status === 404) return [];
      if (res.status !== 200) {
        this.dependencyErrorMessage ??= classifyError(
          res.status,
          res.headers,
          responseMessage(res.json),
        );
        return null;
      }
      const batch = res.json as {
        number: number;
        state?: string;
        repository?: { full_name?: string } | null;
      }[];
      issues.push(
        ...batch.map((issue) => {
          const ref: BlockerRef = { number: issue.number };
          if (issue.state === "open" || issue.state === "closed") ref.state = issue.state;
          const repo = issue.repository?.full_name;
          if (repo && repo !== this.repo) ref.repo = repo;
          return ref;
        }),
      );
      if (batch.length < 100) break;
    }
    return issues;
  }

  async subIssues(issueNumber: number): Promise<number[] | null> {
    const issues: number[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.get(`/issues/${issueNumber}/sub_issues?per_page=100&page=${page}`);
      if (res.status === 404) return null;
      if (res.status !== 200) return null;
      const batch = res.json as { number: number }[];
      issues.push(...batch.map((i) => i.number));
      if (batch.length < 100) break;
    }
    return issues;
  }

  async comments(issueNumber: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.get(`/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      if (res.status !== 200) {
        throw new Error(classifyError(res.status, res.headers, responseMessage(res.json)));
      }
      const batch = res.json as Record<string, unknown>[];
      comments.push(
        ...batch.map((c) => ({
          author: (c.user as { login: string } | null)?.login ?? "unknown",
          createdAt: c.created_at as string,
          body: (c.body as string | null) ?? "",
        })),
      );
      if (batch.length < 100) break;
    }
    return comments;
  }

  resetDependencyErrors(): void {
    this.dependencyErrorMessage = null;
  }

  dependencyError(): string | null {
    return this.dependencyErrorMessage;
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

function responseMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object" || !("message" in json)) return undefined;
  const message = (json as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
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
  onWarning?: (message: string) => void,
): Promise<Snapshot> {
  const { issues, truncated } = await gh.listAllIssues();
  if (truncated) onWarning?.("Repo has more than 5000 issues — view may be incomplete");
  const targets = issues.filter((i) => {
    const t = wayfinderType(i.labels);
    return t !== null && t !== "map";
  });

  // Native sub-issues are the canonical parent relationship ("Part of #N" in
  // the body is only a fallback). One request per map — always fresh.
  const parents: Record<string, number> = {};
  const maps = issues.filter((i) => wayfinderType(i.labels) === "map");
  let subIssueFailures = 0;
  for (const map of maps) {
    const children = await gh.subIssues(map.number);
    if (children === null) {
      subIssueFailures++;
      for (const [child, parent] of Object.entries(prev?.parents ?? {})) {
        if (parent === map.number) parents[child] = parent;
      }
      continue;
    }
    for (const child of children) {
      parents[String(child)] = map.number;
    }
  }
  if (subIssueFailures > 0) {
    onWarning?.(
      `Couldn't refresh sub-issues for ${subIssueFailures} map(s) — tree structure may be stale`,
    );
  }

  const deps: Record<string, DepEntry> = {};
  const stale = targets.filter((i) => {
    const prevDep = prev?.deps[String(i.number)];
    if (!full && prevDep && !prevDep.unverified && prevDep.updatedAt === i.updated_at) {
      deps[String(i.number)] = prevDep;
      return false;
    }
    return true;
  });

  // Small concurrency pool — polite to the API, fast enough for ~60 tickets.
  gh.resetDependencyErrors();
  let dependencyFailures = 0;
  const queue = [...stale];
  const workers = Array.from({ length: 10 }, async () => {
    for (let issue = queue.shift(); issue; issue = queue.shift()) {
      const key = String(issue.number);
      const blockedBy = await gh.blockedBy(issue.number);
      if (blockedBy === null) dependencyFailures++;
      deps[key] =
        blockedBy === null
          ? { ...(prev?.deps[key] ?? { updatedAt: "", blockedBy: [] }), unverified: true }
          : { updatedAt: issue.updated_at, blockedBy };
    }
  });
  await Promise.all(workers);

  if (dependencyFailures > 0) {
    const message = gh.dependencyError();
    onWarning?.(
      `Couldn't verify blockers for ${dependencyFailures} ticket(s) — shown as unverified${
        message ? ` (${message})` : ""
      }`,
    );
  }

  const fetchedAt = Date.now();
  return {
    schemaVersion: 2,
    repo: gh.repo,
    fetchedAt,
    lastFullSync: full || !prev ? fetchedAt : prev.lastFullSync,
    issues,
    deps,
    parents,
  };
}
