#!/usr/bin/env node
// One lane's whole staging path, as its own process so two lanes can race.
// Writes a receipt and one evidence file under this lane's own lab root, claims
// a private display, then releases it. Prints the receipt as JSON.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimPrivateDisplay, laneArtefactDir, laneRoot } from './lab-safety.mjs';

const task = process.env.DESKLINK_LANE;
const root = laneRoot();
const artefact = laneArtefactDir('receipts');
const claim = claimPrivateDisplay({ from: 170, count: 30 });
const receipt = `${JSON.stringify({ task, root, artefact, display: claim.display, pid: process.pid })}\n`;
writeFileSync(join(artefact, 'receipt.json'), receipt);
writeFileSync(join(artefact, 'evidence.txt'), `${task} evidence\n`);
claim.release();
process.stdout.write(receipt);
