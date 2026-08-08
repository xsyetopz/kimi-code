import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface PromptInputProps {
  readonly busy: boolean;
  readonly permissionPrompt?: { readonly toolName: string };
  readonly onSubmit: (text: string) => void;
  readonly onPermission: (answer: "y" | "n" | "a") => void;
  readonly onAbort: () => void;
  readonly onSteer: (text: string) => void;
  readonly onExit: () => void;
}

/**
 * Dense prompt box. Enter submits; while busy, Enter steers (pi-style).
 * Ctrl+C aborts the turn when busy, else exits.
 */
export function PromptInput(props: PromptInputProps) {
  const {
    busy,
    permissionPrompt,
    onSubmit,
    onPermission,
    onAbort,
    onSteer,
    onExit,
  } = props;
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (permissionPrompt) {
      if (input === "y" || input === "Y") onPermission("y");
      else if (input === "n" || input === "N") onPermission("n");
      else if (input === "a" || input === "A") onPermission("a");
      return;
    }
    if (key.ctrl && input === "c") {
      if (busy) onAbort();
      else onExit();
      return;
    }
    if (key.return) {
      const text = value;
      setValue("");
      if (!text.trim()) return;
      const trimmed = text.trim();
      if (trimmed === "/exit" || trimmed === "/quit") {
        onExit();
        return;
      }
      if (busy && !trimmed.startsWith("/")) onSteer(text);
      else onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((current) => current + input);
    }
  });

  if (permissionPrompt) {
    return (
      <Box paddingX={1}>
        <Text color="yellow">
          Allow tool {permissionPrompt.toolName}? [y/N/a]
        </Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color="cyan" bold>
        {busy ? "steer› " : "› "}
      </Text>
      <Text>{value}</Text>
      <Text dimColor>█</Text>
    </Box>
  );
}
