// Test classification for the trigger rules (ISC-18, ISC-18.1): how strongly a
// conditional's outcome depends on what the user typed or on chance.

/** The strength of a test, weakest first. `none` is a test on template constants only. */
export type TestClass = "none" | "presence" | "content" | "nondeterministic";

const RANK: Record<TestClass, number> = { none: 0, presence: 1, content: 2, nondeterministic: 3 };

/** The stronger of two test classes. */
export function stronger(a: TestClass, b: TestClass): TestClass {
  return RANK[a] >= RANK[b] ? a : b;
}
