/* Shared effects for the mini-games. All coordinates are in the 720 x 1400 stage space.
   Every helper draws into a layer element that sits inside the stage and removes itself when it is done. */
(function () {
  const FX = window.FX = {};
  const A = n => 'assets/' + n + '.webp?v=2';
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  FX.pre = names => names.forEach(n => { const i = new Image(); i.src = A(n); });
  const rnd = (a, b) => a + Math.random() * (b - a);
  function mk(layer, name, x, y, w, extra, ar) {
    const im = document.createElement('img'); im.src = A(name); im.alt = '';
    im.style.cssText = 'position:absolute;pointer-events:none;will-change:transform,opacity;left:' + (x - w / 2) + 'px;top:' + (y - w * (ar || 1) / 2) + 'px;width:' + w + 'px;' + (extra || '');
    layer.appendChild(im); return im;
  }
  FX.mk = mk;
  const done = (anim, el) => { anim.onfinish = () => el.remove(); return anim; };

  /* frame-by-frame animation: prefix_01 ... prefix_NN */
  FX.flipbook = function (layer, prefix, count, x, y, size, opt) {
    opt = opt || {}; const fps = opt.fps || 14; const pad = n => (n < 10 ? '0' : '') + n;
    const im = mk(layer, prefix + '_01', x, y, size, opt.css); let f = 1;
    const t = setInterval(() => {
      f++; if (f > count) { clearInterval(t); done(im.animate([{ opacity: 1 }, { opacity: 0 }], { duration: opt.fade || 220, fill: 'forwards' }), im); return; }
      im.src = A(prefix + '_' + pad(f));
    }, 1000 / fps);
    return im;
  };
  /* expanding shockwave ring */
  FX.ring = function (layer, x, y, size, dur, delay) {
    const im = mk(layer, 'fx_shockwave_ring', x, y, size);
    done(im.animate([{ transform: 'scale(.15)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 0 }], { duration: dur || 650, delay: delay || 0, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'both' }), im);
  };
  /* glow that pulses once behind something */
  FX.glow = function (layer, name, x, y, w, dur, ar) {
    const im = mk(layer, name, x, y, w, 'mix-blend-mode:screen', ar);
    done(im.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.1)', opacity: 1, offset: .3 }, { transform: 'scale(1.25)', opacity: 0 }], { duration: dur || 800, easing: 'ease-out', fill: 'both' }), im);
  };
  FX.smoke = function (layer, x, y, size) {
    const im = mk(layer, 'fx_smoke_puff', x, y, size, 'opacity:.8');
    done(im.animate([{ transform: 'scale(.4)', opacity: .85 }, { transform: 'translateY(-30px) scale(1.5)', opacity: 0 }], { duration: 900, easing: 'ease-out', fill: 'both' }), im);
  };
  FX.sparkles = function (layer, x, y, n, spread) {
    if (reduce) return;
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), d = rnd(spread * .4, spread), s = rnd(30, 62);
      const im = mk(layer, i % 2 ? 'fx_sparkle_star_a' : 'fx_sparkle_star_b', x, y, s);
      done(im.animate([{ transform: 'translate(0,0) scale(.2) rotate(0)', opacity: 1 }, { transform: 'translate(' + Math.cos(a) * d + 'px,' + Math.sin(a) * d + 'px) scale(1) rotate(' + rnd(-90, 90) + 'deg)', opacity: 1, offset: .55 }, { transform: 'translate(' + Math.cos(a) * d * 1.15 + 'px,' + (Math.sin(a) * d * 1.15 + 20) + 'px) scale(.2)', opacity: 0 }], { duration: rnd(600, 950), delay: rnd(0, 120), easing: 'ease-out', fill: 'both' }), im);
    }
  };
  /* broken chips flying out and falling */
  FX.debris = function (layer, x, y, n) {
    if (reduce) return;
    for (let i = 0; i < n; i++) {
      const a = rnd(-Math.PI * .95, -Math.PI * .05), v = rnd(90, 230), s = rnd(44, 80), id = 1 + (i % 4);
      const im = mk(layer, 'bomb_debris_0' + id, x, y, s), dx = Math.cos(a) * v, dy = Math.sin(a) * v;
      done(im.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: 'translate(' + dx * .6 + 'px,' + (dy * .8) + 'px) rotate(' + rnd(120, 300) + 'deg)', opacity: 1, offset: .45 }, { transform: 'translate(' + dx + 'px,' + (dy + 260) + 'px) rotate(' + rnd(300, 700) + 'deg)', opacity: 0 }], { duration: rnd(800, 1100), easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'both' }), im);
    }
  };
  /* falling confetti */
  FX.confetti = function (layer, n, w, dur) {
    if (reduce) return;
    for (let i = 0; i < n; i++) {
      const s = rnd(30, 56), x = rnd(20, w - 20), im = mk(layer, 'fx_confetti_0' + (1 + i % 6), x, -60, s);
      const sway = rnd(-90, 90);
      done(im.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: 'translate(' + sway + 'px,700px) rotate(' + rnd(200, 600) + 'deg)', opacity: 1, offset: .75 }, { transform: 'translate(' + sway * 1.3 + 'px,1000px) rotate(' + rnd(400, 900) + 'deg)', opacity: 0 }], { duration: (dur || 2400) + rnd(0, 900), delay: rnd(0, 700), easing: 'cubic-bezier(.3,.1,.6,1)', fill: 'both' }), im);
    }
  };
  /* gold coins popping up and falling back (uses the 8 rotation frames) */
  FX.coins = function (layer, x, y, n) {
    if (reduce) return;
    for (let i = 0; i < n; i++) {
      const a = rnd(-Math.PI * .85, -Math.PI * .15), v = rnd(180, 380), s = rnd(54, 80), im = mk(layer, 'coin_spin_01', x, y, s);
      let f = 0; const spin = setInterval(() => { f = (f + 1) % 8; im.src = A('coin_spin_0' + (f + 1)); }, 70);
      const dx = Math.cos(a) * v, dy = Math.sin(a) * v;
      const an = im.animate([{ transform: 'translate(0,0)', opacity: 1 }, { transform: 'translate(' + dx * .6 + 'px,' + dy + 'px)', opacity: 1, offset: .4 }, { transform: 'translate(' + dx + 'px,' + (dy + 620) + 'px)', opacity: 0 }], { duration: rnd(1100, 1600), delay: rnd(0, 250), easing: 'cubic-bezier(.3,.7,.5,1)', fill: 'both' });
      an.onfinish = () => { clearInterval(spin); im.remove(); };
    }
  };
  /* short screen shake (uses the independent `translate` property, so it never fights the stage's own transform) */
  FX.shake = function (el, amp, dur) {
    if (reduce || !el.animate) return; amp = amp || 8;
    el.animate([{ translate: '0 0' }, { translate: -amp + 'px ' + amp * .5 + 'px' }, { translate: amp * .8 + 'px ' + -amp * .6 + 'px' }, { translate: -amp * .6 + 'px ' + amp * .4 + 'px' }, { translate: amp * .4 + 'px 0' }, { translate: '0 0' }], { duration: dur || 380, easing: 'linear' });
  };
})();
