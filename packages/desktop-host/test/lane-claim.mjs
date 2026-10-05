#!/usr/bin/env node
// One display claim held open long enough that eight of these, started in the
// same tick, are all holding at once. Prints the number it holds, waits, then
// releases on the way out.
import { setTimeout as sleep } from 'node:timers/promises';
import { claimPrivateDisplay } from './lab-safety.mjs';

const claim = claimPrivateDisplay({ from: 170, count: 30 });
const held = { number: claim.number, display: claim.display, from: Date.now() };
process.stdout.write(`${JSON.stringify(held)}\n`);
await sleep(1500); // the other seven are claiming right now
claim.release();
