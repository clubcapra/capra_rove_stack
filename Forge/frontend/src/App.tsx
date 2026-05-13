import { useCollisionWatcher, useEventStreamSubscription } from "./api/hooks";
import { HomeScreen } from "./components/home/HomeScreen";
import { AppShell } from "./components/layout/AppShell";
import { LidarDebugShell } from "./pages/lidar-debug/LidarDebugShell";
import { MapShell } from "./pages/map/MapShell";
import { SimulateShell } from "./pages/simulate/SimulateShell";
import { useAppStore } from "./stores/appStore";

export default function App() {
  useEventStreamSubscription();
  useCollisionWatcher();
  const view = useAppStore((s) => s.view);
  if (view === "home") return <HomeScreen />;
  if (view === "simulate") return <SimulateShell />;
  if (view === "map") return <MapShell />;
  if (view === "lidar-debug") return <LidarDebugShell />;
  return <AppShell />;
}
