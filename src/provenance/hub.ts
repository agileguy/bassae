// Hugging Face Hub names: repo ids, pinned revisions and huggingface.co model URLs.
// Everything that becomes part of a hub URL is checked here first, and the
// same check decides which `general.*` hints count as repo ids at all.

// huggingface_hub v2.2.0 (acfdf30d), utils/_validators.py validate_repo_id: ASCII
// [A-Za-z0-9_.-], each part 1 to 96 long and starting and ending on a word
// character, no "--" or "..", no ".git" suffix. bassae also requires the
// namespace, because a pinned upstream is always org/name.
const REPO_PART = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,94}[A-Za-z0-9_])?$/;
const REVISION = /^[0-9a-f]{40}$/;

/** Why `repo` is not an org/name hub id, or undefined when it is one. */
export function repoIdProblem(repo: string): string | undefined {
  const parts = repo.split("/");
  if (parts.length !== 2) return "must be org/name, with exactly one slash";
  if (!parts.every((p) => REPO_PART.test(p))) return "each part must be 1 to 96 of A-Z a-z 0-9 _ . -, starting and ending on a letter, digit or _";
  if (repo.includes("--") || repo.includes("..")) return "cannot contain -- or ..";
  if (repo.endsWith(".git")) return "cannot end in .git";
  return undefined;
}

export function isRepoId(repo: string): boolean {
  return repoIdProblem(repo) === undefined;
}

/** A full 40-hex commit hash, lowercased; undefined for anything else, branch and tag names included. */
export function normalizeRevision(revision: string): string | undefined {
  const r = revision.toLowerCase();
  return REVISION.test(r) ? r : undefined;
}

const HUB_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);
// First path segments that are hub pages, not model namespaces.
const NOT_MODELS = new Set(["datasets", "spaces", "api", "docs", "blog", "papers", "collections", "models", "organizations", "settings", "login", "join", "tasks", "learn"]);

/** The model repo id a huggingface.co URL points at, e.g. https://huggingface.co/Qwen/Qwen3-8B/tree/main gives Qwen/Qwen3-8B. Datasets, spaces and other pages give undefined. */
export function repoFromHubUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !HUB_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const [org, name] = url.pathname.split("/").filter(Boolean);
  if (!org || !name || NOT_MODELS.has(org)) return undefined;
  const repo = `${org}/${name}`;
  return isRepoId(repo) ? repo : undefined;
}
