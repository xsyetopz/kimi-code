/**
 * Custom editor extending kimi-tui Editor with app-level keybindings.
 */

import {
  Editor,
  isKeyRelease,
  matchesKey,
  Key,
  SelectList,
  type SelectItem,
  type TUI,
} from "@moonshot-ai/kimi-tui";

import { currentTheme } from "#/tui/theme";
import { createEditorTheme } from "#/tui/theme/kimi-tui-theme";
import { printableChar } from "#/tui/utils/printable-key";

import { extractAtPrefix } from "./file-mention-provider";
import { INLINE_SKILL_TOKEN_PREFIX } from "#/tui/utils/inline-skill";
import { WrappingSelectList } from "./wrapping-select-list";
import { normalizeCapsLockedCtrl } from "./custom-editor-caps-lock";
import {
  highlightFirstSlashToken,
  injectArgumentHint,
  injectPromptSymbol,
  wrapWithSideBorders,
} from "./custom-editor-render";

export {
  highlightFirstSlashToken,
  injectPromptSymbol,
  wrapWithSideBorders,
} from "./custom-editor-render";
export { normalizeCapsLockedCtrl } from "./custom-editor-caps-lock";

const PASTE_MARKER_RE = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const BRACKET_PASTE_START = "\u001B[200~";
const BRACKET_PASTE_END = "\u001B[201~";

interface AutocompleteInternals {
  cancelAutocomplete(): void;
  readonly autocompleteAbort?: AbortController;
  readonly autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
}

interface AutocompleteListFactoryInternals {
  createAutocompleteList?: (prefix: string, items: SelectItem[]) => SelectList;
}

interface AutocompleteTriggerInternals {
  tryTriggerAutocomplete: (explicitTab?: boolean) => void;
  requestAutocomplete: (options: {
    force: boolean;
    explicitTab: boolean;
  }) => void;
}

// Mirror kimi-tui's private SLASH_COMMAND_SELECT_LIST_LAYOUT
// (dist/components/editor.js); keep in sync when bumping kimi-tui.
const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
} as const;

interface CustomEditorOptions {
  disablePasteBurst?: boolean;
}

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  /**
   * Fired for every input that is not a lone Escape. Used to disarm a pending
   * double-Esc so only two consecutive Escape presses trigger the shortcut.
   */
  public onNonEscapeInput?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  /** Return `true` to consume Ctrl+B; return `false`/`undefined` to fall through to the editor default (cursor-left). */
  public onCtrlB?: () => boolean;
  /** Return `true` to consume Ctrl+T (the todo list had overflow to toggle); return `false`/`undefined` to fall through to the editor default. */
  public onToggleTodoExpand?: () => boolean;
  public onUndo?: () => void;
  public onTextPaste?: () => void;
  /**
   * Called when ↑ is pressed in an empty editor. Return `true` to consume
   * the key (e.g. recalled a queued message); return `false` to fall
   * through so kimi-tui's built-in history navigation runs.
   */
  public onUpArrowEmpty?: () => boolean;
  public onDownArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;
  /** 'bash' when entering a `!` shell command. The `!` is never part of the
   *  text buffer — it is a separate mode + prompt symbol (see handleInput). */
  public inputMode: "prompt" | "bash" = "prompt";
  public onInputModeChange?: (mode: "prompt" | "bash") => void;
  public connectedAbove = false;
  public borderHighlighted = false;
  /**
   * Called when the user triggers "paste image" (Ctrl-V on Unix,
   * Alt-V on Windows — Ctrl-V is terminal-reserved there). Return
   * `true` to consume the key (image was read and handled); return
   * `false` to let the key fall through to the normal paste path.
   * The callback may be async; kimi-tui awaits it before dispatching
   * the next keystroke.
   */
  public onPasteImage?: () => Promise<boolean>;

  private consumingPaste = false;
  private consumeBuffer = "";
  private argumentHints: ReadonlyMap<string, string> = new Map();

  setArgumentHints(hints: ReadonlyMap<string, string>): void {
    this.argumentHints = hints;
  }

  constructor(tui: TUI, options: CustomEditorOptions = {}) {
    // paddingX: 4 reserves column 0 for the left vertical border (│),
    // column 1 as a single space between border and prompt, column 2 for
    // the `>` prompt token, and column 3 as the space between prompt and
    // content. The right side mirrors with 3 padding columns and the right
    // border at the last column.
    const theme = createEditorTheme();
    super(tui, theme, {
      paddingX: 4,
      disablePasteBurst: options.disablePasteBurst,
    });

    // kimi-tui keeps `createAutocompleteList` private; shadow it with an
    // instance property so slash command menus render descriptions wrapped
    // to at most two lines. Non-slash completion (paths, @ mentions) keeps
    // kimi-tui's single-line list.
    (
      this as unknown as AutocompleteListFactoryInternals
    ).createAutocompleteList = (prefix, items) => {
      if (
        prefix.startsWith("/") ||
        prefix.startsWith(INLINE_SKILL_TOKEN_PREFIX)
      ) {
        return new WrappingSelectList(
          items,
          this.getAutocompleteMaxVisible(),
          theme.selectList,
          SLASH_COMMAND_SELECT_LIST_LAYOUT,
        );
      }
      return new SelectList(
        items,
        this.getAutocompleteMaxVisible(),
        theme.selectList,
      );
    };

    // kimi-tui auto-triggers autocomplete for `/` (and letters in a slash
    // context) with force:false, which routes through the slash-command
    // branch. In bash mode `/` is a path separator, not a command prefix, so
    // shadow the trigger to request file path completion (force:true) instead.
    // Prompt mode keeps the original force:false behaviour. `tryTriggerAutocomplete`
    // is private in kimi-tui's typings but a plain prototype method at runtime.
    const triggerInternals = this as unknown as AutocompleteTriggerInternals;
    triggerInternals.tryTriggerAutocomplete = (explicitTab = false) => {
      triggerInternals.requestAutocomplete({
        force: this.inputMode === "bash",
        explicitTab,
      });
    };
  }

  override setDisablePasteBurst(disabled: boolean): void {
    super.setDisablePasteBurst(disabled);
  }

  public setInputMode(mode: "prompt" | "bash"): void {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    this.onInputModeChange?.(mode);
  }

  private expandPasteMarkerAtCursor(): boolean {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const currentLine = lines[line] ?? "";

    for (const match of currentLine.matchAll(PASTE_MARKER_RE)) {
      const start = match.index;
      const end = start + match[0].length;
      if (col < start || col > end) continue;

      const pasteId = Number(match[1]);
      const pastes = (this as unknown as { pastes: Map<number, string> })
        .pastes;
      const content = pastes.get(pasteId);
      if (content === undefined) return false;

      const text = this.getText();
      const offset =
        lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + start;
      const newText =
        text.slice(0, offset) + content + text.slice(offset + match[0].length);
      this.setText(newText);
      return true;
    }
    return false;
  }

  private hasAutocompleteActivity(): boolean {
    const autocomplete = this as unknown as AutocompleteInternals;
    return (
      this.isShowingAutocomplete() ||
      autocomplete.autocompleteAbort !== undefined ||
      autocomplete.autocompleteDebounceTimer !== undefined
    );
  }

  private cancelAutocompleteActivity(): void {
    // kimi-tui exposes `isShowingAutocomplete()` but keeps cancellation private.
    // Kimi needs Esc to win over app-level cancel while the slash menu request is active.
    (this as unknown as AutocompleteInternals).cancelAutocomplete();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 3) return lines;
    const firstContentIdx = 1;
    const isBash = this.inputMode === "bash";
    const text = this.getText().trimStart();
    if (text.startsWith("/") && !isBash) {
      // Paint only the FIRST editor content line; multi-line slash commands
      // are not a thing in practice.
      const original = lines[firstContentIdx];
      if (original !== undefined) {
        const highlighted = highlightFirstSlashToken(original, "primary");
        if (highlighted !== undefined) {
          lines[firstContentIdx] = highlighted;
        }
      }
    }
    const hint = this.computeArgumentHint();
    if (hint !== undefined) {
      const line = lines[firstContentIdx];
      if (line !== undefined) {
        lines[firstContentIdx] = injectArgumentHint(
          line,
          hint,
          this.getText().length,
          width,
        );
      }
    }
    const firstContent = lines[firstContentIdx];
    if (firstContent !== undefined) {
      const withPrompt = injectPromptSymbol(
        firstContent,
        isBash ? "!" : ">",
        isBash ? (s) => this.borderColor(s) : undefined,
      );
      if (withPrompt !== undefined) {
        lines[firstContentIdx] = withPrompt;
      }
    }
    // `this.borderColor` is kimi-tui's per-render paint function. The host may
    // overwrite it (e.g. plan-mode / slash-context highlight via
    // `editor.borderColor = chalk.hex(primary)`), so we route corners and
    // side bars through the same hook to stay in sync.
    return wrapWithSideBorders(lines, (s) => this.borderColor(s), {
      connectedAbove: this.connectedAbove && !this.borderHighlighted,
      label: isBash
        ? ` ${currentTheme.boldFg("shellMode", "! shell mode")} `
        : undefined,
    });
  }

  private computeArgumentHint(): string | undefined {
    // Argument hints describe slash commands, which do not exist in bash mode.
    if (this.inputMode === "bash") return undefined;
    const text = this.getText();
    const match = /^\/(\S+)( ?)$/.exec(text);
    if (match === null) return undefined;
    const cmd = match[1];
    const trailingSpace = match[2] ?? "";
    if (cmd === undefined) return undefined;
    const hint = this.argumentHints.get(cmd);
    if (hint === undefined) return undefined;
    const { line, col } = this.getCursor();
    if (line !== 0) return undefined;
    const currentLine = this.getLines()[0] ?? "";
    if (col !== currentLine.length) return undefined;
    return trailingSpace.length > 0 ? hint : ` ${hint}`;
  }

  override handleInput(data: string): void {
    const normalized = normalizeCapsLockedCtrl(data);
    if (isKeyRelease(normalized)) {
      return;
    }

    // Any input other than a lone Escape breaks a pending double-Esc sequence,
    // so the shortcut only fires for two consecutive Escape presses.
    if (!matchesKey(normalized, Key.escape)) {
      this.onNonEscapeInput?.();
    }

    // When a paste marker was just expanded, discard the trailing bracketed
    // paste data that the terminal sends alongside the Ctrl-V keystroke.
    if (this.consumingPaste) {
      this.consumeBuffer += normalized;
      if (this.consumeBuffer.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = false;
        this.consumeBuffer = "";
      }
      return;
    }

    // If a bracketed paste arrives while the cursor sits on an existing
    // paste marker, expand that marker instead of pasting new content.
    if (
      normalized.includes(BRACKET_PASTE_START) &&
      this.expandPasteMarkerAtCursor()
    ) {
      if (!normalized.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = true;
      }
      return;
    }

    // Paste image binding — platform-aware:
    //   Windows terminals reserve Ctrl-V for their own paste handling
    //   (e.g. Windows Terminal's Ctrl+V shortcut), so we listen for
    //   Alt-V there. Everywhere else Ctrl-V pastes. When the host
    //   reports no image available, we fall through to kimi-tui's
    //   normal paste path so text from the clipboard still works.
    const pasteKey = process.platform === "win32" ? "alt+v" : Key.ctrl("v");
    if (matchesKey(normalized, pasteKey)) {
      if (this.expandPasteMarkerAtCursor()) {
        return;
      }
      if (this.onPasteImage !== undefined) {
        const handler = this.onPasteImage;
        const pasteAsText = (): void => {
          this.onTextPaste?.();
          super.handleInput.call(this, normalized);
        };
        void handler().then(
          (handled) => {
            if (!handled) pasteAsText();
          },
          () => {
            // A rejecting image-paste handler must not leak an unhandled
            // rejection (the CLI turns those into a silent exit) — treat it
            // the same as "no image available" and fall back to text paste.
            pasteAsText();
          },
        );
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl("d"))) {
      if (this.getText().length === 0) {
        this.onCtrlD?.();
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl("c"))) {
      this.onCtrlC?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl("g"))) {
      this.onOpenExternalEditor?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl("o"))) {
      this.onToggleToolExpand?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl("s"))) {
      this.onCtrlS?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl("b"))) {
      // Only consume the key when the handler actually detached something;
      // otherwise fall through so readline's backward-char still works at the
      // idle prompt.
      if (this.onCtrlB?.() === true) return;
    }

    if (matchesKey(normalized, Key.ctrl("t"))) {
      // Only consume the key when the todo list actually has overflow to
      // expand/collapse; otherwise fall through to the editor default.
      if (this.onToggleTodoExpand?.() === true) return;
    }

    if (matchesKey(normalized, "shift+tab")) {
      this.onShiftTab?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl("-"))) {
      this.onUndo?.();
    }

    // Exit bash mode: Backspace/Escape on an empty `!` prompt returns to prompt
    // mode. Because the `!` is not in the buffer, "deleting" it is really
    // "delete on empty bash input".
    if (
      this.inputMode === "bash" &&
      this.getText().length === 0 &&
      (matchesKey(normalized, Key.escape) ||
        matchesKey(normalized, Key.backspace))
    ) {
      this.inputMode = "prompt";
      this.onInputModeChange?.("prompt");
      return;
    }

    if (matchesKey(normalized, Key.up)) {
      if (this.getText().length === 0 && this.onUpArrowEmpty) {
        if (this.onUpArrowEmpty()) return;
        // fall through to super so Editor's built-in history navigation runs
      }
    }

    if (matchesKey(normalized, Key.down)) {
      if (this.getText().length === 0 && this.onDownArrowEmpty) {
        if (this.onDownArrowEmpty()) return;
      }
    }

    if (matchesKey(normalized, Key.escape)) {
      if (this.hasAutocompleteActivity()) {
        this.cancelAutocompleteActivity();
        return;
      }
      this.onEscape?.();
      return;
    }

    // Swallow Tab while the autocomplete dropdown is closed so it does not
    // trigger kimi-tui's built-in file completion. When the dropdown is open,
    // fall through so kimi-tui can still accept the selected item with Tab.
    if (matchesKey(normalized, Key.tab) && !this.isShowingAutocomplete()) {
      return;
    }

    // Enter bash mode: typing `!` at the start of an empty prompt. The `!` is
    // not inserted into the buffer — it becomes the mode + prompt symbol, so the
    // cursor never has to skip over it and submit never has to strip it.
    if (
      this.inputMode === "prompt" &&
      printableChar(normalized) === "!" &&
      this.getText().length === 0
    ) {
      this.inputMode = "bash";
      this.onInputModeChange?.("bash");
      return;
    }

    const emptyPromptBeforeInput =
      this.inputMode === "prompt" && this.getText().length === 0;
    super.handleInput(normalized);

    // Enter bash mode when `!...` is pasted into an empty prompt. The typed path
    // above handles the single `!` keystroke; this catches bracketed / Ctrl-V
    // pastes whose content starts with `!`. Strip the leading `!` so the buffer
    // holds only the command, exactly like the typed path.
    if (
      emptyPromptBeforeInput &&
      this.inputMode === "prompt" &&
      this.getText().startsWith("!")
    ) {
      this.inputMode = "bash";
      this.onInputModeChange?.("bash");
      this.setText(this.getText().slice(1));
    }

    this.reopenAutocompleteAfterInput();
  }

  private reopenAutocompleteAfterInput(): void {
    if (this.isShowingAutocomplete()) return;
    const { line, col } = this.getCursor();
    const textBeforeCursor = this.getLines()[line]?.slice(0, col) ?? "";
    const editor = this as unknown as {
      requestAutocomplete?: (options: {
        force: boolean;
        explicitTab: boolean;
      }) => void;
    };
    if (editor.requestAutocomplete === undefined) return;
    const trigger = (): void => {
      // Use force:false so slash-aware logic runs: commands with argument
      // completions return their subcommands, commands without them return
      // null. force:true would bypass the slash branch and fall through to
      // path completion, wrongly popping up the file list.
      editor.requestAutocomplete?.({ force: false, explicitTab: false });
    };

    // Reopen path / argument completion right after a `/` is typed
    // (e.g. `/add-dir /` or an `@dir/` mention).
    if (textBeforeCursor.endsWith("/")) {
      const isAtMention = extractAtPrefix(textBeforeCursor) !== null;
      if (isAtMention) {
        trigger();
      } else if (this.inputMode === "bash") {
        // In bash mode `/` is a path separator, not a slash command. A bare
        // leading `/` is already handled by the tryTriggerAutocomplete shadow
        // in the constructor; this branch covers the inline case (e.g. `ls /`,
        // `cat /etc/`, `/add-dir/`) that kimi-tui never auto-triggers. force:true
        // is required so kimi-tui's own slash-command handling is bypassed —
        // force:false would let it pop up subcommand completions.
        if (textBeforeCursor.trimStart() !== "/") {
          editor.requestAutocomplete?.({ force: true, explicitTab: false });
        }
      } else {
        const isSlashArgument =
          textBeforeCursor.startsWith("/") && textBeforeCursor.includes(" ");
        if (isSlashArgument) {
          trigger();
        }
      }
      return;
    }

    // After accepting a slash command name via Tab, kimi-tui inserts a trailing
    // space and closes the menu without triggering argument completion. Reopen
    // it so subcommands (e.g. `/goal ` → status/pause/…) show immediately.
    // Skipped in bash mode: `/` is a path there, and force:false would let
    // kimi-tui's own slash-command handling pop up subcommand completions.
    if (
      this.inputMode !== "bash" &&
      textBeforeCursor.endsWith(" ") &&
      textBeforeCursor.startsWith("/") &&
      textBeforeCursor.includes(" ")
    ) {
      trigger();
    }
  }
}
