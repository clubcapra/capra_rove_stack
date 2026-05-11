import { useAppStore } from "../../stores/appStore";

const PAGES: { key: "create" | "simulate" | "map" | "lidar-debug"; label: string }[] = [
  { key: "create", label: "Create" },
  { key: "simulate", label: "Simulate" },
  { key: "map", label: "Map" },
  { key: "lidar-debug", label: "Lidar Debug" },
];

export function PageNav({
  current,
}: {
  current: "create" | "simulate" | "map" | "lidar-debug";
}) {
  const setView = useAppStore((s) => s.setView);
  const goHome = useAppStore((s) => s.goHome);
  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800 bg-zinc-950 text-sm">
      <button
        type="button"
        onClick={goHome}
        className="px-2 py-1 rounded text-zinc-400 hover:bg-zinc-800"
      >
        ForgeBOT
      </button>
      <span className="text-zinc-700">/</span>
      {PAGES.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => setView(p.key)}
          className={
            "px-2.5 py-1 rounded " +
            (current === p.key
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-800")
          }
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
