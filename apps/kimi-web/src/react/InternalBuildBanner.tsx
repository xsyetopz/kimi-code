import { isDesktop } from "../lib/desktopFlag";
import { safeGetString, STORAGE_KEYS } from "../lib/storage";

const labels = {
  en: "Internal testing only",
  zh: "仅供内部测试",
} as const;

function label(): string {
  return safeGetString(STORAGE_KEYS.locale) === "zh" ? labels.zh : labels.en;
}

/** React-owned desktop-only build marker. */
export function InternalBuildBanner(): React.ReactElement | null {
  if (!isDesktop) return null;
  const text = label();
  return (
    <span className="internal-build-tag internal-build-fab" role="note" aria-label={text}>
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 2 14 13H2L8 2Z" />
        <path d="M8 6v3.5" />
        <path d="M8 11.5h.01" />
      </svg>
      <span>{text}</span>
    </span>
  );
}
