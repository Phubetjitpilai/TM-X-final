import { useEffect, useRef, useState } from "react";

interface Props {
  label: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

const WEEKDAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
type PickerState = { panelIndex: 0 | 1; year: number; mode: "month" | "year" } | null;

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseIso(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return isoDate(date) === value ? date : null;
}

function displayDate(value: string): string {
  const date = parseIso(value);
  return date
    ? `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`
    : "";
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function shiftMonth(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export default function DateRangeFilter({ label, from, to, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => monthStart(parseIso(from) ?? new Date()));
  const [picker, setPicker] = useState<PickerState>(null);
  const [panel, setPanel] = useState({ left: 0, top: 0, width: 560 });

  function openCalendar() {
    if (open) { setOpen(false); return; }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(560, window.innerWidth - 24);
    setPanel({
      width,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: window.innerHeight - rect.bottom >= 380 ? rect.bottom + 4 : Math.max(8, rect.top - 400),
    });
    setViewMonth(monthStart(parseIso(from) ?? new Date()));
    setPicker(null);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    window.addEventListener("resize", closeOnScroll);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
      window.removeEventListener("resize", closeOnScroll);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [open]);

  function chooseDay(day: string) {
    if (!from || to || day < from) {
      onChange(day, "");
    } else {
      onChange(from, day);
      setOpen(false);
    }
  }

  function changeVisibleMonth(months: number) {
    setViewMonth((current) => shiftMonth(current, months));
    setPicker(null);
  }

  function monthOrYearPicker(month: Date, panelIndex: 0 | 1) {
    if (!picker || picker.panelIndex !== panelIndex) return null;
    const decade = Math.floor(picker.year / 10) * 10;
    return (
      <div className="date-range-picker-view">
        <div className="date-range-picker-header">
          <button type="button" onClick={() => setPicker({ ...picker, year: picker.year - (picker.mode === "year" ? 10 : 1) })} aria-label={picker.mode === "year" ? "สิบปีก่อนหน้า" : "ปีก่อนหน้า"}>«</button>
          <button
            type="button"
            className="date-range-picker-heading"
            onClick={() => picker.mode === "month" && setPicker({ ...picker, mode: "year" })}
            aria-label={picker.mode === "month" ? "เลือกปี" : undefined}
          >
            {picker.mode === "month" ? picker.year : `${decade}–${decade + 9}`}
          </button>
          <button type="button" onClick={() => setPicker({ ...picker, year: picker.year + (picker.mode === "year" ? 10 : 1) })} aria-label={picker.mode === "year" ? "สิบปีถัดไป" : "ปีถัดไป"}>»</button>
        </div>
        <div className="date-range-picker-grid">
          {picker.mode === "month"
            ? MONTHS.map((name, index) => (
                <button
                  type="button"
                  key={name}
                  className={month.getFullYear() === picker.year && month.getMonth() === index ? "current" : ""}
                  onClick={() => {
                    setViewMonth(new Date(picker.year, index - panelIndex, 1));
                    setPicker(null);
                  }}
                  aria-label={`${name} ${picker.year}`}
                >{name}</button>
              ))
            : Array.from({ length: 12 }, (_, index) => decade - 1 + index).map((year) => (
                <button
                  type="button"
                  key={year}
                  className={`${year < decade || year > decade + 9 ? "outside" : ""}${year === month.getFullYear() ? " current" : ""}`}
                  onClick={() => setPicker({ ...picker, year, mode: "month" })}
                  aria-label={`ปี ${year}`}
                >{year}</button>
              ))}
        </div>
      </div>
    );
  }

  function calendar(month: Date, panelIndex: 0 | 1) {
    const firstWeekday = month.getDay();
    return (
      <div className="date-range-month" key={isoDate(month)}>
        {picker?.panelIndex === panelIndex ? monthOrYearPicker(month, panelIndex) : <>
        <div className="date-range-month-title">
          <button type="button" onClick={() => setPicker({ panelIndex, year: month.getFullYear(), mode: "month" })} aria-label={`เลือกเดือนของ ${MONTHS[month.getMonth()]} ${month.getFullYear()}`}>{MONTHS[month.getMonth()]}</button>
          <button type="button" onClick={() => setPicker({ panelIndex, year: month.getFullYear(), mode: "year" })} aria-label={`เลือกปี ${month.getFullYear()}`}>{month.getFullYear()}</button>
        </div>
        <div className="date-range-days">
          {WEEKDAYS.map((day, index) => <span className="date-range-weekday" key={index}>{day}</span>)}
          {Array.from({ length: 42 }, (_, index) => {
            const date = new Date(month.getFullYear(), month.getMonth(), index - firstWeekday + 1);
            const value = isoDate(date);
            const outside = date.getMonth() !== month.getMonth();
            const edge = !outside && (value === from || value === to);
            return (
              <button
                type="button"
                className={`date-range-day${outside ? " outside" : ""}${!outside && from && to && value > from && value < to ? " in-range" : ""}${edge ? " range-edge" : ""}`}
                key={value}
                onClick={() => chooseDay(value)}
                aria-label={displayDate(value)}
                aria-pressed={edge}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
        </>}
      </div>
    );
  }

  return (
    <div className="fg date-range-filter" ref={rootRef}>
      <label>{label}</label>
      <button type="button" className={`date-range-trigger${open ? " open" : ""}`} onClick={openCalendar} aria-expanded={open} aria-label={`${label}: ${displayDate(from) || "ยังไม่เลือกวันที่เริ่มต้น"} ถึง ${displayDate(to) || "ยังไม่เลือกวันสุดท้าย"}`}>
        <span className={from ? "" : "placeholder"}>{displayDate(from) || "วันที่เริ่มต้น"}</span>
        <span className="date-range-separator" aria-hidden="true">→</span>
        <span className={to ? "" : "placeholder"}>{displayDate(to) || "วันสุดท้าย"}</span>
        <svg className="date-range-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M7 3v4M17 3v4M3 10h18" />
        </svg>
      </button>
      {open && (
        <div className="date-range-panel" style={{ left: panel.left, top: panel.top, width: panel.width }}>
          <div className="date-range-header">
            <div className="date-range-nav">
              <button type="button" onClick={() => changeVisibleMonth(-12)} aria-label="ปีก่อนหน้า">«</button>
              <button type="button" onClick={() => changeVisibleMonth(-1)} aria-label="เดือนก่อนหน้า">‹</button>
            </div>
            <span>เลือกวันที่เริ่มต้น แล้วเลือกวันสุดท้าย</span>
            <div className="date-range-nav">
              <button type="button" onClick={() => changeVisibleMonth(1)} aria-label="เดือนถัดไป">›</button>
              <button type="button" onClick={() => changeVisibleMonth(12)} aria-label="ปีถัดไป">»</button>
            </div>
          </div>
          <div className="date-range-calendars">
            {calendar(viewMonth, 0)}
            {calendar(shiftMonth(viewMonth, 1), 1)}
          </div>
          <div className="date-range-footer">
            <span>{displayDate(from) || "วันที่เริ่มต้น"} → {displayDate(to) || "วันสุดท้าย"}</span>
            <button type="button" onClick={() => { onChange("", ""); setOpen(false); }}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
