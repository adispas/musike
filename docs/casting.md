# Casting (Google Cast)

The Windows/desktop app and the Android app can play to Chromecasts, Google TVs and Nest speakers on the same Wi-Fi.
The cast button sits in the player bar (desktop, tablets) and at the top of the Now playing sheet (phones).

## How it works

- **Receiver:** Google's Default Media Receiver (`CC1AD845`), so there is no receiver app to register or host.
- **Audio only:** casting always sends the audio stream. Video mode picks up again when casting stops.
- **Streaming from this device:** YouTube's stream URLs are bound to the client that resolved them, so the cast device
  can't fetch them itself. Each platform runs a small proxy on its LAN address, and the device streams from it. The
  proxy answers only `/<random secret>/<track>`, nothing else.
- **The player stays in charge:** the queue, shuffle, repeat and radio run in the app as usual. The device reports its
  state, and when a track finishes the app sends the next one.

| | Desktop (`desktop/src/cast`) | Android (`MusikeCastPlugin.java`) |
|---|---|---|
| Discovery | mDNS `_googlecast._tcp`, one socket per network adapter | MediaRouter with the Cast SDK's selector |
| Control | Cast v2 protocol over TLS (hand-encoded protobuf) | Google Cast SDK (`play-services-cast-framework`) |
| Proxy | Node HTTP server forwarding to the local `/api/stream/<id>/audio` | `CastProxy.java` forwarding to the stream the phone resolved |

The web side is `web/src/cast` (one interface, a backend per platform) plus `web/src/components/Cast.tsx`. The browser
build and iOS have no cast button.

## Troubleshooting

- **No devices found:** the device and the computer/phone must be on the same network. Guest networks and routers with
  "client/AP isolation" block both discovery and streaming.
- **Windows:** allow Musike through Windows Defender Firewall on *private* networks when Windows asks. If you missed
  the prompt, allow it in Windows Security > Firewall > Allow an app.
- **Android:** needs Google Play services. The phone serves the audio, so Musike keeps a notification and a Wi-Fi
  lock while casting. Battery savers that kill background apps will stop the music.
