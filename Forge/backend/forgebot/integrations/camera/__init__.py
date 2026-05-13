"""RTSP camera integration — pairs with the lidar pipeline.

The end goal is colorized lidar splats: each lidar point gets its color
sampled from the corresponding pixel in a calibrated camera image.
That requires:
  * accurate camera intrinsics (fx, fy, cx, cy, distortion)
  * accurate camera-to-lidar extrinsics (R, t)
  * a low-latency video stream the viewport can sample.

This package handles the third piece — managing RTSP cameras and bridging
their streams to the browser via go2rtc — and stores the intrinsics in
the SensorBinding so the splat pipeline can read them later.
"""
