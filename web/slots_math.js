// Slot Machine math. ONE file, used by the server (require) and the browser (copied to web/).
// Keep it identical in both places: the server decides the result, the page only animates it.
//
// 3 reels, each reel is a strip of 20 stops. The server picks one stop per reel at random.
// The PAYLINE is the middle row: the 3 symbols at the chosen stops. Win = 3 equal symbols (WILD fills in).
// Each stop has the same chance, so the odds come from how many times each symbol is on a strip.
const SlotMath = (() => {
  const SYMS = ['seven', 'bar', 'diamond', 'horse', 'bell', 'bag', 'cherry', 'wild'];
  // how many stops each symbol takes on one strip (total 20)
  const COUNTS = { wild: 1, seven: 1, bar: 2, diamond: 2, horse: 2, bell: 3, bag: 4, cherry: 5 };
  // the three strips hold the same counts in a different order (order only changes how the spin LOOKS)
  const STRIPS = [
    ['cherry','bag','bell','horse','cherry','bar','bag','diamond','cherry','bell','wild','bag','horse','cherry','bar','bell','bag','diamond','cherry','seven'],
    ['bag','cherry','diamond','bell','cherry','horse','bag','bar','cherry','bell','seven','bag','cherry','horse','bar','bell','cherry','bag','diamond','wild'],
    ['bell','cherry','bag','horse','bag','cherry','diamond','bell','bar','cherry','bag','wild','cherry','horse','bell','bag','seven','cherry','diamond','bar'],
  ];
  const STRIP_LEN = 20;
  // payout = bet x multiplier when the payline is 3 of a kind (WILD counts as any symbol)
  const PAYTABLE = { seven: 100, bar: 50, diamond: 30, horse: 20, bell: 18, bag: 12, cherry: 6, wild: 200 };

  function checkStrips() {
    STRIPS.forEach((strip, r) => {
      if (strip.length !== STRIP_LEN) throw new Error('strip ' + r + ' length');
      const c = {}; strip.forEach(s => { c[s] = (c[s] || 0) + 1; });
      SYMS.forEach(s => { if (c[s] !== COUNTS[s]) throw new Error('strip ' + r + ' count ' + s); });
    });
  }
  checkStrips();

  // the 3 symbols visible on one reel when it stops on `stop`: top, middle (payline), bottom
  function visible(reel, stop) {
    const s = STRIPS[reel];
    return [s[(stop - 1 + STRIP_LEN) % STRIP_LEN], s[stop], s[(stop + 1) % STRIP_LEN]];
  }
  // payline symbols for stops [a,b,c]
  function payline(stops) { return stops.map((st, r) => STRIPS[r][st]); }

  // returns the multiplier and what it was for. 0 = no win.
  function evaluate(stops) {
    const line = payline(stops);
    const non = line.filter(s => s !== 'wild');
    if (non.length === 0) return { mult: PAYTABLE.wild, sym: 'wild', line };
    const first = non[0];
    if (non.every(s => s === first)) return { mult: PAYTABLE[first], sym: first, line };
    return { mult: 0, sym: null, line };
  }

  // exact expected return (no simulation): sum over winning payline combinations
  function rtpExact() {
    const n = {}; SYMS.forEach(s => { n[s] = COUNTS[s] / STRIP_LEN; });
    let ev = 0;
    SYMS.forEach(s => {
      if (s === 'wild') { ev += n.wild ** 3 * PAYTABLE.wild; return; }
      // 3 of symbol s, where each reel shows s or wild, with at least one s
      ev += ((n[s] + n.wild) ** 3 - n.wild ** 3) * PAYTABLE[s];
    });
    return ev;
  }

  return { SYMS, COUNTS, STRIPS, STRIP_LEN, PAYTABLE, visible, payline, evaluate, rtpExact };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SlotMath;
