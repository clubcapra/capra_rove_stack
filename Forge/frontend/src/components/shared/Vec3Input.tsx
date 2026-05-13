import type { Vec3 } from "../../types/model";

import { NumberField } from "./NumberField";

interface Props {
  value: Vec3;
  onChange: (v: Vec3) => void;
  step?: number;
}

export function Vec3Input({ value, onChange, step = 0.01 }: Props) {
  return (
    <div className="grid grid-cols-3 gap-1">
      <NumberField
        label="x"
        value={value[0]}
        step={step}
        onCommit={(v) => onChange([v, value[1], value[2]])}
      />
      <NumberField
        label="y"
        value={value[1]}
        step={step}
        onCommit={(v) => onChange([value[0], v, value[2]])}
      />
      <NumberField
        label="z"
        value={value[2]}
        step={step}
        onCommit={(v) => onChange([value[0], value[1], v])}
      />
    </div>
  );
}
