import type { DiffViewLine, ToolDiffTarget } from "../types";
import { iconSvg } from "../lib/icons";

import "./ToolDiffPanel.css";

export interface ToolDiffPanelLabels {
  close: string;
  noDiff: string;
}

export interface ToolDiffPanelProps {
  target: ToolDiffTarget;
  labels: ToolDiffPanelLabels;
  onClose: () => void;
}

function DiffLines({ lines }: { lines: DiffViewLine[] }): React.ReactElement {
  return (
    <div className="react-tool-diff-lines">
      {lines.map((line, index) => {
        const className = `react-tool-diff-line react-tool-diff-line--${line.type}`;
        if (line.type === "hunk") {
          return (
            <div className={className} key={index}>
              <span className="react-tool-diff-hunk-text">{line.text}</span>
            </div>
          );
        }

        return (
          <div className={className} key={index}>
            <span className="react-tool-diff-gutter react-tool-diff-gutter--old">
              {line.oldNo === undefined ? "" : String(line.oldNo)}
            </span>
            <span className="react-tool-diff-gutter react-tool-diff-gutter--new">
              {line.newNo === undefined ? "" : String(line.newNo)}
            </span>
            <span className="react-tool-diff-sign">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            <span className="react-tool-diff-text">{line.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function PanelHeader({
  title,
  subtitle,
  closeLabel,
  onClose,
}: {
  title: string;
  subtitle?: string;
  closeLabel: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="react-tool-diff-panel__header">
      <span className="react-tool-diff-panel__title">{title}</span>
      {subtitle ? (
        <span
          className="react-tool-diff-panel__subtitle"
          title={subtitle}
        >
          {subtitle}
        </span>
      ) : null}
      <button
        className="react-tool-diff-panel__close"
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={onClose}
      >
        <span
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: iconSvg("close", "sm") }}
        />
      </button>
    </div>
  );
}

/**
 * React-owned rendering for an Edit/Write tool-call preview. The Vue host
 * supplies the live target and translated labels while this component owns
 * the complete visible panel and close interaction.
 */
export function ToolDiffPanel({
  target,
  labels,
  onClose,
}: ToolDiffPanelProps): React.ReactElement {
  const hasLines = target.lines !== null && target.lines.length > 0;
  const hasOutput = !hasLines && (target.output?.length ?? 0) > 0;

  return (
    <div className="react-tool-diff-panel">
      <PanelHeader
        title={target.title}
        subtitle={target.path}
        closeLabel={labels.close}
        onClose={onClose}
      />
      <div className="react-tool-diff-panel__body">
        {hasLines ? <DiffLines lines={target.lines!} /> : null}
        {hasOutput ? (
          <div className="react-tool-diff-panel__output">
            {target.output!.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        ) : null}
        {!hasLines && !hasOutput ? (
          <div className="react-tool-diff-panel__empty">{labels.noDiff}</div>
        ) : null}
      </div>
    </div>
  );
}

