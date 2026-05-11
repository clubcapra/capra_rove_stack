import { Allotment } from "allotment";

import { AssetPanel } from "../panels/AssetPanel";
import { DiagnosticsPanel } from "../panels/DiagnosticsPanel";
import { IKTrainingPanel } from "../panels/IKTrainingPanel";
import { JointSlidersPanel } from "../panels/JointSlidersPanel";
import { PropertiesPanel } from "../panels/PropertiesPanel";
import { SceneTreePanel } from "../panels/SceneTreePanel";
import { Viewport } from "../viewport/Viewport";

import { PageNav } from "./PageNav";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";

export function AppShell() {
  return (
    <div className="flex h-full w-full flex-col bg-zinc-950 text-zinc-100">
      <PageNav current="create" />
      <Toolbar />
      <div className="flex-1 min-h-0">
        <Allotment>
          <Allotment.Pane minSize={180} preferredSize={260}>
            <SceneTreePanel />
          </Allotment.Pane>
          <Allotment.Pane minSize={300}>
            <Allotment vertical>
              <Allotment.Pane minSize={200}>
                <Viewport />
              </Allotment.Pane>
              <Allotment.Pane minSize={120} preferredSize={200}>
                <BottomDock />
              </Allotment.Pane>
            </Allotment>
          </Allotment.Pane>
          <Allotment.Pane minSize={240} preferredSize={320}>
            <PropertiesPanel />
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
      <AssetPanel />
      <IKTrainingPanel />
    </div>
  );
}

function BottomDock() {
  return (
    <Allotment>
      <Allotment.Pane>
        <JointSlidersPanel />
      </Allotment.Pane>
      <Allotment.Pane>
        <DiagnosticsPanel />
      </Allotment.Pane>
    </Allotment>
  );
}
