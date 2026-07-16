import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubClient,
  classifyError,
  fetchSnapshot,
  type Http,
  type HttpResponse,
} from "../src/github";
import type { RawIssue, Snapshot } from "../src/model";

const okHeaders: Record<string, string> = {};

function response(status: number, json: unknown, headers = okHeaders): HttpResponse {
  return { status, headers, json };
}

function rawIssue(
  number: number,
  labels: string[] = ["wayfinder:task"],
  options: Partial<RawIssue> = {},
): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    body: null,
    labels: labels.map((name) => ({ name })),
    assignees: [],
    html_url: `https://github.test/issues/${number}`,
    updated_at: "2026-01-01T00:00:00Z",
    ...options,
  };
}

function client(http: Http, repo = "owner/repo"): GitHubClient {
  return new GitHubClient(() => ({ token: "secret", repo }), http);
}

test("listAllIssues paginates, filters pull requests, and stops on a short page", async () => {
  const urls: string[] = [];
  const first = Array.from({ length: 100 }, (_, index) => rawIssue(index + 1));
  first[5] = { ...first[5], pull_request: {} };
  const http: Http = async (url) => {
    urls.push(url);
    return response(
      200,
      new URL(url).searchParams.get("page") === "1" ? first : [rawIssue(101)],
    );
  };

  const result = await client(http).listAllIssues();

  assert.equal(result.issues.length, 100);
  assert.equal(result.truncated, false);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /per_page=100&page=2$/);
});

test("listAllIssues marks a full 5000-issue cap as truncated", async () => {
  let calls = 0;
  const page = Array.from({ length: 100 }, (_, index) => rawIssue(index + 1));
  const result = await client(async () => {
    calls++;
    return response(200, page);
  }).listAllIssues();

  assert.equal(result.issues.length, 5000);
  assert.equal(result.truncated, true);
  assert.equal(calls, 50);
});

test("blockedBy, subIssues, and comments paginate independently", async () => {
  const urls: string[] = [];
  const hundredNumbers = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    state: "open",
    repository: { full_name: index === 0 ? "other/repo" : "owner/repo" },
  }));
  const hundredComments = Array.from({ length: 100 }, (_, index) => ({
    user: { login: `user-${index}` },
    created_at: "2026-01-01T00:00:00Z",
    body: `comment-${index}`,
  }));
  const http: Http = async (url) => {
    urls.push(url);
    const second = url.includes("page=2");
    if (url.includes("dependencies/blocked_by")) {
      return response(
        200,
        second
          ? [{ number: 101, state: "closed", repository: { full_name: "owner/repo" } }]
          : hundredNumbers,
      );
    }
    if (url.includes("sub_issues")) {
      return response(200, second ? [{ number: 201 }] : hundredNumbers);
    }
    return response(
      200,
      second
        ? [{ user: null, created_at: "2026-01-02T00:00:00Z", body: null }]
        : hundredComments,
    );
  };
  const gh = client(http);

  const blockers = await gh.blockedBy(7);
  assert.equal(blockers?.length, 101);
  assert.deepEqual(blockers?.[0], { number: 1, state: "open", repo: "other/repo" });
  assert.deepEqual(blockers?.at(-1), { number: 101, state: "closed" });
  assert.equal((await gh.subIssues(7))?.at(-1), 201);
  const comments = await gh.comments(7);
  assert.equal(comments.length, 101);
  assert.deepEqual(comments.at(-1), {
    author: "unknown",
    createdAt: "2026-01-02T00:00:00Z",
    body: "",
  });
  assert.equal(urls.filter((url) => url.includes("page=2")).length, 3);
});

test("dependency 404 maps to empty while sub-issue 404 and other failures map to null", async () => {
  const statuses = [404, 500, 404, 403];
  const gh = client(async () => response(statuses.shift()!, []));

  assert.deepEqual(await gh.blockedBy(1), []);
  assert.equal(await gh.blockedBy(2), null);
  assert.equal(await gh.subIssues(3), null);
  assert.equal(await gh.subIssues(4), null);
});

test("classifyError covers authentication, rate limits, permissions, missing repos, and servers", () => {
  assert.equal(
    classifyError(401, {}),
    "GitHub token is invalid or expired — replace it in Settings → Wayfinder.",
  );
  assert.match(
    classifyError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }),
    /^GitHub rate limit hit — resets at .+\.$/,
  );
  assert.equal(
    classifyError(403, {}),
    "Token lacks permission for this repo (needs read-only Issues).",
  );
  assert.equal(
    classifyError(403, { "retry-after": "30" }),
    "GitHub is rate limiting requests — retry in 30s.",
  );
  assert.equal(
    classifyError(403, {}, "You have exceeded a secondary rate limit"),
    "GitHub is rate limiting requests — retry shortly.",
  );
  assert.equal(
    classifyError(403, {}, "Abuse detection mechanism triggered"),
    "GitHub is rate limiting requests — retry shortly.",
  );
  assert.equal(
    classifyError(429, {}),
    "GitHub is rate limiting requests — retry shortly.",
  );
  assert.equal(
    classifyError(404, {}),
    "Repo not found (check owner/name) or token has no access to it.",
  );
  assert.equal(
    classifyError(500, {}),
    "GitHub is having problems (HTTP 500) — will retry on next sync.",
  );
});

test("testConnection rejects when the repo is visible but Issues are not readable", async () => {
  const gh = client(async (url) => {
    if (url.endsWith("/owner/repo")) return response(200, { full_name: "owner/repo" });
    if (url.includes("/issues?state=all&per_page=1")) {
      return response(403, { message: "Resource not accessible by personal access token" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  await assert.rejects(
    () => gh.testConnection(),
    /Token lacks permission for this repo \(needs read-only Issues\)\./,
  );
});

test("fetchSnapshot reuses unchanged dependency entries and preserves incremental full-sync time", async () => {
  const calls: string[] = [];
  const previousDependency = {
    updatedAt: "2026-01-01T00:00:00Z",
    blockedBy: [{ number: 41 }],
  };
  const prev: Snapshot = {
    schemaVersion: 2,
    repo: "old/repo",
    fetchedAt: 10,
    lastFullSync: 5,
    issues: [],
    deps: { "42": previousDependency },
    parents: { "42": 7 },
  };
  const http: Http = async (url) => {
    calls.push(url);
    if (url.includes("/issues?")) {
      return response(200, [rawIssue(7, ["wayfinder:map"]), rawIssue(42)]);
    }
    if (url.includes("/sub_issues")) return response(200, [{ number: 42 }]);
    throw new Error(`Unexpected request: ${url}`);
  };

  const before = Date.now();
  const snap = await fetchSnapshot(client(http, "new/repo"), prev, false);
  const after = Date.now();

  assert.equal(calls.some((url) => url.includes("/dependencies/")), false);
  assert.strictEqual(snap.deps["42"], previousDependency);
  assert.deepEqual(snap.parents, { "42": 7 });
  assert.equal(snap.repo, "new/repo");
  assert.equal(snap.schemaVersion, 2);
  assert.equal(snap.lastFullSync, 5);
  assert.ok(snap.fetchedAt >= before && snap.fetchedAt <= after);
});

test("fetchSnapshot records a new unverified dependency when no prior entry exists", async () => {
  const warnings: string[] = [];
  const http: Http = async (url) => {
    if (url.includes("/issues?")) return response(200, [rawIssue(42)]);
    if (url.includes("/dependencies/")) return response(500, []);
    throw new Error(`Unexpected request: ${url}`);
  };

  const snap = await fetchSnapshot(client(http), null, false, (message) => warnings.push(message));

  assert.deepEqual(snap.deps["42"], { updatedAt: "", blockedBy: [], unverified: true });
  assert.equal(snap.lastFullSync, snap.fetchedAt);
  assert.deepEqual(warnings, [
    "Couldn't verify blockers for 1 ticket(s) — shown as unverified (GitHub is having problems (HTTP 500) — will retry on next sync.)",
  ]);
});

test("fetchSnapshot preserves cached edges as unverified after a dependency failure", async () => {
  const prev: Snapshot = {
    schemaVersion: 2,
    repo: "owner/repo",
    fetchedAt: 10,
    issues: [],
    deps: {
      "42": { updatedAt: "old", blockedBy: [{ number: 41, state: "open" }] },
    },
    parents: {},
  };
  const snap = await fetchSnapshot(
    client(async (url) => {
      if (url.includes("/issues?")) {
        return response(200, [rawIssue(42, undefined, { updated_at: "new" })]);
      }
      if (url.includes("/dependencies/")) return response(500, { message: "server error" });
      throw new Error(`Unexpected request: ${url}`);
    }),
    prev,
    false,
  );

  assert.deepEqual(snap.deps["42"], {
    updatedAt: "old",
    blockedBy: [{ number: 41, state: "open" }],
    unverified: true,
  });
});

test("fetchSnapshot retries an unchanged cached dependency when it is unverified", async () => {
  let dependencyCalls = 0;
  const prev: Snapshot = {
    schemaVersion: 2,
    repo: "owner/repo",
    fetchedAt: 10,
    issues: [],
    deps: {
      "42": {
        updatedAt: "2026-01-01T00:00:00Z",
        blockedBy: [{ number: 41 }],
        unverified: true,
      },
    },
    parents: {},
  };
  const snap = await fetchSnapshot(
    client(async (url) => {
      if (url.includes("/issues?")) return response(200, [rawIssue(42)]);
      if (url.includes("/dependencies/")) {
        dependencyCalls++;
        return response(200, [
          { number: 43, state: "open", repository: { full_name: "owner/repo" } },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
    prev,
    false,
  );

  assert.equal(dependencyCalls, 1);
  assert.deepEqual(snap.deps["42"], {
    updatedAt: "2026-01-01T00:00:00Z",
    blockedBy: [{ number: 43, state: "open" }],
  });
});

test("fetchSnapshot warns when only some dependency lookups fail", async () => {
  const warnings: string[] = [];
  const snap = await fetchSnapshot(
    client(async (url) => {
      if (url.includes("/issues?")) return response(200, [rawIssue(41), rawIssue(42)]);
      if (url.includes("/issues/41/dependencies/")) return response(200, []);
      if (url.includes("/issues/42/dependencies/")) {
        return response(403, { message: "forbidden" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
    null,
    false,
    (message) => warnings.push(message),
  );

  assert.deepEqual(snap.deps["41"].blockedBy, []);
  assert.equal(snap.deps["42"].unverified, true);
  assert.deepEqual(warnings, [
    "Couldn't verify blockers for 1 ticket(s) — shown as unverified (Token lacks permission for this repo (needs read-only Issues).)",
  ]);
});

test("fetchSnapshot carries parent links forward when a map sub-issue lookup fails", async () => {
  const prev: Snapshot = {
    schemaVersion: 2,
    repo: "owner/repo",
    fetchedAt: 10,
    lastFullSync: 5,
    issues: [],
    deps: { "42": { updatedAt: "2026-01-01T00:00:00Z", blockedBy: [] } },
    parents: { "42": 7, "99": 8 },
  };
  const http: Http = async (url) => {
    if (url.includes("/issues?")) {
      return response(200, [rawIssue(7, ["wayfinder:map"]), rawIssue(42)]);
    }
    if (url.includes("/sub_issues")) return response(500, []);
    throw new Error(`Unexpected request: ${url}`);
  };

  const warnings: string[] = [];
  const snap = await fetchSnapshot(client(http), prev, false, (message) => warnings.push(message));

  assert.deepEqual(snap.parents, { "42": 7 });
  assert.deepEqual(warnings, [
    "Couldn't refresh sub-issues for 1 map(s) — tree structure may be stale",
  ]);
});

test("fetchSnapshot warns on one failed map and preserves only that map's previous parents", async () => {
  const prev: Snapshot = {
    schemaVersion: 2,
    repo: "owner/repo",
    fetchedAt: 10,
    issues: [],
    deps: {},
    parents: { "41": 7, "42": 8, "99": 9 },
  };
  const warnings: string[] = [];
  const snap = await fetchSnapshot(
    client(async (url) => {
      if (url.includes("/issues?")) {
        return response(200, [
          rawIssue(7, ["wayfinder:map"]),
          rawIssue(8, ["wayfinder:map"]),
        ]);
      }
      if (url.includes("/issues/7/sub_issues")) return response(500, []);
      if (url.includes("/issues/8/sub_issues")) return response(200, [{ number: 43 }]);
      throw new Error(`Unexpected request: ${url}`);
    }),
    prev,
    false,
    (message) => warnings.push(message),
  );

  assert.deepEqual(snap.parents, { "41": 7, "43": 8 });
  assert.deepEqual(warnings, [
    "Couldn't refresh sub-issues for 1 map(s) — tree structure may be stale",
  ]);
});

test("fetchSnapshot replaces lastFullSync when a full refresh is requested", async () => {
  const prev: Snapshot = {
    schemaVersion: 2,
    repo: "owner/repo",
    fetchedAt: 10,
    lastFullSync: 5,
    issues: [],
    deps: {},
    parents: {},
  };
  const snap = await fetchSnapshot(
    client(async (url) => {
      if (url.includes("/issues?")) return response(200, []);
      throw new Error(`Unexpected request: ${url}`);
    }),
    prev,
    true,
  );

  assert.equal(snap.lastFullSync, snap.fetchedAt);
  assert.ok(snap.lastFullSync > 5);
});
