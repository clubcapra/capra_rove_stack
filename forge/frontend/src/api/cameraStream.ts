// Camera stream client — MJPEG over HTTP via go2rtc.
//
// We tried WebRTC first; it was a tarpit:
//   * H265 cameras → browser doesn't support → need transcode
//   * Transcoded H264 → Firefox/Linux without OpenH264 refuses → need VP8
//   * `#video=vp8` in go2rtc 1.9.7 is broken (passes "vp8" as ffmpeg
//     muxer name; ffmpeg has no vp8 muxer)
// MJPEG is the boring-but-actually-works alternative: every browser
// renders multipart/x-mixed-replace via <img>, go2rtc's MJPEG endpoint
// transparently decodes/re-encodes any source codec, no SDP, no ICE,
// no codec negotiation. Latency is comparable on LAN (~200-400 ms);
// the cost is bandwidth (3-10× of H264) which is fine on local Wi-Fi.
//
// The returned `image` element is in the DOM (off-screen) so browsers
// don't throttle decoding; copy it into a Three.js Texture in the
// viewport, or reparent it for the lock-view overlay.

export interface CameraStream {
  image: HTMLImageElement;
  ready: Promise<void>;
  close(): void;
  status: () => "loading" | "playing" | "error";
  error: () => string | null;
}

export function createCameraStream(streamId: string): CameraStream {
  const image = document.createElement("img");
  image.style.position = "absolute";
  image.style.left = "-9999px";
  image.style.width = "1px";
  image.style.height = "1px";
  image.style.opacity = "0";
  image.style.pointerEvents = "none";
  image.dataset.cameraStreamId = streamId;
  image.crossOrigin = "anonymous"; // so we can sample into a canvas/texture
  document.body.appendChild(image);

  let _status: "loading" | "playing" | "error" = "loading";
  let _error: string | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    image.addEventListener(
      "load",
      () => {
        _status = "playing";
        resolve();
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        _status = "error";
        _error = "image stream failed to load";
        console.warn(`[camera-stream ${streamId}] MJPEG load error`);
        reject(new Error(_error));
      },
      { once: true },
    );
    // Cache-buster avoids a stale connection if the user reconnects
    // the camera and the same stream_id is reused.
    image.src = `/api/v1/cameras/stream/${encodeURIComponent(streamId)}.mjpeg?_t=${Date.now()}`;
  });

  return {
    image,
    ready,
    status: () => _status,
    error: () => _error,
    close() {
      try {
        // Setting src to empty string aborts the connection.
        image.src = "";
        image.remove();
      } catch {
        /* nothing to clean up */
      }
      _status = "error";
    },
  };
}
