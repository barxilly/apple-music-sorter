// ---------------------------------------------------------------------------
// A tiny dependency-free progress display for long-running work.
//
// Draws to stderr so anything piped from stdout stays clean, and falls back to
// plain lines when stderr isn't a terminal (CI, redirects, editors).
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

const isTTY = Boolean(process.stderr.isTTY);
const COLOR = isTTY && !process.env.NO_COLOR;

const paint = (code: string, text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint("2", t);
const bold = (t: string) => paint("1", t);
const cyan = (t: string) => paint("36", t);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);

const ANSI = /\x1b\[[0-9;]*m/g;

/** Length as the terminal sees it, ignoring colour codes. */
function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  return `${text.replace(ANSI, "").slice(0, Math.max(0, width - 1))}…`;
}

/** "12.4s" under a minute, "1m05s" above it. */
export function humanSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

export type StatusUpdate = {
  /** What's happening right now - shown at the end of the status line. */
  label?: string;
  /** Cumulative tokens used so far, if known. */
  tokens?: number;
  /**
   * Pre-formatted running spend, e.g. "£0.00214". Deliberately a string so this
   * module stays a dumb renderer that knows nothing about pricing.
   */
  cost?: string;
  /** Projected total spend for the whole job, same units as `cost`. */
  estimate?: string;
};

export class Progress {
  private readonly title: string;
  private readonly total: number;

  private readonly startedAt = Date.now();
  private completed = 0;
  private tokens = 0;
  private cost = "";
  private estimate = "";
  private label = "";
  private frame = 0;
  /** Songs-per-second for each finished chunk, used for the sparkline. */
  private throughput: number[] = [];
  private chunkStartedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private blockLines = 0;

  // Written out longhand rather than as parameter properties: those are not
  // erasable, so `node --strip-types` refuses to run the file.
  constructor(title: string, total: number) {
    this.title = title;
    this.total = total;
  }

  start(): this {
    if (isTTY) process.stderr.write("\x1b[?25l"); // hide the cursor
    this.timer = setInterval(() => {
      this.frame += 1;
      this.draw();
    }, 90);
    this.draw();
    return this;
  }

  /** Something new is about to start; show it while we wait for it. */
  setStatus(label: string): void {
    this.label = label;
    if (isTTY) this.draw();
  }

  /** A chunk of work finished. */
  advance(count: number, update: StatusUpdate = {}): void {
    const elapsed = (Date.now() - this.chunkStartedAt) / 1000;
    if (elapsed > 0) this.throughput.push(count / elapsed);
    this.chunkStartedAt = Date.now();

    this.completed += count;
    if (update.tokens !== undefined) this.tokens = update.tokens;
    if (update.cost !== undefined) this.cost = update.cost;
    if (update.estimate !== undefined) this.estimate = update.estimate;
    if (update.label !== undefined) this.label = update.label;

    if (!isTTY) {
      process.stderr.write(`  ${this.completed}/${this.total}  ${this.label}\n`);
      return;
    }
    this.draw();
  }

  succeed(): void {
    this.stop();
    const elapsed = (Date.now() - this.startedAt) / 1000;
    this.clearBlock();

    let summary = `${green("✔")} ${bold(this.title)} ${this.completed}/${this.total} in ${humanSeconds(elapsed)}`;
    if (this.completed > 0 && elapsed > 0) {
      const bits = [
        `${(this.completed / elapsed).toFixed(2)} songs/s`,
        `${(elapsed / this.completed).toFixed(2)} s/song`,
      ];
      if (this.tokens > 0) bits.push(`${this.tokens.toLocaleString()} tok`);
      if (this.cost) bits.push(this.cost);
      summary += `  ${dim(`(${bits.join(" · ")})`)}`;
    }
    process.stderr.write(`${summary}\n`);
  }

  fail(message: string): void {
    this.stop();
    this.clearBlock();
    process.stderr.write(`${red("✖")} ${bold(this.title)} stopped: ${message}\n`);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (isTTY) process.stderr.write("\x1b[?25h"); // restore the cursor
  }

  /** Wipe the live block and park the cursor at its top-left. */
  private clearBlock(): void {
    if (!isTTY || this.blockLines === 0) return;
    let out = `\x1b[${this.blockLines}A`;
    for (let i = 0; i < this.blockLines; i += 1) out += "\x1b[2K\n";
    out += `\x1b[${this.blockLines}A`;
    process.stderr.write(out);
    this.blockLines = 0;
  }

  private draw(): void {
    if (!isTTY) return;

    const elapsed = (Date.now() - this.startedAt) / 1000;
    const done = this.completed;
    const perSong = done > 0 ? elapsed / done : 0;
    const rate = done > 0 ? done / elapsed : 0;
    const fraction = this.total > 0 ? done / this.total : 0;

    const columns = process.stderr.columns ?? 80;
    const barWidth = Math.max(10, Math.min(34, columns - 48));
    const filled = Math.round(fraction * barWidth);
    const bar = cyan("█".repeat(filled)) + dim("░".repeat(Math.max(0, barWidth - filled)));

    const spinner = paint("33", FRAMES[this.frame % FRAMES.length] ?? "");
    const head =
      `${spinner} ${bold(this.title)} ${bar} ` +
      `${done}/${this.total} ${(fraction * 100).toFixed(0).padStart(3)}%`;

    // Ordered so the money is early in the line: on a narrow terminal the tail
    // (sparkline, then the long label) is what gets truncated, and the label is
    // the least important thing here.
    const stats: string[] = [dim(humanSeconds(elapsed))];
    stats.push(done > 0 ? `${rate.toFixed(1)}/s · ${perSong.toFixed(2)}s/song` : dim("warming up"));
    if (this.cost) stats.push(green(this.cost));
    if (this.estimate && done < this.total) stats.push(dim(`est ${this.estimate}`));
    if (this.tokens > 0) stats.push(dim(`${Math.round(this.tokens / 1000)}k tok`));
    if (done > 0 && done < this.total && perSong > 0) stats.push(`ETA ${humanSeconds((this.total - done) * perSong)}`);
    if (this.throughput.length > 1) stats.push(this.sparkline());
    if (this.label) stats.push(dim(this.label));

    const tail = `   ${truncate(stats.join(dim(" │ ")), columns - 4)}`;

    let out = this.blockLines > 0 ? `\x1b[${this.blockLines}A` : "";
    out += `\x1b[2K${head}\n\x1b[2K${tail}\n`;
    this.blockLines = 2;
    process.stderr.write(out);
  }

  /** Throughput of recent chunks, scaled between its own min and max. */
  private sparkline(): string {
    const values = this.throughput.slice(-14);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const bars = values.map((value) => {
      const level = Math.round(((value - min) / span) * (SPARK.length - 1));
      return SPARK[level] ?? "";
    });
    return cyan(bars.join(""));
  }
}
