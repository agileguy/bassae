// Every character class ISC-44 keeps off a terminal, one sample each. Spelled as escapes, never raw.
export const HOSTILE = [
  "\x00", "\x07", "\x1b", "\x1f", // C0
  "\x7f", // DEL
  "\x80", "\x85", "\x9b", "\x9f", // C1, CSI included
  "\u{61c}", "\u{200e}", "\u{200f}", "\u{202a}", "\u{202e}", "\u{2066}", "\u{2069}", // bidi controls
  "\u{2028}", "\u{2029}", // line and paragraph separators
  "\u{200b}", "\u{ad}", "\u{2060}", "\u{2064}", "\u{feff}", "\u{fe0f}", // invisible (ISC-21)
  "\u{e0041}", "\u{e0100}", // tag character, variation selector supplement
  "\u{d800}", "\u{dc80}", "\u{dcff}", // lone surrogates
];

// Anything left in the output that a terminal or a reader could act on, or could not see.
export const RAW = new RegExp(
  String.raw`[\0-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{2028}\u{2029}]|\p{Default_Ignorable_Code_Point}|\p{Cf}|\p{Cs}`,
  "u",
);
