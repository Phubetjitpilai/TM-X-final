import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

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
}

/** Dropdown with exactly one selected value and an optional fixed search field. */
export default function SingleSelect({
  id, label, options, value, onChange, placeholder, emptyText = "ไม่มีตัวเลือก",
  disabled = false, invalid = false, locked = false, normalizeQuery,
  searchable = true, showRadio = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    if (searchable) searchRef.current?.focus();
    else {
      (listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?? listRef.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
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
      {open && (
        <div className="ms-panel entry-single-select-panel">
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
                buttonRef.current?.focus();
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
                onClick={() => { onChange(option.value); setOpen(false); buttonRef.current?.focus(); }}
              >
                {showRadio && <span className={`entry-single-select-radio${value === option.value ? " selected" : ""}`} aria-hidden="true" />}
                <span className="entry-single-select-text">{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
