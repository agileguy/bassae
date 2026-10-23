import { describe, expect, test } from "bun:test";
import { isRepoId, normalizeRevision, repoFromHubUrl, repoIdProblem } from "../../src/provenance/hub.ts";

describe("hub ids", () => {
  test("accepts org/name ids", () => {
    for (const id of ["Qwen/Qwen2.5-0.5B-Instruct", "meta-llama/Llama-3.2-1B", "a/b", "org_1/name.v2", "_x/y_"]) expect(isRepoId(id)).toBe(true);
  });

  test("rejects traversal, bare names, extra slashes and bad edges", () => {
    for (const id of [
      "",
      "name",
      "a/b/c",
      "../x",
      "a/..",
      "a/b..c",
      "a--b/c",
      "-org/name",
      "org/-name",
      ".org/name",
      "org/name.",
      "org/name.git",
      "org/na me",
      "org/näme",
      "org/name?x=1",
      "org/name#x",
      "org/name%2F..",
      "/org/name",
      `org/${"x".repeat(97)}`,
    ]) {
      expect(repoIdProblem(id)).toBeString();
    }
  });

  test("a revision is a full 40-hex commit", () => {
    expect(normalizeRevision("7ae557604adf67be50417f59c2c2f167def9a775")).toBe("7ae557604adf67be50417f59c2c2f167def9a775");
    expect(normalizeRevision("7AE557604ADF67BE50417F59C2C2F167DEF9A775")).toBe("7ae557604adf67be50417f59c2c2f167def9a775");
    for (const r of ["main", "v1.0", "7ae5576", "7ae557604adf67be50417f59c2c2f167def9a77", "7ae557604adf67be50417f59c2c2f167def9a775/..", "g".repeat(40)]) {
      expect(normalizeRevision(r)).toBeUndefined();
    }
  });

  test("model URLs give their repo; datasets, spaces and other hosts do not", () => {
    expect(repoFromHubUrl("https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct")).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(repoFromHubUrl("https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/tree/main")).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(repoFromHubUrl("https://hf.co/a/b/")).toBe("a/b");
    expect(repoFromHubUrl("https://huggingface.co/datasets/a/b")).toBeUndefined();
    expect(repoFromHubUrl("https://huggingface.co/spaces/a/b")).toBeUndefined();
    expect(repoFromHubUrl("https://huggingface.co/a")).toBeUndefined();
    expect(repoFromHubUrl("https://evil.example/a/b")).toBeUndefined();
    expect(repoFromHubUrl("https://huggingface.co.evil.example/a/b")).toBeUndefined();
    expect(repoFromHubUrl("file:///huggingface.co/a/b")).toBeUndefined();
    expect(repoFromHubUrl("not a url")).toBeUndefined();
    expect(repoFromHubUrl("https://huggingface.co/a--b/c")).toBeUndefined();
  });
});
