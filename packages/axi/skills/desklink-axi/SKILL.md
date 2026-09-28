---
name: desklink-axi
description: "See and drive a live Linux or macOS desktop through desklink; text and changes by default, pixels on request"
---

# desklink-axi

See and drive a live Linux or macOS desktop through desklink; text and changes by default, pixels on request (axi/1.0-2026-07).

```
desklink-axi: desklink-axi — See and drive a live Linux or macOS desktop through desklink; text and changes by default, pixels on request
help[4]:
  desklink-axi start --control --source x11 --display :97
  desklink-axi screen --query "<words>"
  desklink-axi tree --query "<words>"
  desklink-axi look @r1
```

For web pages, prefer a browser automation tool when available; use desklink-axi for native apps and whole-desktop tasks. Read with screen --query or --region before screen --full. Actions acknowledge input immediately; add --wait change|settle|<milliseconds> when needed. Batch sequential steps in one socket round trip: desklink-axi batch '[["press","Meta+l"],["type","https://example.com"],["press","Return"],["wait","change"]]'.

Every command supports --help. Exit 0 success, 1 operational error, 2 usage error. No screen text at startup unless requested.
