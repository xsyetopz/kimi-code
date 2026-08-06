import { Box, Text } from "ink";
import { type ReactNode } from "react";

import { SELECT_POINTER } from "../../../../constant/symbols";
import { currentTheme } from "../../../../theme";
import type { InkExperimentsSelectorView } from "../../sessions/experiments-selector";

export interface InkExperimentsSelectorDialogProps {
  readonly selector: InkExperimentsSelectorView;
}

export function InkExperimentsSelectorDialog({
  selector,
}: InkExperimentsSelectorDialogProps): ReactNode {
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
      {selector.query.length > 0 ? (
        <Text>
          {currentTheme.fg("primary", "Search: ")}
          {selector.query}
        </Text>
      ) : null}
      {selector.rows.length === 0 ? (
        <Text>{currentTheme.fg("textMuted", "No matches")}</Text>
      ) : (
        selector.rows.map((row) => {
          const pointer = row.selected ? SELECT_POINTER : " ";
          const title = row.selected
            ? currentTheme.boldFg("primary", row.title)
            : currentTheme.fg("text", row.title);
          const status = row.enabled
            ? currentTheme.fg("success", "enabled")
            : currentTheme.fg("textDim", "disabled");
          return (
            <Box flexDirection="column" key={row.id}>
              <Text>
                {currentTheme.fg(row.selected ? "primary" : "textDim", `  ${pointer} `)}
                {title}
                {"  "}
                {status}
              </Text>
              <Text>{currentTheme.fg("textMuted", `    ${row.detail}`)}</Text>
              {row.descriptionLines.map((line) => (
                <Text key={`${row.id}:${line}`}>
                  {currentTheme.fg("textMuted", `    ${line}`)}
                </Text>
              ))}
            </Box>
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
          {currentTheme.fg("textMuted", `▼ ${String(selector.belowCount)} more`)}
        </Text>
      ) : null}
      <Text>
        {selector.applyEnabled
          ? `${currentTheme.boldFg("primary", selector.applyLabel)}  ${currentTheme.fg("success", selector.applySummary)}`
          : `${currentTheme.fg("textDim", selector.applyLabel)}  ${currentTheme.fg("textMuted", selector.applySummary)}`}
      </Text>
    </Box>
  );
}
