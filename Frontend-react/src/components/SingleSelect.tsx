import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface SingleSelectOption { value: string; label: string }

interface Props {
  id?: string;
  label: string;
  options: (string | SingleSelectOption)[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  emptyText?: string;
  disabled?: boolean;
  invalid?: boolean;
  locked?: boolean;
  normalizeQuery?: (value: string) => string;
  searchable?: boolean;
  showRadio?: boolean;
  /** เปิดแผงนอกกรอบ scroll ของตาราง เช่น Lookup Tables */
  portal?: boolean;
}

/** Dropdown with exactly one selected value and an optional fixed search field. */
export default function SingleSelect({
  id, label, options, value, onChange, placeholder, emptyText = "ไม่มีตัวเลือก",
  disabled = false, invalid = false, locked = false, normalizeQuery,
  searchable = true, showRadio = true, portal = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const placementRef = useRef<"above" | "below" | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    if (searchable) searchRef.current?.focus({ preventScroll: true });
    else {
      (listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?? listRef.current?.querySelector<HTMLElement>('[role="option"]'))?.focus({ preventScroll: true });
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)
        && !panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus({ preventScroll: true }); }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, searchable]);

  useEffect(() => { if (disabled || locked) setOpen(false); }, [disabled, locked]);

  const choices = options.map((option) => typeof option === "string" ? { value: option, label: option } : option);
  const selectedLabel = choices.find((option) => option.value === value)?.label ?? value;
  const q = query.trim().toLocaleLowerCase();
  const rank = (label: string) => {
    const text = label.toLocaleLowerCase();
    return text === q ? 0 : text.startsWith(q) ? 1 : 2;
  };
  const shown = q
    ? choices.filter((option) => option.label.toLocaleLowerCase().includes(q))
        .sort((a, b) => rank(a.label) - rank(b.label))
    : choices;

  useLayoutEffect(() => {
    if (!open || !portal) {
      placementRef.current = null;
      return;
    }
    const position = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(rect.width, window.innerWidth - 16);
      const height = panelRef.current?.offsetHeight ?? 280;
      const below = window.innerHeight - rect.bottom;
      if (placementRef.current === null) {
        placementRef.current = below < height + 8 && rect.top >= height + 8 ? "above" : "below";
      }
      setPanelStyle({
        position: "absolute",
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + window.scrollX,
        top: (placementRef.current === "above" ? rect.top - height - 3 : rect.bottom + 3) + window.scrollY,
      });
    };
    position();
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open, portal, query, shown.length]);

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const current = items.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };

  const panel = open && (
    <div ref={panelRef}
      className={`ms-panel entry-single-select-panel${portal ? " portal-single-select-panel" : ""}`}
      style={portal ? panelStyle : undefined}>
      {searchable && <input
        ref={searchRef}
        className="ms-search"
        type="search"
        value={query}
        placeholder="พิมพ์เพื่อค้นหา…"
        aria-label={`ค้นหา ${label}`}
        onChange={(event) => setQuery(normalizeQuery ? normalizeQuery(event.target.value) : event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); }
          if (event.key === "Enter" && shown.length === 1) {
            event.preventDefault();
            onChange(shown[0].value);
            setOpen(false);
            buttonRef.current?.focus({ preventScroll: true });
          }
        }}
      />}
      <div ref={listRef} className="entry-single-select-list" role="listbox" aria-label={label}>
        {shown.length === 0 ? (
          <div className="ms-empty">{options.length ? `ไม่พบ “${query}”` : emptyText}</div>
        ) : shown.map((option) => (
          <button
            type="button"
            role="option"
            aria-selected={value === option.value}
            key={option.value}
            className={`entry-single-select-option${showRadio ? "" : " no-radio"}`}
            onKeyDown={handleOptionKeyDown}
            onClick={() => { onChange(option.value); setOpen(false); buttonRef.current?.focus({ preventScroll: true }); }}
          >
            {showRadio && <span className={`entry-single-select-radio${value === option.value ? " selected" : ""}`} aria-hidden="true" />}
            <span className="entry-single-select-text">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`ms entry-single-select${open ? " open" : ""}`} ref={rootRef}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={`ms-btn entry-single-select-button${invalid ? " invalid" : ""}${locked ? " auto-locked" : ""}`}
        disabled={disabled || locked}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className={`ms-txt${value ? "" : " none"}`}>{value ? selectedLabel : placeholder}</span>
        <span aria-hidden="true" className="entry-single-select-arrow">▾</span>
      </button>
      {portal ? (open && createPortal(panel, document.body)) : panel}
    </div>
  );
}
