import { useValidation } from "../../api/hooks";
import { useEditorStore } from "../../stores/editorStore";

export function DiagnosticsPanel() {
  const v = useValidation();
  const select = useEditorStore((s) => s.select);

  return (
    <div className="flex h-full w-full flex-col bg-zinc-900">
      <div className="border-b border-zinc-800 px-3 py-1.5 text-xs uppercase tracking-wide text-zinc-400">
        Diagnostics
      </div>
      <div className="flex-1 min-h-0 overflow-auto text-sm">
        {v.isLoading && <Empty>Validating…</Empty>}
        {v.data && v.data.length === 0 && (
          <Empty className="text-emerald-400">✓ no diagnostics</Empty>
        )}
        {v.data && v.data.length > 0 && (
          <table className="w-full text-xs">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-800">
                <Th>Severity</Th>
                <Th>Code</Th>
                <Th>Message</Th>
                <Th>Entity</Th>
              </tr>
            </thead>
            <tbody>
              {v.data.map((d, i) => (
                <tr
                  key={i}
                  className="border-b border-zinc-900 hover:bg-zinc-800/60 cursor-pointer"
                  onClick={() => d.entity_id && select(d.entity_id)}
                >
                  <Td>
                    <span
                      className={
                        d.severity === "error"
                          ? "text-red-400"
                          : d.severity === "warning"
                          ? "text-yellow-400"
                          : "text-blue-400"
                      }
                    >
                      {d.severity}
                    </span>
                  </Td>
                  <Td className="font-mono text-[10px] text-zinc-400">{d.code}</Td>
                  <Td>{d.message}</Td>
                  <Td className="font-mono text-[10px] text-zinc-500">{d.entity_id ?? ""}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1 text-left font-normal">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={"px-2 py-1 align-top " + (className ?? "")}>{children}</td>;
}
function Empty({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={"p-3 text-xs text-zinc-500 " + (className ?? "")}>{children}</div>;
}
