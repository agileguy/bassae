// Caps on every length and count a GGUF file declares. Each is checked before the reader
// allocates or loops on the declared value, so a hostile header can't steer either. A value
// the reader doesn't keep is skipped by its size, checked against the file and the KV section cap.

/** Real files carry 30 to 60 KVs; 65,536 bounds the KV loop with room to spare. */
export const MAX_KV_COUNT = 65_536;

/** Keys are short dotted names; a 64 KiB key is already hostile. */
export const MAX_KEY_BYTES = 64 * 1024;

/** The largest local chat template is 18.5 KB; 16 MiB bounds any single string the reader keeps. */
export const MAX_STRING_BYTES = 16 * 1024 * 1024;

/** Gemma 4 ships 262,144 tokens and 514,906 merges; 4 Mi elements is 8x the largest array the reader keeps. */
export const MAX_ARRAY_LENGTH = 4 * 1024 * 1024;

/** Gemma 4's whole KV section is about 16 MB; nothing is read past 256 MiB, which bounds total work. */
export const MAX_KV_SECTION_BYTES = 256 * 1024 * 1024;

// tensor_count is read but never looped over or allocated against, so it needs no cap.
