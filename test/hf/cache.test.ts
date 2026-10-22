import { describe, expect, test } from "bun:test";
import { hfCacheLocations, parseHfCachePath } from "../../src/hf/cache.ts";

const hub = "/home/u/.cache/huggingface/hub";
const rev = "545dc4251c05440727734bcd94334791f6ab0192";

describe("parseHfCachePath", () => {
  test("reads repo, revision and path in repo", () => {
    expect(parseHfCachePath(`${hub}/models--mlx-community--Qwen3-8B-4bit/snapshots/${rev}/tokenizer_config.json`)).toEqual({
      repo: "mlx-community/Qwen3-8B-4bit",
      revision: rev,
      pathInRepo: "tokenizer_config.json",
    });
  });

  test("keeps nested paths in repo", () => {
    expect(parseHfCachePath(`${hub}/models--org--name/snapshots/abc/sub/dir/model.gguf`)?.pathInRepo).toBe("sub/dir/model.gguf");
  });

  test("the snapshot directory itself has an empty path in repo", () => {
    expect(parseHfCachePath(`${hub}/models--org--name/snapshots/abc`)).toEqual({ repo: "org/name", revision: "abc", pathInRepo: "" });
    expect(parseHfCachePath(`${hub}/models--org--name/snapshots/abc/`)?.pathInRepo).toBe("");
  });

  test("a repo without an org", () => {
    expect(parseHfCachePath(`${hub}/models--gpt2/snapshots/abc/config.json`)?.repo).toBe("gpt2");
  });

  test("works on a cache that is not under the default hub dir", () => {
    expect(parseHfCachePath(`/mnt/x/models--a--b/snapshots/r/f`)?.repo).toBe("a/b");
  });

  test("paths outside snapshots are not cache locations", () => {
    expect(parseHfCachePath(`${hub}/models--org--name/blobs/0123abcd`)).toBeUndefined();
    expect(parseHfCachePath(`${hub}/models--org--name/.no_exist/abc/chat_template.jinja`)).toBeUndefined();
    expect(parseHfCachePath(`${hub}/models--org--name/snapshots`)).toBeUndefined();
    expect(parseHfCachePath(`${hub}/datasets--org--name/snapshots/abc/x.json`)).toBeUndefined();
    expect(parseHfCachePath(`/Users/u/.omlx/models/Qwen3-8B-4bit`)).toBeUndefined();
  });

  test("uses the innermost cache layout when one is nested in another", () => {
    const p = `${hub}/models--a--b/snapshots/r1/vendored/models--c--d/snapshots/r2/x.json`;
    expect(parseHfCachePath(p)).toEqual({ repo: "c/d", revision: "r2", pathInRepo: "x.json" });
  });
});

test("hfCacheLocations keeps every distinct (repo, revision, path)", () => {
  const blob = `${hub}/models--org--name/blobs/deadbeef`;
  const locs = hfCacheLocations([
    `${hub}/models--org--name/snapshots/r1/model.gguf`,
    blob,
    `${hub}/models--org--name/snapshots/r2/model.gguf`,
    `${hub}/models--org--name/snapshots/r1/model.gguf`,
  ]);
  expect(locs).toEqual([
    { repo: "org/name", revision: "r1", pathInRepo: "model.gguf" },
    { repo: "org/name", revision: "r2", pathInRepo: "model.gguf" },
  ]);
});
