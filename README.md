# v380-nodejs

### Credits

Based on [prsyahmi/v380](https://github.com/prsyahmi/v380/), the original project by [prsyahmi](https://github.com/prsyahmi). Credit for the original V380 camera client and protocol implementation belongs to the upstream author and contributors.

This version adds newer-firmware support, low-latency video/audio playback, and automatic reconnection.

### How to run
1. Install Node.js 22.13+ (22.x), or Node.js 24+; Node.js 24 or 26 is recommended.
2. Go to this directory and execute `npm ci` (includes the development tools required by `npm start`).
3. Create config.json file by following config.example.json (currently IP is not auto discoverable yet, so need to specify it)
4. Run via this command `npm run start` or `npm run dev2`
5. Run `npm run vlc` in a second terminal for fast playback with audio (uses the port in config.json).

Use the camera's device password in `config.json`, separate from the V380 app account password. The client retries with the newer 520-byte login format when a camera rejects the legacy protocol, and decrypts firmware v31 H.264 video and IMA ADPCM audio using communication version 20. Legacy login and unencrypted video remain supported.

Run checks with `npm run typecheck`, `npm run lint`, and `npm test`.
Build JavaScript into `build/` with `npm run build`.
Use `npm run dev` for automatic restarts on source changes, or `npm run dev2`
to also enable the debugger on port 7321. Both use Node's built-in watch mode.

The toolchain uses TypeScript 6, the newest version supported by the current
TypeScript ESLint parser. Express uses version 5. The unused unionstruct package
and obsolete TSLint/ts-node-dev tools have been removed. The lockfile records
the tested dependency versions; commit it with dependency changes.

The FFmpeg compatibility endpoints retain fluent-ffmpeg's final release (2.1.3),
which upstream has deprecated. `/live.flv` does not use that wrapper.

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

The stream is `http://127.0.0.1:<serverPort>/live.flv` when accessed in the same
network namespace. This endpoint needs no FFmpeg installation. Install FFmpeg
on the container only if you use the compatibility `/video/stream.flv` or
encoded `/audio/stream.flv` endpoints.

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
npm.cmd run vlc
```

This opens `http://127.0.0.1:<serverPort>/live.flv` with VLC network caching set to
200 ms. Firmware v31 sends H.264 directly and converts verified IMA WAV audio to
8 kHz mono G.711 mu-law, without FFmpeg processes or AAC encoder buffering.
Audio and video retain their shared camera clock, including variable frame rates.
Cached video primes decoder references immediately instead of replaying seconds
of historical timing. Slow viewers are disconnected when their buffer reaches
8 MB. If a complete keyframe chain is unavailable, startup waits for the next
camera keyframe (about four seconds on the tested device).

G.711 is intended for VLC; browser players may require AAC. The existing
`/video/stream.flv` endpoint retains its FFmpeg/AAC behavior. Legacy cameras
automatically redirect `/live.flv` to that endpoint. Firmware is unchanged.
The 200 ms player cache is a target, not a measured camera-to-screen latency;
Wi-Fi jitter and camera encoding still contribute. Increase VLC network caching
if playback stutters on a busy wireless network.

### Status
- The camera connection stays active while the application runs. New viewers receive a complete cached keyframe chain, or wait for the next keyframe if the cache limit was reached.
- `/live.flv` packages firmware v31 video/audio directly with camera timestamps. The compatibility `/video/stream.flv` endpoint uses one FFmpeg muxer per viewer with arrival timestamps. Camera packets are read when available without timer polling.
- Legacy audio uses the original guessed codec; firmware v31 audio uses verified IMA WAV blocks decoded by FFmpeg.
- Timeouts, disconnects, and transport errors automatically retry with fresh authentication after 1, 2, 4, 8, 16, then 30 seconds (capped at 30 seconds). After a stream stays connected for 30 seconds, the next retry starts at 1 second. Invalid credentials or unsupported authentication stop retries.
- The HTTP server stays running during reconnection. `/live.flv` viewers keep their connection and resume audio/video at a fresh keyframe with continuous playback timestamps. A player may need reopening after a long outage if it times out independently. The FFmpeg/AAC compatibility endpoints close their old feeds; reopen those streams after recovery.
