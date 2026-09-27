export function keyboardDelta(previous: string, next: string) {
    const before = [...previous];
    const after = [...next];
    let common = 0;
    while (common < before.length && common < after.length && before[common] === after[common]) common++;
    return { removed: before.length - common, added: after.slice(common).join('') };
}
