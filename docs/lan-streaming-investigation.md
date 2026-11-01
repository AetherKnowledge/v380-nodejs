# LAN streaming investigation

Target: V380 Pro Android APK 2.2.92 (`com.macrovideo.v380pro`, version code 230).
APK SHA-256: `a84ad1cc8a95e5f0232aca970579fbdef0697d69716a27591709d25bf1e196f3`.
Investigation date: 2026-11-01. This is the phone client, not camera firmware.

## Findings and changes

- **Retry delays:** repeated short sessions previously increased reconnect waits
  to 30 seconds. Retries now start at 250 ms and cap at 5 seconds. They remain
  serialized, obtain fresh authentication, and reset after a stable 30-second
  session. A failed authentication attempt can still take 5 seconds: changing
  the retry delay cannot make an unresponsive camera answer.
- **Broken packet framing:** unknown packet markers now close the session and
  reconnect instead of repeatedly consuming arbitrary 12-byte chunks as headers.
  Known media/control markers retain their handling.
- **go2rtc input probing:** the supplied `v380` FFmpeg input template bounds
  probing and media analysis. It deliberately retains probe packets so a new
  consumer can decode the bridge's cached keyframe immediately.
- **Unnecessary AAC buffering:** the primary go2rtc source copies H.264 and
  G.711 mu-law. Separate AAC and Opus sources preserve player compatibility.
  Frigate's `preset-record-generic-audio-aac` converts recording audio to AAC.
- **Video stalls during talk:** the primary source's FFmpeg interleave limit is
  100,000 microseconds. Without a limit, the muxer can queue video waiting for
  camera audio that firmware mutes while the speaker is active.

See [the deployment example](../deploy/frigate-v380.yaml). Both its `ffmpeg`
template and stream sources must be applied; restarting only the bridge does
not update Frigate's active go2rtc configuration.

## Measured buffering

Controlled tests used the production `LiveFlv` writer, synthetic H.264 video
at 20 fps, G.711 audio at 8 kHz, go2rtc 1.9.8, and FFmpeg 9.0.2 on Windows.
Compressed NAL hashes or decoded raw-frame hashes matched each received frame
to its source emission. These measure processing and consumer buffering,
not physical camera-to-screen latency.

| Controlled case | Observed result |
| --- | --- |
| Original go2rtc FFmpeg source with AAC | About 2.6 s producer startup; video median 513 ms after emission |
| Bounded probe, codec copy | About 90 ms producer startup; video median 45 ms, p95 76 ms |
| Codec copy, audio absent for 2.5 s, default mux interleave | 2,585 ms maximum video gap |
| Same audio interruption, 100 ms interleave limit | 135 ms maximum video gap; p95 frame delay 123 ms |
| Direct HTTP-FLV decoded by default FFmpeg consumer | 2,494 ms to first decoded frame; steady median delay 1,094 ms |
| Direct HTTP-FLV decoded with bounded probe and low-delay input | 701 ms to first frame; steady median delay 62 ms |

The direct HTTP writer has no fixed two-second timer. The default consumer
introduced delay in the controlled direct-feed test. VLC's existing launcher
uses 200 ms network caching; a manually opened URL can use a larger cache.
Native RTSP and HTTP should be compared with the same player settings.

`-fflags nobuffer` was tested but omitted from the final go2rtc input template:
it discarded useful probe-cached frames, causing a wait for the next keyframe.
Those initial bounded-probe runs used `nobuffer`; the final template omits it.
With a populated keyframe cache, first video was 107 ms without `nobuffer`
versus 1,072 ms with it. The final multi-source setup also produced valid
H.264/AAC fragmented MP4 (71 video and 24 audio packets), 42 Opus packets on
request, and 6,566 bytes of PCMU via RTSP. Thus copying primary audio does not
require removing AAC/MSE or Opus support.
`-avioflags direct` broke FLV demuxing in this environment and is not used.

## APK evidence

REA/JADX recovered Java declarations and selected method bodies without running
the APK. Export-table inspection identified the native streaming library;
LLVM disassembly supplied the following native instruction evidence. The native
library was not executed or modified.

| Evidence | Observation and boundary |
| --- | --- |
| `ev_d403639d446f264cc710d20c39abe74df418cbb8e0fced118ff3c6b7d529b897` | `HSMediaPlayer.startPlayEX2`, overload 1, selects the LAN address and calls `HSMediaLibrary.startPlay`; other branches use cloud/MQ/P2P. This is static control-flow evidence. |
| `ev_0a743238a26c7fa7a528638a33cb9ef58c4e6852467888fa84145a17eb924012` | `HSMediaLibrary` exposes native playback/control methods. Java decompilation alone does not reveal their wire implementation. |
| `ev_45fb535828bab56144f54a5acd571eb1638ba3df834d5fc030e4a362ce502deb` | REA enumerated 917 exported symbols from ARM64 `libhsMediaLibrary.so`, including LAN receiver, frame parser, and control-thread functions. Export presence does not prove runtime reachability. |
| `ev_373816739a4cd6150f1940cf13896f858b3cb621357342cea337b876eb451fee` | The recovered `NormalPlayerActivity` handler reacts to login-handle expiry message 10602 by logging in again and updating the player's handle. This is an event response, not evidence of periodic refresh; this message was not observed in the camera probes. |

Native library SHA-256:
`6a2e83e929a9286c59c344b02ee24b67d3f265191d87a4260a4630dbb407d8f5`.

Selected virtual addresses in that exact library:

- `0x45e94`: `HSLiveDataV2Transmitter::getDataFromDevice`. The LAN request
  writes command 301 at `0x46094`, selects communication version 20 at
  `0x45fa4` (21 for another device version), and sends 256 bytes. Its stream
  start loads the pair 303 / `0x3001` from `.rodata` at `0x31948`, then sends
  the buffer at `0x46cb0`. These constants agree with this bridge's modern
  startup; the full request/response layouts are not asserted equivalent.
- `0x4b2d8`: `parseFrameDataV20` reads the 16-byte media header: frame ID at
  offset 0, type at 4, rate at 6, and 64-bit timestamp at 8. Native decryption
  uses session keys. The bridge already follows this header layout.
- `0x444c8`: `actionCtrlThreadFunc` sends command 5005 under feedback flags.
  This bounded examination did not establish a periodic LAN heartbeat or a
  need to send that command unconditionally. No guessed heartbeat was added.
- The LAN receiver uses 12-byte fragment headers with length/count/index
  fields matching the bridge's current parser. Native select/poll loops can
  tolerate longer silence than the bridge's 5-second inactivity timeout.
  Raising that timeout would also lengthen recovery from an actual stall;
  no timeout change was made without evidence of the tradeoff on this camera.

## Physical-camera check and remaining limits

A read-only 60-second LAN connection to the configured camera received 956
video frames and 950 audio frames. The maximum gap between completed video
frames was 369 ms; no unknown control headers or disconnects occurred. No
heartbeat was sent.

A longer simultaneous proprietary/RTSP TCP probe then reproduced a read timeout
after 114 seconds. Matching 1,601 identical H.264 slices by hash showed
proprietary arrival **13 ms earlier at median**, with a 51 ms p95 delay relative
to native RTSP. Before the outage, proprietary delivery did not account for
the reported two-second display delay. This measures transport arrival, not
decoding or display time.

A follow-up reproduced a shared media interruption after about 22 seconds.
Both the proprietary and RTSP legs had stopped receiving frames for about
five seconds when the bridge-style timeout fired. A fresh authentication
attempt also timed out; the next connection took about three seconds before
login succeeded. The existing RTSP connection later resumed. This supports a
shared camera/network interruption, but does not distinguish its cause. The
RTSP probe sent OPTIONS keepalives, not RTCP receiver reports; server-specific
policies remain a limitation. Raw probe authentication read the first 17
useful reply bytes; production reads the complete login structure.

A final diagnostic changed only the established-stream read timeout to 15
seconds. The same proprietary TCP connection received bytes again after a
13.9-second gap, then the camera closed it after a few more frames. Fresh
authentication succeeded in about 21 ms after that closure. This did not
demonstrate sustained recovery by waiting longer, so the production timeout
remains 5 seconds. No periodic heartbeat, arbitrary session refresh, or
unproven request-flag change was added.

The camera timestamp has a timezone/clock offset, so subtracting it directly
from the host's wall clock is not a trustworthy latency measurement.

The reported logs show five seconds of silence followed by an authentication
timeout. They identify an unresponsive transport/session, not its cause.
Wi-Fi loss, camera resource limits, and firmware session behavior remain
unresolved. Faster retries and lower player buffering do not prove those
underlying interruptions fixed.

Local raw evidence and diagnostic tools are kept in ignored `test/build/`:
`rea-v380-lan/rea-evidence.json`, selected native disassemblies,
`rea-v380-lan/rea-refresh-evidence.json`, `rea-v380-lan/physical-camera-results.json`,
`go2rtc-flv-latency-results.json`, `direct-flv-latency-results.json`, and
`multi-codec-results.json`.
The APK, extracted libraries, and private configuration are not bundled into
the application or this report.
