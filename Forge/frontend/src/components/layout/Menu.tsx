// Lightweight Blender-style menubar dropdown. A `<Menu label="File">`
// renders a clickable button that toggles a panel below it; inside, use
// `<MenuItem>` for actions, `<MenuSeparator />` for groups, and
// `<MenuSubmenu label="Export">` for nested groups.

import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface MenuProps {
  label: string;
  children: React.ReactNode;
  /** When true, this menu's button shows a "highlighted" style (e.g. for Edit while a hotkey is held). */
  active?: boolean;
}

export function Menu({ label, children, active }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          "rounded px-2 py-1 transition-colors " +
          (open || active
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-300 hover:bg-zinc-800")
        }
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 min-w-[200px] rounded border border-zinc-800 bg-zinc-950/95 py-1 shadow-xl"
          onClick={(e) => {
            // Auto-close when an item fires (items stop propagation if they
            // need to keep the menu open).
            if (!(e.target as HTMLElement).dataset.menuKeepOpen) {
              setOpen(false);
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface MenuItemProps {
  onClick?: () => void;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  children: React.ReactNode;
}

export function MenuItem({ onClick, icon, shortcut, disabled, children }: MenuItemProps) {
  return (
    <button
      onClick={() => !disabled && onClick?.()}
      disabled={disabled}
      className={
        "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] " +
        (disabled
          ? "cursor-not-allowed text-zinc-600"
          : "text-zinc-200 hover:bg-zinc-800/80")
      }
    >
      <span className="flex h-4 w-4 items-center justify-center text-zinc-400">
        {icon}
      </span>
      <span className="flex-1">{children}</span>
      {shortcut && (
        <span className="text-[11px] tabular-nums text-zinc-500">{shortcut}</span>
      )}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 border-t border-zinc-800" />;
}

interface MenuSubmenuProps {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export function MenuSubmenu({ label, icon, children }: MenuSubmenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      data-menu-keep-open
    >
      <div
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-[13px] text-zinc-200 hover:bg-zinc-800/80"
        data-menu-keep-open
      >
        <span className="flex h-4 w-4 items-center justify-center text-zinc-400">
          {icon}
        </span>
        <span className="flex-1">{label}</span>
        <ChevronRight size={12} className="text-zinc-500" />
      </div>
      {open && (
        <div
          className="absolute left-full top-0 z-50 -mt-1 ml-1 min-w-[180px] rounded border border-zinc-800 bg-zinc-950/95 py-1 shadow-xl"
          data-menu-keep-open
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuToggle({
  onClick,
  checked,
  icon,
  shortcut,
  children,
}: {
  onClick?: () => void;
  checked: boolean;
  icon?: React.ReactNode;
  shortcut?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] text-zinc-200 hover:bg-zinc-800/80"
    >
      <span className="flex h-4 w-4 items-center justify-center text-teal-400">
        {checked ? "✓" : ""}
      </span>
      <span className="flex h-4 w-4 items-center justify-center text-zinc-400">
        {icon}
      </span>
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-[11px] text-zinc-500">{shortcut}</span>}
    </button>
  );
}
