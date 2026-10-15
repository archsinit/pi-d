import { mkdir, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDemo } from "../src/demo.ts";
import { palette } from "../src/theme.ts";
import { mountChat } from "../src/chat.ts";
import { TestTerminal } from "../test/terminal.ts";

// Capture the actual TUI through a terminal emulator, rather than drawing a mockup.
process.env.COLORTERM = "truecolor";
const terminal = new TestTerminal(110, 44);
const demo = await openDemo(90);
const app = await mountChat(demo, terminal, false), ui = app.ui;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

async function snapshot(name: string, screen = terminal): Promise<void> {
  await screen.flush();
  const cw = 9, ch = 19, padding = 20;
  const width = screen.columns * cw + padding * 2, height = screen.rows * ch + padding * 2;
  const elements = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="12" fill="${palette.background}"/>`,
    `<g font-family="Menlo, DejaVu Sans Mono, monospace" font-size="14" xml:space="preserve">`];
  const buffer = screen.screen.buffer.active;
  for (let y = 0; y < screen.rows; y++) {
    const line = buffer.getLine(y);
    for (let x = 0; x < screen.columns; x++) {
      const cell = line?.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const left = padding + x * cw, top = padding + y * ch;
      const bg = cell.isBgRGB() ? hex(cell.getBgColor()) : palette.background;
      const fg = cell.isFgRGB() ? hex(cell.getFgColor()) : palette.text;
      if (bg !== palette.background) elements.push(`<rect x="${left}" y="${top}" width="${cell.getWidth() * cw}" height="${ch}" fill="${bg}" shape-rendering="crispEdges"/>`);
      const chars = cell.getChars();
      if (chars && chars !== " ") elements.push(`<text x="${left}" y="${top + 14}" fill="${fg}"${cell.isBold() ? ' font-weight="bold"' : ""}${cell.isItalic() ? ' font-style="italic"' : ""}>${escape(chars)}</text>`);
    }
  }
  elements.push("</g></svg>");
  await mkdir("docs", { recursive: true });
  await writeFile(`docs/${name}.svg`, elements.join("\n") + "\n");
  console.log(`docs/${name}.svg`);
}

try {
  demo.answer();
  const submitted = await demo.conversation.submit({ type: "input", content: "A simple chat. Beautiful, but with the engine left alone." }, BACKGROUND_CONTEXT);
  await submitted.wait(BACKGROUND_CONTEXT);
  ui.composer.editor.setText("Let's keep it this simple.");
  await snapshot("preview");
} finally {
  await app.close(); terminal.dispose();
}
