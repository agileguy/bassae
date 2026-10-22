// Every added token counts, special or not: Qwen3's <think> and <tool_call> are added with
// special=false, and llama.cpp keeps them as user-defined tokens, which the GGUF side treats
// as scaffolding too. Leaving them out would make stock templates look like injected text.

/** Added-token strings from a parsed tokenizer.json and tokenizer_config.json. */
export function specialTokensFrom(tokenizerJson: unknown, tokenizerConfig: unknown): string[] {
  const out = new Set<string>();
  const added = field(tokenizerJson, "added_tokens");
  if (Array.isArray(added)) for (const t of added) addContent(out, t);
  const decoder = field(tokenizerConfig, "added_tokens_decoder");
  if (isObject(decoder)) for (const t of Object.values(decoder)) addContent(out, t);
  return [...out];
}

function addContent(out: Set<string>, token: unknown): void {
  const content = field(token, "content");
  if (typeof content === "string" && content !== "") out.add(content);
}

function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
