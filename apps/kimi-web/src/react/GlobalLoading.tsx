export interface GlobalLoadingLabels {
  connecting: string;
  connectRetrying: string;
}

export interface GlobalLoadingProps {
  /** Last connection error from the first-load retry loop. */
  issue?: string | null;
  /** Localized labels supplied by the Vue host during the strangler migration. */
  labels: GlobalLoadingLabels;
}

function PlainSpinner({ label }: { label: string }): React.ReactElement {
  return (
    <span className="gload-spinner" role="status" aria-label={label}>
      <svg className="gload-spinner__svg" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="gload-spinner__track" cx="12" cy="12" r="9" />
        <circle className="gload-spinner__arc" cx="12" cy="12" r="9" />
      </svg>
    </span>
  );
}

/**
 * Full-screen first-load splash. It remains a pure React surface; connection
 * state and localization stay at the Vue host until the app shell migrates.
 */
export function GlobalLoading({
  issue = null,
  labels,
}: GlobalLoadingProps): React.ReactElement {
  return (
    <div className="gload" role="status" aria-label={labels.connecting}>
      <div className="gload-box">
        {/* Official Kimi wordmark; this is a brand asset, not a functional icon. */}
        <svg
          className="gload-logo"
          viewBox="0 0 96 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M35.767 31.329c0 .37.3.671.67.671h4.305c.371 0 .672-.3.672-.671V.67c0-.37-.3-.671-.672-.671h-4.304c-.37 0-.671.3-.671.671z"
          />
          <path
            fill="currentColor"
            d="M90.353 31.329c0 .37.3.671.67.671h4.305c.371 0 .672-.3.672-.671V.67c0-.37-.3-.671-.672-.671h-4.304a.67.67 0 0 0-.671.671z"
          />
          <path
            fill="currentColor"
            d="M73.256 0a.67.67 0 0 0-.652.512l-6.366 26.1c-.106.428-.607.428-.71 0L59.159.512A.67.67 0 0 0 58.511 0H47.725c-.37 0-.668.3-.668.671V31.33c0 .37.3.671.67.671h4.781c.37 0 .671-.292.671-.662V5.554c0-.515.604-.622.726-.127l6.358 26.06a.67.67 0 0 0 .653.513h9.931c.31 0 .58-.212.653-.512L77.855 5.43c.122-.495.726-.388.726.127v25.772c0 .37.3.671.671.671h4.78c.371 0 .672-.3.672-.671V.67c0-.37-.3-.671-.671-.671z"
          />
          <path
            fill="currentColor"
            d="M15.279 14.837 28.264 1.133A.671.671 0 0 0 27.777 0h-6.043a.67.67 0 0 0-.477.199L6.374 15.223c-.231.234-.573.025-.573-.35V.672c0-.37-.3-.671-.671-.671H.67a.67.67 0 0 0-.67.67V31.33c0 .37.3.671.671.671H5.13c.37 0 .671-.3.671-.671v-6.114a.5.5 0 0 1 .13-.35l4.594-4.69a.293.293 0 0 1 .386-.045l12.286 9.305c1.796 1.245 4.083 2.06 6.178 2.401a.645.645 0 0 0 .743-.648v-5.537a.7.7 0 0 0-.562-.677c-1.215-.262-2.565-.758-3.59-1.468L15.332 15.58c-.22-.152-.248-.544-.052-.744"
          />
        </svg>
        <PlainSpinner label={labels.connecting} />
        <div className="gload-text">{labels.connecting}</div>
        {issue ? (
          <div className="gload-issue">
            <div>{labels.connectRetrying}</div>
            <div className="gload-issue-detail">{issue}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

