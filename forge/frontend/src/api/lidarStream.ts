// Subscribe to /ws/lidar/sub and decode binary point frames.
//
// Frame layout (must match backend/forgebot/api/lidar_bus.py):
//   [u32 magic=0x504C4E54 'PLNT']
//   [u8 sid_len][sid ascii]
//   [u64 t_us]
//   [u32 n_pts]
//   [f32 × 4 × n_pts]   x, y, z, intensity (lidar local frame)

import { useEffect, useRef, useSyncExternalStore } from "react";

const PUSH_MAGIC = 0x504c4e54;

export interface LidarFrame {
  streamId: string;
  tUs: number;
  // Float32Array view over xyzi quads, length = 4 * nPts.
  // Re-used across frames per stream — copy if you need to keep it.
  xyzi: Float32Array;
}

type Listener = (frame: LidarFrame) => void;

class LidarStreamClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  // One latest frame per stream — cheap state for UI components that
  // just want the most recent cloud.
  private latest = new Map<string, LidarFrame>();
  private latestRev = 0;
  private revListeners = new Set<() => void>();
  private retryMs = 250;

  connect() {
    if (this.ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/lidar/sub`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retryMs = 250;
    };
    ws.onmessage = (ev) => this.onMessage(ev.data as ArrayBuffer);
    ws.onclose = () => {
      this.ws = null;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  private onMessage(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const magic = dv.getUint32(0, true);
    if (magic !== PUSH_MAGIC) return;
    const sidLen = dv.getUint8(4);
    let sid = "";
    for (let i = 0; i < sidLen; i++) sid += String.fromCharCode(dv.getUint8(5 + i));
    // Backend layout (encode_frame, "<IB{N}sQI" + body):
    //   magic(4) + sid_len(1) + sid(N) + t_us(u64=8) + n_pts(u32=4) + body
    // So after the variable-length sid: t_us at +0..+7, n_pts at +8..+11,
    // body starts at +12. Reading n_pts at +12 / body at +16 is off by
    // one f32 — every quad gets shifted, and "z" ends up reading the
    // intensity slot (0..1 after refl/255), which presents as a
    // suspiciously narrow vertical extent.
    const headerEnd = 5 + sidLen;
    const tUsLo = dv.getUint32(headerEnd, true);
    const tUsHi = dv.getUint32(headerEnd + 4, true);
    const tUs = tUsHi * 0x100000000 + tUsLo;
    const nPts = dv.getUint32(headerEnd + 8, true);
    const dataStart = headerEnd + 12;
    // The header (magic + sid_len + ascii sid + t_us + n_pts) is
    // variable-length, so dataStart isn't usually 4-aligned. The typed
    // Float32Array view constructor requires a 4-aligned byteOffset, so
    // slice off the float section into its own ArrayBuffer (aligned to
    // 0) and view that. The slice copies, but it's a few KB per packet —
    // negligible vs the parsing cost downstream.
    const xyzi = new Float32Array(
      buf.slice(dataStart, dataStart + nPts * 16),
    );

    const frame: LidarFrame = { streamId: sid, tUs, xyzi };
    this.latest.set(sid, frame);
    this.latestRev++;
    for (const l of this.listeners) l(frame);
    for (const r of this.revListeners) r();
  }

  onFrame(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  subscribeRev(cb: () => void): () => void {
    this.revListeners.add(cb);
    return () => {
      this.revListeners.delete(cb);
    };
  }

  getLatest(streamId: string): LidarFrame | undefined {
    return this.latest.get(streamId);
  }

  getRev(): number {
    return this.latestRev;
  }
}

export const lidarStream = new LidarStreamClient();

export function useLidarStreams(): { revision: number; client: LidarStreamClient } {
  useEffect(() => {
    lidarStream.connect();
  }, []);
  const revision = useSyncExternalStore(
    (cb) => lidarStream.subscribeRev(cb),
    () => lidarStream.getRev(),
    () => 0,
  );
  return { revision, client: lidarStream };
}

export function useLidarFrames(onFrame: (f: LidarFrame) => void) {
  const ref = useRef(onFrame);
  ref.current = onFrame;
  useEffect(() => {
    lidarStream.connect();
    const unsub = lidarStream.onFrame((f) => ref.current(f));
    return unsub;
  }, []);
}
