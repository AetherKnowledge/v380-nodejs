# v380-nodejs

### Credits

Based on [prsyahmi/v380](https://github.com/prsyahmi/v380/), the original project by [prsyahmi](https://github.com/prsyahmi). Credit for the original V380 camera client and protocol implementation belongs to the upstream author and contributors.

This version adds newer-firmware support, low-latency video/audio playback, and automatic reconnection.

### How to run
1. Download & Install nodejs
2. Go to this directory and execute `npm install`
3. Create config.json file by following config.example.json (currently IP is not auto discoverable yet, so need to specify it)
4. Run via this command `npm run start` or `npm run dev2`
5. Run `npm run vlc` in a second terminal for fast playback with audio (uses the port in config.json).

Use the camera's device password in `config.json`, separate from the V380 app account password. The client retries with the newer 520-byte login format when a camera rejects the legacy protocol, and decrypts firmware v31 H.264 video and IMA ADPCM audio using communication version 20. Legacy login and unencrypted video remain supported.

Run protocol regression checks with `npm test` (Node.js 18+).

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
