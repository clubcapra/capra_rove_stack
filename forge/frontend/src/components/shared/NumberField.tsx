import { useEffect, useState } from "react";

interface Props {
  label?: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  className?: string;
}

export function NumberField({ label, value, onCommit, step = 0.01, className }: Props) {
  const [text, setText] = useState(formatNumber(value));

  useEffect(() => {
    setText(formatNumber(value));
  }, [value]);

  const commit = () => {
    const parsed = Number.parseFloat(text);
    if (!Number.isNaN(parsed) && parsed !== value) onCommit(parsed);
    else setText(formatNumber(value));
  };

  return (
    <label className={"flex items-center gap-1 text-xs " + (className ?? "")}>
      {label !== undefined && <span className="w-4 text-zinc-400">{label}</span>}
      <input
        type="number"
        value={text}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-zinc-100 focus:border-teal-500 focus:outline-none"
      />
    </label>
  );
}

function formatNumber(v: number): string {
  // Avoid showing 1.0000000004 — round to 6 sig figs but allow more precision in input.
  if (Number.isInteger(v)) return v.toString();
  const s = v.toString();
  if (s.length < 10) return s;
  return v.toPrecision(6);
}
