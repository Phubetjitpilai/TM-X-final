import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  locked?: boolean;
  label: string;
}

const WEEKDAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return isoDate(date) === match[0] ? date : null;
}

function displayDate(value: string): string {
  const date = parseDate(value);
  return date
    ? `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`
    : "";
}

function shiftMonth(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

export default function SingleDatePicker({ value, onChange, disabled = false, invalid = false, locked = false, label }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const selected = parseDate(value) ?? new Date();
    return new Date(selected.getFullYear(), selected.getMonth(), 1);
  });
  const [mode, setMode] = useState<"day" | "month" | "year">("day");
  const [panelYear, setPanelYear] = useState(viewMonth.getFullYear());
  const [panel, setPanel] = useState({ left: 0, top: 0, width: 330 });

  function toggleCalendar() {
    if (open) { setOpen(false); return; }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const selected = parseDate(value) ?? new Date();
    const width = Math.min(330, window.innerWidth - 24);
    setViewMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    setPanelYear(selected.getFullYear());
    setMode("day");
    setPanel({
      width,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: window.innerHeight - rect.bottom >= 390 ? rect.bottom + 4 : Math.max(8, rect.top - 400),
    });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    window.addEventListener("resize", closeOnScroll);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
      window.removeEventListener("resize", closeOnScroll);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [open]);

  useEffect(() => { if (disabled || locked) setOpen(false); }, [disabled, locked]);

  function selectDay(date: Date) {
    onChange(isoDate(date));
    setOpen(false);
  }

  function move(amount: number) {
    if (mode === "day") setViewMonth((current) => shiftMonth(current, amount));
    else setPanelYear((current) => current + amount * (mode === "year" ? 10 : 1));
  }

  const decade = Math.floor(panelYear / 10) * 10;
  const firstWeekday = viewMonth.getDay();

  return (
    <div className="entry-date-picker" ref={rootRef}>
      <button
        type="button"
        className={`date-range-trigger entry-date-trigger${open ? " open" : ""}${invalid ? " invalid" : ""}${locked ? " auto-locked" : ""}`}
        disabled={disabled || locked}
        onClick={toggleCalendar}
        aria-label={`${label}: ${displayDate(value) || "ยังไม่เลือก"}`}
        aria-expanded={open}
      >
        <span className={value ? "" : "placeholder"}>{displayDate(value) || "dd/mm/yyyy"}</span>
        <svg className="date-range-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M7 3v4M17 3v4M3 10h18" />
        </svg>
      </button>
      {open && (
        <div className="date-range-panel single-date-panel" style={{ left: panel.left, top: panel.top, width: panel.width }}>
          <div className="single-date-header">
            <div className="date-range-nav">
              <button type="button" onClick={() => move(mode === "day" ? -12 : -1)} aria-label={mode === "year" ? "สิบปีก่อนหน้า" : "ปีก่อนหน้า"}>«</button>
              {mode === "day" && <button type="button" onClick={() => move(-1)} aria-label="เดือนก่อนหน้า">‹</button>}
            </div>
            {mode === "day" ? (
              <div className="date-range-month-title">
                <button type="button" onClick={() => { setPanelYear(viewMonth.getFullYear()); setMode("month"); }} aria-label="เลือกเดือน">{MONTHS[viewMonth.getMonth()]}</button>
                <button type="button" onClick={() => { setPanelYear(viewMonth.getFullYear()); setMode("year"); }} aria-label="เลือกปี">{viewMonth.getFullYear()}</button>
              </div>
            ) : (
              <button type="button" className="single-date-heading" onClick={() => mode === "month" && setMode("year")}>
                {mode === "month" ? panelYear : `${decade}–${decade + 9}`}
              </button>
            )}
            <div className="date-range-nav">
              {mode === "day" && <button type="button" onClick={() => move(1)} aria-label="เดือนถัดไป">›</button>}
              <button type="button" onClick={() => move(mode === "day" ? 12 : 1)} aria-label={mode === "year" ? "สิบปีถัดไป" : "ปีถัดไป"}>»</button>
            </div>
          </div>
          {mode === "day" ? (
            <div className="date-range-days single-date-days">
              {WEEKDAYS.map((day, index) => <span className="date-range-weekday" key={index}>{day}</span>)}
              {Array.from({ length: 42 }, (_, index) => {
                const date = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), index - firstWeekday + 1);
                const selected = isoDate(date) === value.slice(0, 10);
                return (
                  <button
                    type="button"
                    key={isoDate(date)}
                    className={`date-range-day${date.getMonth() !== viewMonth.getMonth() ? " outside" : ""}${selected ? " range-edge" : ""}`}
                    onClick={() => selectDay(date)}
                    aria-label={displayDate(isoDate(date))}
                    aria-pressed={selected}
                  >{date.getDate()}</button>
                );
              })}
            </div>
          ) : (
            <div className="date-range-picker-grid single-date-picker-grid">
              {mode === "month"
                ? MONTHS.map((name, index) => (
                    <button type="button" key={name} className={viewMonth.getFullYear() === panelYear && viewMonth.getMonth() === index ? "current" : ""}
                      onClick={() => { setViewMonth(new Date(panelYear, index, 1)); setMode("day"); }} aria-label={`${name} ${panelYear}`}>{name}</button>
                  ))
                : Array.from({ length: 12 }, (_, index) => decade - 1 + index).map((year) => (
                    <button type="button" key={year} className={`${year < decade || year > decade + 9 ? "outside" : ""}${year === viewMonth.getFullYear() ? " current" : ""}`}
                      onClick={() => { setPanelYear(year); setMode("month"); }} aria-label={`ปี ${year}`}>{year}</button>
                  ))}
            </div>
          )}
          <div className="single-date-footer">
            <button type="button" onClick={() => selectDay(new Date())}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
