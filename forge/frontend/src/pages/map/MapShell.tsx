import { PageNav } from "../../components/layout/PageNav";

export function MapShell() {
  return (
    <div className="h-screen flex flex-col bg-zinc-900 text-zinc-200">
      <PageNav current="map" />
      <div className="flex-1 grid place-items-center text-zinc-500">
        <div className="text-center">
          <div className="text-2xl mb-2">Map</div>
          <div className="text-sm max-w-md">
            Lidar point cloud accumulation with camera-derived gaussian
            splats overlaid in world frame. Uses the same lidar/camera
            bindings as Simulate.
          </div>
          <div className="text-xs text-zinc-600 mt-4">
            Phase 3: splat pipeline + lidar accumulator.
          </div>
        </div>
      </div>
    </div>
  );
}
