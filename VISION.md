# Desklink vision

## Who it is for

Developers who already have an app and a way to trust its users, and want a
live desktop inside it: in a browser, in a phone app, or driven by an agent.

## The problem

Bringing a desktop into an app should not need another account, another
service, or another trust system. The app already knows who its users are.
What it lacks is the live picture, clicks, keys and clipboard.

## Where we are going

Permissively licensed remote-desktop engine packages that any app consumes as
ordinary third-party dependencies: host capture and input, encoded sources,
the React Native view, and the agent CLI. One engine, three entry points.
Desklink handles the live picture, clicks, keys and clipboard. Your app stays
in charge of who gets in, and when the session ends.

## Principles and quality bar

- **Pairing is the trust boundary.** A paired client gets view, input and
  clipboard. Unpaired gets nothing. Revoke removes everything. No extra tiers
  or prompts.
- **Product-neutral.** The packages know nothing about any app that uses them.
- **Permissive only.** Copyleft code is never embedded.
- **Linux first.** Linux is the qualification target. Other platforms stay
  marked preview until they are proven on real hardware.
- **Fast enough to type on.** The target is at most 50 ms and 50+ fps.
- **Best-in-class, shown with real captures.** Claims come with real captures
  from the current build, never mock-ups.
- **Safe to test.** Capture and input tests run in private labs, never on a
  person's real display.

## What it is not

- Not an account, pairing, identity or signaling service. The app brings those;
  desklink implements none of them.
- Not a hosted service. The engine is a per-user process that the app starts
  and stops.
- Not a way around OS consent. Screen and input permissions stay with the
  operating system and the person at the computer.

## Next milestones

These follow the current release plan; shipped work lands in the
[changelog](CHANGELOG.md).

1. **Windows desktop sessions.** Native capture, pointer and key input,
   clipboard, and a signed package, each proven on a real Windows machine.
2. **macOS out of preview.** The full session journey and a long soak pass on a
   real Mac, at the latency and fps target.
3. **Physical iPhone and iPad.** A live desktop view on each device, then
   phone-only and tablet-only control.
