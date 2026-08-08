import { Box, Text } from "ink";
import type { FooterState } from "../render";
import type { WysiwygToggles } from "../toggles";
import { renderFooter } from "../render";

export interface FooterProps {
  readonly state: FooterState;
  readonly toggles: WysiwygToggles;
  readonly busy?: boolean;
}

export function Footer({ state, toggles, busy }: FooterProps) {
  const text = renderFooter(state, toggles);
  return (
    <Box
      borderStyle="single"
      paddingX={1}
      justifyContent="space-between"
      width="100%"
    >
      <Text dimColor>{text}</Text>
      {busy ? <Text color="yellow">● running</Text> : <Text dimColor>idle</Text>}
    </Box>
  );
}
