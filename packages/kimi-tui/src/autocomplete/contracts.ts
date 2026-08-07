export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?(
    argumentPrefix: string,
  ): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

export interface AutocompleteProvider {
  triggerCharacters?: string[];

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };

  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean;
}
