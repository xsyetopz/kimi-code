import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { CURRENT_MARK, SELECT_POINTER } from "../../../../constant/symbols";
import { currentTheme } from "../../../../theme";
import type { InkModelSelectorView } from "../../sessions/model-selector";

export interface InkModelSelectorDialogProps {
  readonly selector: InkModelSelectorView;
}

export function InkModelSelectorDialog({
  selector,
}: InkModelSelectorDialogProps): ReactNode {
  const titleSuffix =
    selector.searchable && selector.query.length === 0
      ? currentTheme.fg("textMuted", "  (type to search)")
      : "";

  return (
    <Box flexDirection="column">
      <Text>
        {currentTheme.boldFg("primary", selector.title)}
        {titleSuffix}
      </Text>
      <Text>{currentTheme.fg("textMuted", selector.hint)}</Text>
      {selector.warning === undefined ? null : (
        <Text>{currentTheme.fg("warning", selector.warning)}</Text>
      )}
      {selector.tabs.length > 0 ? (
        <Text>
          {selector.tabs
            .map((tab, index) => {
              const prefix = index === 0 ? "" : "  ";
              if (tab.active) {
                return `${prefix}${currentTheme.bg("primary", currentTheme.boldFg("text", ` ${tab.label} `))}`;
              }
              return `${prefix}${currentTheme.fg("textDim", tab.label)}`;
            })
            .join("")}
        </Text>
      ) : null}
      {selector.searchable && selector.query.length > 0 ? (
        <Text>
          {currentTheme.fg("primary", "Search: ")}
          {selector.query}
        </Text>
      ) : null}
      {selector.rows.length === 0 ? (
        <Text>{currentTheme.fg("textMuted", "No matches")}</Text>
      ) : (
        selector.rows.map((row, index) => {
          const pointer =
            index === selector.pageSelectedIndex ? SELECT_POINTER : " ";
          const name =
            index === selector.pageSelectedIndex
              ? currentTheme.boldFg("primary", row.name)
              : currentTheme.fg("text", row.name);
          const current = row.isCurrent ? ` ${CURRENT_MARK}` : "";
          return (
            <Text key={row.alias}>
              {`  ${pointer} `}
              {name}
              {`  ${currentTheme.fg("textMuted", row.provider)}`}
              {currentTheme.fg("success", current)}
            </Text>
          );
        })
      )}
      {selector.query.length > 0 ? (
        <Text>
          {currentTheme.fg(
            "textMuted",
            `${String(selector.filteredCount)} / ${String(selector.totalCount)}`,
          )}
        </Text>
      ) : selector.belowCount > 0 ? (
        <Text>
          {currentTheme.fg(
            "textMuted",
            `▼ ${String(selector.belowCount)} more`,
          )}
        </Text>
      ) : null}
      {selector.thinkingHeader === undefined ? null : (
        <Box flexDirection="column">
          <Text>{currentTheme.fg("textMuted", selector.thinkingHeader)}</Text>
          <Text>
            {selector.thinkingSegments
              .map((segment) => {
                if (segment.unavailable) {
                  return currentTheme.fg("textMuted", `  ${segment.label}  `);
                }
                return segment.active
                  ? currentTheme.boldFg("primary", `[ ${segment.label} ]`)
                  : currentTheme.fg("text", `  ${segment.label}  `);
              })
              .join("  ")}
          </Text>
        </Box>
      )}
    </Box>
  );
}
