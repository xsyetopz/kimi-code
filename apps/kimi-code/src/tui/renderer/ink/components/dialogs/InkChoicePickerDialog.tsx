import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { CURRENT_MARK } from "../../../../constant/symbols";
import { currentTheme } from "../../../../theme";
import type { InkChoicePickerView } from "../../sessions/choice-picker";

import { ChoiceList } from "./ChoiceList";

export interface InkChoicePickerDialogProps {
  readonly picker: InkChoicePickerView;
}

export function InkChoicePickerDialog({
  picker,
}: InkChoicePickerDialogProps): ReactNode {
  const titleSuffix =
    picker.searchable && picker.query.length === 0
      ? currentTheme.fg("textMuted", "  (type to search)")
      : "";
  const visibleOptions = picker.options.slice(picker.pageStart, picker.pageEnd);
  const pageSelectedIndex = Math.max(0, picker.selectedIndex - picker.pageStart);

  return (
    <Box flexDirection="column">
      <Text>
        {currentTheme.boldFg("primary", picker.title)}
        {titleSuffix}
      </Text>
      {picker.hint === undefined ? null : (
        <Text>{currentTheme.fg("textMuted", picker.hint)}</Text>
      )}
      {picker.notice === undefined ? null : (
        <Text>{currentTheme.fg(picker.noticeTone, picker.notice)}</Text>
      )}
      {picker.searchable && picker.query.length > 0 ? (
        <Text>
          {currentTheme.fg("primary", "Search: ")}
          {picker.query}
        </Text>
      ) : null}
      {visibleOptions.length === 0 ? (
        <Text>{currentTheme.fg("textMuted", "No matches")}</Text>
      ) : (
        <ChoiceList
          choices={visibleOptions.map((option) => ({
            label:
              option.tone === "danger"
                ? currentTheme.fg("error", option.label)
                : option.isCurrent
                  ? `${option.label} ${CURRENT_MARK}`
                  : option.label,
            description: option.description,
          }))}
          selectedIndex={pageSelectedIndex}
        />
      )}
      {picker.pageCount > 1 ? (
        <Text>
          {currentTheme.fg(
            "textMuted",
            `Showing ${String(picker.pageStart + 1)}-${String(picker.pageEnd)} of ${String(picker.options.length)}`,
          )}
        </Text>
      ) : null}
    </Box>
  );
}
