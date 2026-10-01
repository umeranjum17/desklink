// Runs only inside flow.mjs's verified, task-owned X server.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const labels = [
  'Reading list A book on typography and remote desktops today',
  'Desklink makes small labels readable when agents browse the screen',
  'Scroll through your notes and find every visible word quickly',
  'Umer keeps useful ideas together for the next design session',
  'Open recent files and choose a folder for your project',
  'Save draft changes before closing the window or switching tabs',
  'Search notes by title then review matching results below carefully',
  'Copy selected text and paste it into your daily journal',
  'Create a new document with clear headings and short paragraphs',
  'Choose comfortable colors and adjust contrast for reading at night',
  'Account settings include language preferences and reminders for upcoming meetings',
  'Calendar events show start times locations and descriptions for tomorrow',
  'Download images and organize them into collections for later review',
  'Upload finished work and share feedback with your project team',
  'Notifications appear here when someone adds comments to shared documents',
  'Check spelling and punctuation before publishing your latest writing online',
  'Move completed tasks into archives and keep current plans visible',
  'Arrange windows side by side to compare details more easily',
  'Help guides explain keyboard shortcuts and common actions for beginners',
  'Return home to continue reading exploring learning building and creating',
];
assert.equal(labels.join(' ').split(/\s+/).length, 200);
export async function ocrFlow({ run, env, dir, scale, verifyXvfb, remember }) {
  const evidence = process.env.DESKLINK_OCR_EVIDENCE;
  const showcaseOnly = process.env.DESKLINK_OCR_SHOWCASE_ONLY === '1';
  assert(!showcaseOnly || scale === 1,'showcase replay needs 1x');
  assert(evidence, 'set DESKLINK_OCR_EVIDENCE');
  mkdirSync(evidence, { recursive: true });
  if (!showcaseOnly) rmSync(join(evidence,`query-result-${scale}.txt`),{force:true});
  const fixture = join(dir, 'reading.html');
  writeFileSync(fixture, `<!doctype html><title>Reading list</title><style>body{margin:32px;background:white;color:#202020;font:14px Arial}p{margin:0 0 6px;line-height:22px}textarea{font:14px Arial;width:850px;height:85px;margin-top:15px}</style>${labels.map(t=>`<p>${t}</p>`).join('')}<textarea aria-label="Notes" placeholder=""></textarea>`);
  await verifyXvfb();
  const keeper = spawn(env.DESKLINK_AXI_ENGINE, ['keep','--display',env.DISPLAY], {env,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{ keeper.stdout.once('data',resolve); keeper.once('error',reject); keeper.once('exit',()=>reject(new Error('display keeper exited'))); });
  remember(keeper.pid,env.DESKLINK_AXI_ENGINE);
  const browser = spawn(process.env.CHROME_BIN ?? 'chromium', ['--no-sandbox', '--disable-gpu', '--disable-renderer-accessibility', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--ozone-platform=x11', `--user-data-dir=${join(dir,'profile')}`, `--force-device-scale-factor=${scale}`, '--kiosk', `file://${fixture}`], { env, stdio:'ignore' });
  await new Promise((resolve,reject) => { browser.once('spawn',resolve); browser.once('error',reject); });
  await new Promise(r=>setTimeout(r,50));
  remember(browser.pid, 'chromium');
  try {
    await new Promise(r=>setTimeout(r,2500));
    await run('start','--control','--source','x11','--display',env.DISPLAY);
    const output = await run('screen','--full');
    writeFileSync(join(evidence,`screen-${scale}.txt`),output);
    const items = output.split('\n').filter(l=>/^  "@/.test(l)).map(l=>JSON.parse(`[${l.trim()}]`));
    const actual = items.map(row=>row[1]).join(' ').split(/\s+/);
    const expected = labels.join(' ').split(/\s+/);
    writeFileSync(join(evidence,`ground-truth-${scale}.txt`),expected.join('\n')+'\n');
    writeFileSync(join(evidence,`ocr-${scale}.txt`),actual.join('\n')+'\n');
    const diff = expected.flatMap((word,i)=>word===actual[i]?[]:[`${i+1}: expected ${JSON.stringify(word)}; got ${JSON.stringify(actual[i])}`]);
    if(actual.length!==expected.length) diff.push(`words: expected ${expected.length}; got ${actual.length}`);
    writeFileSync(join(evidence,`diff-${scale}.txt`),diff.length?diff.join('\n')+'\n':'PASS: 200/200 word-exact\n');
    await run('look','--out',join(evidence,`fixture-${scale}.png`));
    assert.deepEqual(actual,expected,`OCR mismatch at ${scale}; see diff`);
    let queries = '';
    for (const label of showcaseOnly ? [] : labels) {
      const found = await run('screen','--query',label);
      queries += `$ desklink-axi screen --query ${JSON.stringify(label)}\n${found}\n`;
      writeFileSync(join(evidence,`queries-${scale}.txt`),queries);
      assert(!found.includes('0 items match'),found);
    }
    if (!showcaseOnly) writeFileSync(join(evidence,`query-result-${scale}.txt`),'PASS: 20/20 visible labels found\n');
    if (scale === 1) {
      let transcript = '';
      const record = async (...args) => {
        const result = await run(...args);
        transcript += `$ desklink-axi ${args.map(a=>/\s/.test(a)?JSON.stringify(a):a).join(' ')}\n${result}`;
        writeFileSync(join(evidence,'transcript-in-progress.txt'),transcript);
        return result;
      };
      await record('screen','--query','Reading list');
      await record('screen','--query','typography');
      const probe = () => {
        const result = spawnSync(join(process.env.CARGO_TARGET_DIR,'debug','examples','x11_target'),['--desktop-state'],{env,encoding:'utf8'});
        assert.equal(result.status,0,result.stderr);
        return result.stdout;
      };
      writeFileSync(join(evidence,'focus-before.txt'),probe());
      await record('click',`${Math.round(200*scale)},${Math.round(625*scale)}`);
      await record('type','Notes on remote desktops','--wait','settle');
      writeFileSync(join(evidence,'focus-after.txt'),probe());
      await run('look','--out',join(evidence,'edited.png'));
      const changed = await record('diff');
      const count = /changed: (\d+) (region(?:s)?)/.exec(changed);
      assert(count,changed);
      assert.equal(count[2],Number(count[1]) === 1 ? 'region' : 'regions');
      const after = await record('screen','--query','Notes on remote desktops');
      assert(!after.includes('0 items match'),after);
      const editedItems = after.split('\n').filter(l=>/^  "@/.test(l)).map(l=>JSON.parse(`[${l.trim()}]`));
      assert.equal(editedItems[0]?.[1],'Notes on remote desktops');
      const fullEdited = await run('screen','--full');
      writeFileSync(join(evidence,'edited-screen.txt'),fullEdited);
      const fullEditedItems = fullEdited.split('\n').filter(l=>/^  "@/.test(l)).map(l=>JSON.parse(`[${l.trim()}]`));
      assert(fullEditedItems.every(row=>!row[1].includes('|')),fullEdited);
      // The transcript must show the snapshot that supplied the clicked ref.
      const refreshed = await record('screen','--query','Notes on remote desktops','--full');
      const refreshedItems = refreshed.split('\n').filter(l=>/^  "@/.test(l)).map(l=>JSON.parse(`[${l.trim()}]`));
      assert.equal(refreshedItems[0]?.[1],'Notes on remote desktops');
      const editRef = refreshedItems[0][0];
      await record('click',editRef);
      await record('press','End');
      await record('type',' today','--wait','settle');
      const finalEdit = await record('screen','--query','Notes on remote desktops today');
      const finalItems = finalEdit.split('\n').filter(l=>/^  "@/.test(l)).map(l=>JSON.parse(`[${l.trim()}]`));
      assert.equal(finalItems[0]?.[1],'Notes on remote desktops today');
      await record('look','--region','32,600,880,110','--out',join(evidence,'showcase.png'));
      writeFileSync(join(evidence,'transcript.txt'),transcript);
      if(process.env.DESKLINK_OCR_UPDATE_README==='1') {
        const path='README.md';
        const readme=readFileSync(path,'utf8');
        const start=readme.indexOf('```text\n',readme.indexOf('### A desktop an agent can drive'));
        const end=readme.indexOf('\n```',start);
        writeFileSync(path,readme.slice(0,start)+'```text\n'+transcript.trimEnd()+readme.slice(end));
      }
    }
    await run('click',`${Math.round(200*scale)},${Math.round(625*scale)}`);
    await run('type','a|b','--wait','settle');
    const barQuery = await run('screen','--query','a|b');
    const barItems = barQuery.split('\n').filter(l=>/^  "@/.test(l)).map(l=>JSON.parse(`[${l.trim()}]`));
    assert(barItems.some(row=>row[1] === 'a|b'),barQuery);
    const visible = await run('screen','--full');
    const visibleItems = visible.split('\n').filter(l=>/^  "@/.test(l)).map(l=>JSON.parse(`[${l.trim()}]`));
    assert(visibleItems.every(row=>row[1] !== '|'),visible);
    await run('stop');
  } finally { browser.kill('SIGTERM'); keeper.kill('SIGTERM'); }
}
