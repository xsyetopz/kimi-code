/** Renderer that currently owns stdin/stdout for the interactive terminal. */
export type TerminalOwner = "none" | "pi-tui" | "ink";

/**
 * Small lifecycle guard shared by the coordinator and migration tests.
 * Exactly one renderer may own the process terminal at a time; a handoff must
 * explicitly release the previous owner before claiming the next one.
 */
export class TerminalOwnership {
  private owner: TerminalOwner = "none";

  get current(): TerminalOwner {
    return this.owner;
  }

  claim(next: Exclude<TerminalOwner, "none">): void {
    if (this.owner !== "none" && this.owner !== next) {
      throw new Error(
        `Cannot claim terminal for ${next}; ${this.owner} still owns it.`,
      );
    }
    this.owner = next;
  }

  release(owner: Exclude<TerminalOwner, "none">): void {
    if (this.owner === owner) this.owner = "none";
  }
}
