import {
  backgroundAnsi, foregroundAnsi, getTerminalColorMode, parseColor, stripTerminalSequences, styleText,
  truncateToWidth, visibleWidth, type EditorTheme, type MarkdownTheme,
} from "@earendil-works/pi-tui";

// Palette adapted from btop's default theme; see NOTICE and licenses/btop.txt.
export const palette = {
  background: "#000000", text: "#cccccc", title: "#eeeeee", muted: "#93939c",
  dim: "#66666f", line: "#303039", green: "#77ca9b", cyan: "#74e6fc",
  gold: "#cbc06c", red: "#d9626d", violet: "#b0a9de",
  chatBorder: "#556d59", inputBorder: "#6c6c4b", statusBorder: "#5c588d",
} as const;
export type Tone = keyof typeof palette;
const colors = Object.fromEntries(
  Object.entries(palette).map(([name, hex]) => [name, parseColor(hex)]),
) as Record<Tone, ReturnType<typeof parseColor>>;

// null inherits the surrounding background, as needed by native search highlights.
export function paint(text: string, tone: Tone = "text", bold = false, background: Tone | null = "background"): string {
  const mode = getTerminalColorMode();
  return styleText(text, { fg: colors[tone], bg: background === null ? undefined : colors[background], bold }, mode);
}

export function safeText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function fill(text: string, width: number, background: Tone = "background"): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  const mode = getTerminalColorMode();
  const fg = foregroundAnsi(colors.text, mode), bg = backgroundAnsi(colors[background], mode);
  // Nested component resets return to this surface, not the terminal's (possibly light) defaults.
  const body = clipped.replace(/\x1b\[0m/g, `\x1b[0m${fg}${bg}`)
    .replace(/\x1b\[39m/g, fg).replace(/\x1b\[49m/g, bg);
  return fg + bg + body + " ".repeat(Math.max(0, width - visibleWidth(clipped))) + "\x1b[0m";
}

export function rule(width: number, title: string, tone: Tone, right = "", bottom = false): string {
  if (width < 4) return paint("─".repeat(Math.max(0, width)), tone);
  const available = width - 4;
  const label = truncateToWidth(title, available, "");
  const tail = visibleWidth(label) + visibleWidth(right) + 3 <= available ? right : "";
  const line = paint("─".repeat(Math.max(0, available - visibleWidth(label) - visibleWidth(tail))), tone);
  return paint(bottom ? "╰─" : "╭─", tone) + label + line + tail + paint(bottom ? "─╯" : "─╮", tone);
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => paint(s, "green", true), link: (s) => paint(s, "cyan"),
  linkUrl: (s) => paint(s, "dim"), code: (s) => paint(s, "gold"),
  codeBlock: (s) => paint("│ ", "statusBorder") + paint(s, "cyan"),
  codeBlockBorder: (s) => paint(s === "```" ? "  ╰─" : `  ╭─ ${s.slice(3) || "code"}`, "statusBorder"),
  quote: (s) => paint(s, "muted"),
  quoteBorder: (s) => paint(s, "violet"), hr: (s) => paint(s, "line"),
  listBullet: (s) => paint(s, "green"), bold: (s) => paint(s, "title", true),
  italic: (s) => styleText(s, { fg: colors.text, italic: true }, getTerminalColorMode()),
  strikethrough: (s) => styleText(s, { fg: colors.dim, strikethrough: true }, getTerminalColorMode()),
  underline: (s) => styleText(s, { fg: colors.cyan, underline: true }, getTerminalColorMode()),
};

export const editorTheme: EditorTheme = {
  borderColor: (s) => paint(s, "inputBorder"),
  selectList: {
    selectedPrefix: (s) => paint(s, "gold"), selectedText: (s) => paint(s, "title"),
    description: (s) => paint(s, "muted"), scrollInfo: (s) => paint(s, "dim"),
    noMatch: (s) => paint(s, "dim"),
  },
};
