import { Box, Text } from "ink";

export interface ToolCardProps {
  readonly name: string;
  readonly id?: string;
  readonly result?: string;
  readonly isError?: boolean;
}

export function ToolCard(props: ToolCardProps) {
  const { name, id, result, isError } = props;
  return (
    <Box
      flexDirection="column"
      marginY={0}
      paddingX={1}
      borderStyle="round"
      borderColor={isError ? "red" : "cyan"}
    >
      <Text>
        <Text color="cyan" bold>
          {name}
        </Text>
        {id ? <Text dimColor> · {id.slice(0, 8)}</Text> : null}
      </Text>
      {result !== undefined ? (
        isError ? (
          <Text color="red">{truncate(result, 400)}</Text>
        ) : (
          <Text>{truncate(result, 400)}</Text>
        )
      ) : (
        <Text dimColor>…</Text>
      )}
    </Box>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
