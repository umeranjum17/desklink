# `encoded-486x1080.h264`

Two seconds of Annex-B H.264, 486x1080, 30 fps, generated with the encoder
settings a phone-mirror helper uses — constrained baseline, level 4.1
(`profile-level-id=42c029`, `avc1.42c029`), no lookahead, a key frame every 30
frames with the parameter sets repeated:

```sh
ffmpeg -f lavfi -i 'testsrc=size=486x1080:rate=30' -t 2 -pix_fmt yuv420p \
  -c:v libx264 -profile:v baseline -level:v 4.1 -tune zerolatency \
  -g 30 -keyint_min 30 -sc_threshold 0 -f h264 encoded-486x1080.h264
```

SHA-256 `08f321205aae9fd1542dea6ffabd431b54e7e4db22272cd105aefaf5e0f923b4`.

It is the shape a phone-mirror helper actually produces on a 1080x2400 device
(`h264,486,1080` at the same profile and level), with a test pattern whose
luminance changes every frame, so a decoded picture can be told from a black
rectangle. `packages/desktop-host/test/encoded-flow.mjs` splits it into access
units and feeds them to an `encoded` source.
