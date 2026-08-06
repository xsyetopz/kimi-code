import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AppModel } from "../api/types";
import { formatTokens } from "../lib/formatTokens";
import { iconSvg, type IconName, type IconSize } from "../lib/icons";

import "./ModelPicker.css";

/** Localized copy supplied by the Vue host while the shell is migrating. */
export interface ModelPickerLabels {
  title: string;
  close: string;
  allTab: string;
  providerTabs: string;
  searchPlaceholder: string;
  loading: string;
  unavailable: string;
  contextSuffix: (size: string) => string;
  emptyNoModels: string;
  emptyNoMatch: string;
  starTitle: string;
  unstarTitle: string;
  footerHint: string;
}

export interface ModelPickerProps {
  models: AppModel[];
  current: string;
  starredIds?: string[];
  loading?: boolean;
  unavailable?: boolean;
  labels: ModelPickerLabels;
  onSelect: (modelId: string) => void;
  onToggleStar: (modelId: string) => void;
  onClose: () => void;
}

export interface ModelPickerTab {
  id: string;
  label: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Preserve the Vue picker ordering: All, then providers in first-seen order. */
export function modelPickerTabs(
  models: AppModel[],
  allLabel: string,
): ModelPickerTab[] {
  const seen = new Set<string>();
  const tabs: ModelPickerTab[] = [{ id: "all", label: allLabel }];
  for (const model of models) {
    if (seen.has(model.provider)) continue;
    seen.add(model.provider);
    tabs.push({ id: model.provider, label: model.provider });
  }
  return tabs;
}

/** Apply the picker search/provider filter and the All-tab starred ordering. */
export function filterModelPickerModels(
  models: AppModel[],
  query: string,
  activeTab: string,
  starredIds: string[] = [],
): AppModel[] {
  const normalizedQuery = query.toLowerCase().trim();
  const starred = new Set(starredIds);
  const list = models.filter((model) => {
    if (activeTab !== "all" && model.provider !== activeTab) return false;
    const matchName = (model.displayName ?? model.model)
      .toLowerCase()
      .includes(normalizedQuery);
    const matchProvider = model.provider.toLowerCase().includes(normalizedQuery);
    const matchId = model.id.toLowerCase().includes(normalizedQuery);
    return !normalizedQuery || matchName || matchProvider || matchId;
  });
  if (activeTab !== "all") return list;
  return list.sort((a, b) =>
    Number(starred.has(b.id)) - Number(starred.has(a.id)),
  );
}

function RegisteredIcon({
  name,
  size = "md",
}: {
  name: IconName;
  size?: IconSize;
}): React.ReactElement {
  return (
    <span
      dangerouslySetInnerHTML={{ __html: iconSvg(name, size) }}
      aria-hidden="true"
    />
  );
}

function Spinner({ label }: { label: string }): React.ReactElement {
  return (
    <span className="model-picker__spinner" role="status" aria-label={label}>
      <svg className="model-picker__spinner-svg" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="model-picker__spinner-track" cx="12" cy="12" r="9" />
        <circle className="model-picker__spinner-arc" cx="12" cy="12" r="9" />
      </svg>
    </span>
  );
}

/**
 * React-owned model selection dialog. The host keeps catalog state and event
 * ownership in Vue until the surrounding app shell migrates.
 */
export function ModelPicker({
  models,
  current,
  starredIds = [],
  loading = false,
  unavailable = false,
  labels,
  onSelect,
  onToggleStar,
  onClose,
}: ModelPickerProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  const onSelectRef = useRef(onSelect);
  onCloseRef.current = onClose;
  onSelectRef.current = onSelect;

  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [selectedIdx, setSelectedIdx] = useState(0);

  const tabs = useMemo(
    () => modelPickerTabs(models, labels.allTab),
    [models, labels.allTab],
  );
  const filtered = useMemo(
    () => filterModelPickerModels(models, query, activeTab, starredIds),
    [models, query, activeTab, starredIds],
  );

  // Match the Vue watchers: a changed query/tab starts at the first row, and
  // a changed model list cannot leave the keyboard cursor out of bounds.
  useEffect(() => {
    setSelectedIdx(0);
  }, [query, activeTab]);
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab("all");
  }, [tabs, activeTab]);
  useEffect(() => {
    setSelectedIdx((index) =>
      Math.min(index, Math.max(filtered.length - 1, 0)),
    );
  }, [filtered.length]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    previouslyFocused.current = document.activeElement;
    const panel = panelRef.current;
    searchRef.current?.focus();

    const focusables = (): HTMLElement[] =>
      panel
        ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        : [];

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIdx((index) =>
          Math.min(index + 1, Math.max(filtered.length - 1, 0)),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIdx((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        const model = filtered[selectedIdx];
        if (model) onSelectRef.current(model.id);
        return;
      }
      if (event.key !== "Tab") return;

      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
        previouslyFocused.current = null;
      }
    };
  }, [filtered, selectedIdx]);

  const content = (
    <div
      className="model-picker__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        className="model-picker__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-picker-title"
        tabIndex={-1}
      >
        <div className="model-picker__head">
          <div className="model-picker__titles">
            <div id="model-picker-title" className="model-picker__title">
              {labels.title}
            </div>
          </div>
          <button
            type="button"
            className="model-picker__close"
            aria-label={labels.close}
            onClick={() => onCloseRef.current()}
          >
            <RegisteredIcon name="close" />
          </button>
        </div>

        <div className="model-picker__body">
          <div className="model-picker__content">
            <div className="model-picker__search-wrap">
              <input
                ref={searchRef}
                className="model-picker__input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={labels.searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-label={labels.searchPlaceholder}
              />
            </div>

            {tabs.length > 1 ? (
              <div
                className="model-picker__tab-strip"
                role="tablist"
                aria-label={labels.providerTabs}
              >
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`model-picker__tab${tab.id === activeTab ? " is-active" : ""}`}
                    role="tab"
                    aria-selected={tab.id === activeTab}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ) : null}

            {loading ? (
              <div className="model-picker__state-row">
                <Spinner label={labels.loading} />
                <span>{labels.loading}</span>
              </div>
            ) : unavailable ? (
              <div className="model-picker__state-row model-picker__state-row--unavailable">
                <RegisteredIcon name="alert-triangle" size="lg" />
                <span>{labels.unavailable}</span>
              </div>
            ) : (
              <div className="model-picker__model-list" role="listbox">
                {filtered.map((model, index) => {
                  const starred = starredIds.includes(model.id);
                  const isCurrent = model.id === current;
                  const isSelected = index === selectedIdx;
                  return (
                    <div
                      key={model.id}
                      className={`model-picker__model-row${isCurrent ? " is-current" : ""}${isSelected ? " is-selected" : ""}`}
                      role="option"
                      aria-selected={isCurrent}
                      onClick={() => onSelectRef.current(model.id)}
                      onMouseEnter={() => setSelectedIdx(index)}
                    >
                      <span className="model-picker__check">
                        {isCurrent ? <RegisteredIcon name="check" size="sm" /> : null}
                      </span>
                      <span className="model-picker__model-main">
                        <span className="model-picker__model-name">
                          {model.displayName ?? model.model}
                        </span>
                        <span className="model-picker__model-id">{model.id}</span>
                        {model.capabilities && model.capabilities.length > 0 ? (
                          <span className="model-picker__caps">
                            {model.capabilities.map((capability) => (
                              <span key={capability} className="model-picker__badge">
                                {capability}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                      <span className="model-picker__model-provider">{model.provider}</span>
                      <span className="model-picker__model-context">
                        {labels.contextSuffix(formatTokens(model.maxContextSize))}
                      </span>
                      <button
                        type="button"
                        className="model-picker__icon-button"
                        aria-label={starred ? labels.unstarTitle : labels.starTitle}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleStar(model.id);
                        }}
                      >
                        <RegisteredIcon name={starred ? "star" : "star-outline"} />
                      </button>
                    </div>
                  );
                })}
                {filtered.length === 0 ? (
                  <div className="model-picker__empty">
                    {models.length === 0 ? labels.emptyNoModels : labels.emptyNoMatch}
                  </div>
                ) : null}
              </div>
            )}

            <div className="model-picker__footer-hint">{labels.footerHint}</div>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
