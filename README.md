# v380-nodejs

### Credits

Based on [prsyahmi/v380](https://github.com/prsyahmi/v380/), the original project by [prsyahmi](https://github.com/prsyahmi). Credit for the original V380 camera client and protocol implementation belongs to the upstream author and contributors.

This version adds newer-firmware support, named multi-camera streams, low-latency video/audio playback, and automatic reconnection.

Speaker packet format and encryption are based on
[jericjan/v380-audio-player](https://github.com/jericjan/v380-audio-player).
Credit for that speaker protocol research belongs to
[jericjan](https://github.com/jericjan) and the project's contributors.
The Node.js implementation shares this project's login and IMA ADPCM codec.

### How to run
1. Install Node.js 22.13+ (22.x), or Node.js 24+; Node.js 24 or 26 is recommended.
2. Go to this directory and execute `npm ci` (includes the development tools required by `npm start`).
3. Create config.json file by following config.example.json (currently IP is not auto discoverable yet, so need to specify it)
4. Run via this command `npm run start` or `npm run dev2`
5. Run `npm run vlc -- --camera garage` in a second terminal for fast playback with audio (uses the port in config.json).

Use the camera's device password in `config.json`, separate from the V380 app account password. The client retries with the newer 520-byte login format when a camera rejects the legacy protocol, and decrypts firmware v31 H.264 video and IMA ADPCM audio using communication version 20. Legacy login and unencrypted video remain supported.

The HTTP server listens on **`127.0.0.1` only by default**, including when an
existing config omits `serverHost`. Local Frigate/go2rtc can continue to use
`http://127.0.0.1:<serverPort>/garage.flv`. To allow LAN access explicitly, set
`"serverHost": "0.0.0.0"` in `config.json`, or use a specific local interface IP.
IPv6 addresses such as `::1` are also supported. Restart the bridge after
changing any configuration. Stream endpoints have no authentication;
all clients that can reach the configured listening address can access them.

### Named cameras

`serverHost` and `serverPort` are shared. Every other top-level key names a
camera. Names use lowercase letters, digits, underscores, or hyphens (up to
64 characters). For example:

```json
{
  "serverHost": "127.0.0.1",
  "serverPort": 8800,
  "garage": {
    "id": "123456789",
    "ip": "192.168.1.100",
    "username": "admin",
    "password": "device-password"
  },
  "front_door": {
    "id": "987654321",
    "ip": "192.168.1.101",
    "username": "admin",
    "password": "another-device-password"
  }
}
```

Remove unused example cameras and enter each camera's actual device ID and
credentials. Run the bridge once to connect all configured cameras on one
HTTP port. Each camera has its own authentication, decryption keys, frame
buffers, viewers, and reconnect backoff. One camera going offline or rejecting
credentials does not stop the others. Logs identify the camera by name.

| Camera | Direct stream | Compatibility video | Audio WAV |
| --- | --- | --- | --- |
| garage | `/garage.flv` | `/garage/video/stream.flv` | `/garage/audio/stream.wav` |
| front_door | `/front_door.flv` | `/front_door/video/stream.flv` | `/front_door/audio/stream.wav` |

The server binds before camera login; a camera that has never connected returns
HTTP 503 until its first session is ready. Unknown names return HTTP 404.

**Migration:** flat camera settings and the unnamed `/live.flv` endpoint are
no longer supported. Move `id`, `ip`, `username`, `password`, and optional device
`port` into a named object; keep HTTP settings outside. Replace old stream URLs
with `/<name>.flv` and add `--camera <name>` to each camera's Frigate talk source.
Deploy the new config and executable together. Keep your previous executable
and config together if you need to roll back.

Playback and speaker commands automatically select a sole configured camera.
With multiple cameras, select explicitly; this also works after the command:

```sh
npm run vlc -- --camera garage
npm run speak -- --camera garage voice.wav
npm run test:speaker -- --camera garage
./v380-linux-x64 --config /opt/v380/config.json --camera garage speak --test /opt/v380/test.mp3
```

`./v380-linux-x64 --camera garage` runs just that camera from a larger config.
Without this option, all cameras run concurrently. Camera `port` refers to its
proprietary TCP service (default 8800), not the shared HTTP server port.

### Audio-only mode and native RTSP video

Add `"audioOnly": true` inside the selected camera object, alongside its `id`,
`ip`, `username`, and `password`, then restart the bridge. The default is false.
In audio-only mode `/<name>.flv` carries audio, and video decryption, frame
assembly, parsing, and caching are skipped. The video compatibility endpoint
returns HTTP 404 for that camera.

`http://127.0.0.1:8800/garage/audio.flv` is an audio-only endpoint even when
`audioOnly` is false. On firmware v31 it carries G.711 mu-law directly, with
no FFmpeg process in the bridge, and does not wait for a video keyframe.
HTTP viewers survive camera reconnects. Missing camera audio is replaced with
paced mu-law silence after a 200 ms allowance for jitter, including when the
microphone is muted by push-to-talk. Real audio resumes when packets return.
Silence also starts the audio track when the connected camera has not yet
sent audio, so downstream audio consumers do not wait indefinitely.

go2rtc can combine the camera's native RTSP video with this audio. Merge
[deploy/frigate-audio-only.yaml](deploy/frigate-audio-only.yaml), or use:

```yaml
go2rtc:
  ffmpeg:
    v380: "-flags low_delay -probesize 32768 -analyzeduration 100000 -f flv -i {input}"
  streams:
    garage2:
      - "rtsp://192.168.254.92/live/ch00_0"
      - "ffmpeg:http://127.0.0.1:8800/garage/audio.flv#audio=copy#input=v380"
      - "ffmpeg:garage2#audio=aac"
      - "ffmpeg:garage2#audio=opus"
```

Keep Frigate's recording input at `rtsp://127.0.0.1:8554/garage2` and
`output_args.record: preset-record-generic-audio-aac`. Keep the existing speaker
backchannel source if you want push-to-talk. Restart Frigate after changing
its configuration. Use the HTTP port configured in the bridge.

For sound alone, omit the native RTSP source and name the go2rtc stream
`garage_audio`; update both AAC/Opus references to that name too. VLC can also
open the bridge's `/garage/audio.flv` directly.

This mode changes bridge processing and output, **not the camera's wire
protocol**: video bytes are still received and drained on the proprietary
connection. It does not reduce camera-to-bridge network traffic or guarantee
audio survives a camera/network stall. Native RTSP video uses a separate
connection, and its clock is not synchronized with this audio source; lip sync
may differ. Camera microphone muting during push-to-talk still applies.

Silence filling also applies to the direct combined `/<name>.flv` feed once
its first video keyframe arrives. It keeps AAC/Opus conversion and browser
muxers receiving an audio track during talk or an audio-only outage. Timers
stop when the last viewer disconnects. This does not synthesize video if the
camera's native RTSP service itself times out; a video source outage still
needs that source to recover. This is half-duplex talk with silent gaps, not
simultaneous camera-microphone and speaker audio.

Run checks with `npm run typecheck`, `npm run lint`, and `npm test`.
Build JavaScript into `build/` with `npm run build`.
Use `npm run dev` for automatic restarts on source changes, or `npm run dev2`
to also enable the debugger on port 7321. Both use Node's built-in watch mode.

The toolchain uses TypeScript 6, the newest version supported by the current
TypeScript ESLint parser. Express uses version 5. The unused unionstruct package
and obsolete TSLint/ts-node-dev tools have been removed. The lockfile records
the tested dependency versions; commit it with dependency changes.

The FFmpeg compatibility endpoints retain fluent-ffmpeg's final release (2.1.3),
which upstream has deprecated. `/garage.flv` does not use that wrapper.

### Standalone Linux executable

Build from this directory on Windows or Linux:

```sh
npm ci
npm run build:linux
```

The build checks types, then creates `dist/v380-linux-x64` with Bun's runtime
and the application's dependencies bundled into one executable. Copy that file
to your Linux container; Node.js, Bun, npm, and `node_modules` are not needed
there. The target is Linux x86-64 with glibc (typical Debian/Ubuntu Proxmox
containers), not ARM64 or Alpine/musl.

Keep your device credentials in a separate `config.json`, using
`config.example.json` as a template. The executable reads it from the **working
directory**; private configuration is never included in the build.

```sh
cd /opt/v380
chmod +x v380-linux-x64
./v380-linux-x64
```

The stream is `http://127.0.0.1:<serverPort>/garage.flv` when accessed in the same
network namespace. This endpoint needs no FFmpeg installation. Install FFmpeg
on the container if you use the compatibility `/garage/video/stream.flv` or
encoded `/garage/audio/stream.flv` endpoints, microphone capture, or `speak --test`.

For systemd, also copy the sample `deploy/v380.service` to the container. Its paths
assume the executable and `config.json` are in `/opt/v380`, owned by a dedicated
`v380` service user:

```sh
sudo useradd --system --user-group --home-dir /opt/v380 --shell /usr/sbin/nologin v380
sudo chown -R v380:v380 /opt/v380
sudo chmod 600 /opt/v380/config.json
sudo install -m 644 deploy/v380.service /etc/systemd/system/v380.service
sudo systemctl daemon-reload
sudo systemctl enable --now v380
sudo journalctl -u v380 -f
```

Create the user once; adjust the sample unit if you already use another service
account or installation path. `WorkingDirectory` locates the external config,
and `Restart=on-failure` restarts the process after crashes. Camera connection
losses use the application's automatic reconnect without restarting the service.

### Fast LAN playback with audio

Keep `npm.cmd start` running. In a second terminal in this directory, run:

```powershell
npm.cmd run vlc -- --camera garage
```

This opens `http://127.0.0.1:<serverPort>/garage.flv` with VLC network caching set to
200 ms. Firmware v31 sends H.264 directly and converts verified IMA WAV audio to
8 kHz mono G.711 mu-law, without FFmpeg processes or AAC encoder buffering.
Audio and video retain their shared camera clock, including variable frame rates.
Cached video primes decoder references immediately instead of replaying seconds
of historical timing. Slow viewers are disconnected when their buffer reaches
8 MB. If a complete keyframe chain is unavailable, startup waits for the next
camera keyframe (about four seconds on the tested device).

G.711 is intended for VLC; browser players may require AAC. The existing
`/garage/video/stream.flv` endpoint retains its FFmpeg/AAC behavior. Legacy cameras
automatically redirect `/garage.flv` to that endpoint. Firmware is unchanged.
The 200 ms player cache is a target, not a measured camera-to-screen latency;
Wi-Fi jitter and camera encoding still contribute. Increase VLC network caching
if playback stutters on a busy wireless network.

### Send audio to the camera speaker

Use the selected camera's `config.json` device ID, IP, username, and device password. Run
speaker commands in a separate terminal while the video bridge stays running.
The command opens its own camera session; it does not start another HTTP server.

Play a WAV file once:

```sh
npm run speak -- --camera garage voice.wav
```

To test the speaker using `test.mp3` in the project directory:

```sh
npm run test:speaker -- --camera garage
```

This requires FFmpeg, converts the MP3 to a temporary WAV, plays it once using
`config.json`, and removes the temporary file afterward.

The same test command works in the standalone Linux executable, without Node
or npm. Install FFmpeg and copy `test.mp3` to the working directory, or give
an explicit audio file path:

```sh
cd /opt/v380
./v380-linux-x64 --camera garage speak --test
./v380-linux-x64 --config /opt/v380/config.json --camera garage speak --test /opt/v380/test.mp3
```

The MP3 is a separate file; it is not embedded in the executable. `--test`
accepts any audio format supported by FFmpeg and plays it once. Run this in
a separate terminal while the bridge service stays running.

The file must be **PCM 16-bit little-endian, 8000 Hz, mono**. Convert other
formats with FFmpeg first:

```sh
ffmpeg -i input.mp3 -ac 1 -ar 8000 -c:a pcm_s16le voice.wav
```

Send a live microphone on Windows (FFmpeg must be installed and in PATH):

```powershell
ffmpeg -list_devices true -f dshow -i dummy
npm.cmd run speak -- --camera garage --mic "Microphone (your exact device name)"
```

On Linux, use an ALSA input device; the default is `default`:

```sh
npm run speak -- --camera garage --mic
npm run speak -- --camera garage --mic hw:1,0
```

Run microphone capture on the computer with the microphone. A headless LXC
needs an accessible audio device to capture locally. PCM WAV playback needs no
microphone or FFmpeg installation; `--test` conversion requires FFmpeg.

The standalone executable supports the same commands:

```sh
./v380-linux-x64 --camera garage speak voice.wav
./v380-linux-x64 --camera garage speak --mic
```

For another capture source, send raw 8 kHz mono signed 16-bit little-endian PCM
through stdin, for example from PulseAudio on Linux:

```sh
ffmpeg -f pulse -i default -ac 1 -ar 8000 -f s16le pipe:1 | ./v380-linux-x64 --camera garage speak --pcm-stdin
```

Press Ctrl+C to stop microphone capture and close the camera speaker session.
Audio is encoded into 505-sample IMA WAV blocks and paced at the recording rate;
firmware above version 30 uses the session AES key. Playback stops on camera
disconnect or input failure; it does not automatically replay interrupted audio.
Speaker playback was confirmed on the v31 camera. No microphone capture or
speaker control API is exposed through the public HTTP streaming port.

### Talk from Frigate

The bridge supports go2rtc's external-command audio backchannel. This lets
Frigate's Live view send your browser microphone to the camera without Home
Assistant or a microphone attached to the LXC.

1. Rebuild with `npm run build:linux` and replace the executable in your LXC at
   `/opt/v380/v380-linux-x64`. Stop the bridge service before replacing a running
   executable, then start it again. Keep `/opt/v380/config.json` in place.
2. Merge the `ffmpeg` template and `garage2` source list from [deploy/frigate-v380.yaml](deploy/frigate-v380.yaml)
   into your existing Frigate config:

   ```yaml
   go2rtc:
     ffmpeg:
       v380: "-flags low_delay -probesize 32768 -analyzeduration 100000 -f flv -i {input}"
     streams:
       garage2:
         - "ffmpeg:http://127.0.0.1:8800/garage.flv#video=copy#audio=copy#input=v380#raw=-max_interleave_delta 100000"
         - "ffmpeg:garage2#audio=aac"
         - "ffmpeg:garage2#audio=opus"
         - "exec:/opt/v380/v380-linux-x64 --config /opt/v380/config.json --camera garage speak --alaw-stdin#backchannel=1"
   ```

3. Keep your recording input at `rtsp://127.0.0.1:8554/garage2`, your existing
   WebRTC candidates/port 8555 configuration, and the rest of your camera settings.
   Keep `output_args.record: preset-record-generic-audio-aac` so Frigate converts
   G.711 audio to AAC for MP4 recordings.
   Restart Frigate/go2rtc after saving.
4. Open Frigate at **`https://192.168.254.90:8971`** (or your existing HTTPS URL).
   Open `garage2`'s individual Live view, allow browser microphone permission,
   and toggle the microphone control on to talk and off to listen. The dashboard
   grid is not the talk interface.

The executable is launched by **go2rtc's service account**, which must be able
to execute the binary, traverse `/opt/v380`, and read the config. Run this check
as that account if the microphone fails to start:

```sh
/opt/v380/v380-linux-x64 --config /opt/v380/config.json --camera garage speak --alaw-stdin </dev/null
```

It should exit successfully without connecting to the selected camera. The absolute
`--config` path is needed because Frigate's working directory differs from the
bridge service's. Frigate installed directly in the same LXC can use the paths
and loopback address above; Docker installations need those paths mounted
inside the go2rtc container.

The browser negotiates PCMA/8000, go2rtc writes raw G.711 A-law to stdin, and the
bridge decodes it to PCM before encoding/encrypting camera speaker packets.
The backchannel itself requires no FFmpeg process. It waits for audio bytes
before opening the speaker; normal viewing does not activate talk mode. A
750 ms gap in incoming microphone packets closes the speaker session even if
go2rtc leaves stdin open. That gap is a network inactivity timeout, not voice
activation: silence is still sent while Frigate's microphone control is on.

This camera mutes its own microphone while the speaker session is active,
including a short firmware delay after it closes. Turn Frigate's microphone
off to hear the camera again. This integration does not enable full-duplex
audio. Only one talk session should be active at a time.

The primary source copies both codecs instead of waiting for an AAC encoder.
The separate AAC and Opus sources are available when a player needs them.
The `v380` input limits format probing to 32 KiB and 100 ms of media analysis;
it retains the cached keyframe packets instead of discarding them with
`-fflags nobuffer`. The 100 ms mux interleave limit lets video keep flowing
when the camera stops sending audio during talk. These settings were checked
with go2rtc 1.9.8; they reduce bridge-to-go2rtc buffering, but do not change
camera encoding or a player's own cache.

For direct VLC playback, use `npm run vlc` (200 ms network caching), or open
the HTTP URL with `vlc --network-caching=200 http://127.0.0.1:8800/garage.flv`.
Use the bridge's configured address and port; loopback URLs work only on the
same machine. A manually opened URL can use a larger VLC cache. Compare
native RTSP and HTTP with the same player settings.

See [the LAN investigation report](docs/lan-streaming-investigation.md) for
APK findings, measured buffering, camera/RTSP comparisons, and remaining
disconnect limitations.

The browser-to-go2rtc-to-camera-packet path was verified with generated silence
and a simulated camera against go2rtc **1.9.8**. Frigate **0.14.1**'s microphone
signaling was checked for compatibility; the installed Frigate configuration
still needs the source entry above applied locally.

### Status
- The camera connection stays active while the application runs. New viewers receive a complete cached keyframe chain, or wait for the next keyframe if the cache limit was reached.
- `/garage.flv` packages firmware v31 video/audio directly with camera timestamps. The compatibility `/garage/video/stream.flv` endpoint uses one FFmpeg muxer per viewer with arrival timestamps. Camera packets are read when available without timer polling.
- Legacy audio uses the original guessed codec; firmware v31 audio uses verified IMA WAV blocks decoded by FFmpeg.
- Timeouts, disconnects, and transport errors automatically retry with fresh authentication after 0.25, 0.5, 1, 2, 4, then 5 seconds (capped at 5 seconds). After a stream stays connected for 30 seconds, the next retry starts at 0.25 seconds. Invalid credentials or unsupported authentication stop retries. Authentication and stream inactivity still have a 5-second timeout; retries cannot restore frames while the camera itself is unresponsive.
- The shared HTTP server stays running during each camera's reconnection. `/garage.flv` viewers keep their connection and resume audio/video at a fresh keyframe with continuous playback timestamps. A player may need reopening after a long outage if it times out independently. The FFmpeg/AAC compatibility endpoints close their old feeds; reopen those streams after recovery.
