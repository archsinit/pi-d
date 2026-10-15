import { setTimeout as delay } from "node:timers/promises";
import headless from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";

export class TestTerminal implements Terminal {
  columns: number;
  rows: number;
  kittyProtocolActive = false;
  readonly screen: headless.Terminal;
  output = "";
  stopped = false;
  private input: ((data: string) => void) | undefined;
  private resized: (() => void) | undefined;
  constructor(columns = 110, rows = 36) {
    this.columns = columns; this.rows = rows;
    this.screen = new headless.Terminal({ cols: columns, rows, allowProposedApi: true });
  }
  start(input: (data: string) => void, resized: () => void): void { this.input = input; this.resized = resized; }
  stop(): void { this.stopped = true; this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; this.screen.write(data); }
  moveBy(lines: number): void { this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(): void {}
  send(data: string): void { this.input?.(data); }
  resize(columns: number, rows: number): void {
    this.columns = columns; this.rows = rows; this.screen.resize(columns, rows); this.resized?.();
  }
  async flush(): Promise<void> {
    await delay(35);
    await new Promise<void>((resolve) => this.screen.write("", resolve));
  }
  text(): string {
    const buffer = this.screen.buffer.active;
    return Array.from({ length: this.rows }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? "").join("\n");
  }
  dispose(): void { this.screen.dispose(); }
}
