'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A from-scratch calendar picker rather than the native `<input type="date">` — deliberately,
 * since the native control renders inconsistently across browsers and can't be styled to match
 * the rest of the app. No date library either: everything the app does with a due date is pure
 * calendar arithmetic (year/month/day), so plain integers avoid pulling in a dependency for
 * something this bounded.
 *
 * The value contract is the same "YYYY-MM-DD" string the API already expects. Calendar-grid
 * math uses local Date methods (getDay/getDate) purely for day-of-week and month-length
 * layout — never for the output, which is built directly from the y/m/d integers. That
 * separation matters: going through `Date#toISOString()` for the OUTPUT would risk an
 * off-by-one-day bug depending on the browser's local timezone offset.
 */

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toValue(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function parseValue(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
}

function formatDisplay(value: string): string {
  const parsed = parseValue(value);
  if (!parsed) return '';
  // A local Date purely for display formatting (Intl needs a Date object) — noon avoids any
  // DST-boundary edge case nudging the displayed day backward or forward.
  const d = new Date(parsed.year, parsed.month, parsed.day, 12);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Weeks of cells for a given month, including the leading/trailing days needed for a full grid. */
function buildMonthGrid(year: number, month: number): { date: number; inMonth: boolean; year: number; month: number }[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells: { date: number; inMonth: boolean; year: number; month: number }[] = [];

  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({ date: daysInPrevMonth - i, inMonth: false, year: month === 0 ? year - 1 : year, month: month === 0 ? 11 : month - 1 });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: d, inMonth: true, year, month });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const last = cells[cells.length - 1]!;
    const nextMonth = last.month === 11 ? 0 : last.month + 1;
    const nextYear = last.month === 11 ? last.year + 1 : last.year;
    cells.push({ date: cells.length - (daysInMonth + firstWeekday) + 1, inMonth: false, year: nextYear, month: nextMonth });
    if (cells.length >= 42) break;
  }

  return cells;
}

export interface DatePickerProps {
  id?: string;
  value: string; // 'YYYY-MM-DD' or ''
  onChange: (value: string) => void;
  required?: boolean;
  /** Dates strictly before this are not selectable. 'YYYY-MM-DD'. */
  min?: string;
}

export function DatePicker({ id, value, onChange, required, min }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = parseValue(value);
  const today = new Date();
  const [viewYear, setViewYear] = useState(selected?.year ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected?.month ?? today.getMonth());

  const minParsed = min ? parseValue(min) : null;
  const minValue = minParsed ? toValue(minParsed.year, minParsed.month, minParsed.day) : null;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  function openPicker() {
    if (selected) {
      setViewYear(selected.year);
      setViewMonth(selected.month);
    }
    setOpen(true);
  }

  function goToPrevMonth() {
    setViewMonth((m) => {
      if (m === 0) {
        setViewYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }

  function goToNextMonth() {
    setViewMonth((m) => {
      if (m === 11) {
        setViewYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }

  function selectDay(year: number, month: number, day: number) {
    const next = toValue(year, month, day);
    if (minValue && next < minValue) return;
    onChange(next);
    setOpen(false);
  }

  const cells = buildMonthGrid(viewYear, viewMonth);
  const todayValue = toValue(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <div className="relative" ref={containerRef}>
      <button
        id={id}
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg border border-black/15 bg-transparent px-3 py-2 text-left text-sm outline-none transition-colors focus:border-accent dark:border-white/20"
      >
        <span className={value ? '' : 'text-black/40 dark:text-white/40'}>
          {value ? formatDisplay(value) : 'Select a date'}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-black/40 dark:text-white/40">
          <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {/* A hidden required input keeps native form validation ("please fill this field")
          working without reintroducing the native date picker UI itself. */}
      {required && <input tabIndex={-1} className="sr-only" required value={value} onChange={() => {}} />}

      {open && (
        <div
          role="dialog"
          aria-label="Choose a date"
          className="absolute z-20 mt-2 w-72 rounded-xl border border-black/10 bg-background p-3 shadow-lg dark:border-white/10"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={goToPrevMonth}
              aria-label="Previous month"
              className="rounded-md p-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
            >
              ‹
            </button>
            <span className="text-sm font-medium">
              {MONTH_LABELS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={goToNextMonth}
              aria-label="Next month"
              className="rounded-md p-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 gap-y-1 text-center text-xs text-black/40 dark:text-white/40">
            {WEEKDAY_LABELS.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-y-1 text-center text-sm">
            {cells.map((cell, i) => {
              const cellValue = toValue(cell.year, cell.month, cell.date);
              const isSelected = cellValue === value;
              const isToday = cellValue === todayValue;
              const isDisabled = minValue !== null && cellValue < minValue;

              return (
                <button
                  key={i}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => selectDay(cell.year, cell.month, cell.date)}
                  className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    isSelected
                      ? 'bg-accent text-accent-foreground font-medium'
                      : isDisabled
                        ? 'cursor-not-allowed text-black/20 dark:text-white/20'
                        : cell.inMonth
                          ? 'hover:bg-accent-soft dark:hover:bg-white/10'
                          : 'text-black/30 hover:bg-black/5 dark:text-white/25 dark:hover:bg-white/5'
                  } ${isToday && !isSelected ? 'ring-1 ring-inset ring-accent/50' : ''}`}
                >
                  {cell.date}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
