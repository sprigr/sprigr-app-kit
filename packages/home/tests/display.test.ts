import { describe, expect, it } from 'vitest';
import { homeDisplayText, homeDisplayTextProblem } from '../src/index';

describe('homeDisplayText', () => {
  it('cleans to what the Home sanitizer leaves alone', () => {
    expect(homeDisplayText('Weekly standup!', 80)).toBe('Weekly standup.');
    expect(homeDisplayText('Lunch 🍕 with team', 80)).toBe('Lunch with team');
    expect(homeDisplayText('Review <b>Q3</b> plan', 80)).toBe('Review Q3 plan');
    expect(homeDisplayText('Call via www.example.test/join', 80)).toBe('Call via');
  });

  it('drops what nothing displayable survives, and cuts to the cap', () => {
    expect(homeDisplayText('https://meet.google.com/abc', 80)).toBeUndefined();
    expect(homeDisplayText('', 80)).toBeUndefined();
    expect(homeDisplayText(42, 80)).toBeUndefined();
    expect(homeDisplayText('x'.repeat(100), 80)).toHaveLength(80);
  });

  it('every result passes the platform rule', () => {
    for (const s of ['Hi!!', '<script>x</script> ok', 'See http://a.test now 🎉', 'plain']) {
      const out = homeDisplayText(s, 80);
      if (out !== undefined) expect(homeDisplayTextProblem(out)).toBeNull();
    }
  });
});
