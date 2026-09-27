import { expect, it } from 'vitest';
import { keyboardDelta } from './keyboardDelta';

it('sends only new committed text, deletes and Unicode replacements', () => {
    expect(keyboardDelta('', 'd')).toEqual({ removed: 0, added: 'd' });
    expect(keyboardDelta('d', 'de')).toEqual({ removed: 0, added: 'e' });
    expect(keyboardDelta('de', 'd')).toEqual({ removed: 1, added: '' });
    expect(keyboardDelta('a😀', 'a😃')).toEqual({ removed: 1, added: '😃' });
});
