import "server-only"; // GitHub API access is server-only; uses secrets and Node fetch.

const GITHUB_API_VERSION = "2022-11-28";

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to call the GitHub API.");
  }
  return token;
}

export class GithubHttpError extends Error {
  status: number;
  headers: Headers;
  bodyText: string;

  constructor(message: string, status: number, headers: Headers, bodyText: string) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.bodyText = bodyText;
  }

  get rateLimitRemaining() {
    return this.headers.get("x-ratelimit-remaining");
  }

  get rateLimitReset() {
    return this.headers.get("x-ratelimit-reset");
  }
}

type GithubFetchResult<T> = {
  status: number;
  data: T;
  headers: Headers;
};

export async function githubFetchJson<T>(url: string): Promise<GithubFetchResult<T>> {
  const token = getToken();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "impact-dashboard/ingest",
    },
  });

  const { status, statusText, headers } = response;

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable body>");
    const rateRemaining = headers.get("x-ratelimit-remaining");
    const rateReset = headers.get("x-ratelimit-reset");
    const detailParts = [
      `GitHub request failed (${status} ${statusText})`,
      `url=${url}`,
      bodyText ? `body=${bodyText}` : null,
      rateRemaining ? `x-ratelimit-remaining=${rateRemaining}` : null,
      rateReset ? `x-ratelimit-reset=${rateReset}` : null,
    ].filter(Boolean);
    throw new GithubHttpError(detailParts.join(" | "), status, headers, bodyText);
  }

  const data = (await response.json()) as T;
  return { status, data, headers };
}
