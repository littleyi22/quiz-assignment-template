// 閱讀設定（學生頁、老師後台共用）：字級、字體、日間／夜間模式
// 放在 <head> 內同步載入，先套用設定避免畫面閃動；面板在 DOM 載入後建立。
(() => {
  const KEY = 'quiz-prefs';
  const SIZES = [87.5, 100, 112.5, 125, 137.5, 150];
  const FONTS = {
    sans: { name: '黑體', css: null },
    serif: { name: '明體', css: null },
    kai: { name: '楷體', css: 'https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC:wght@400;700&display=swap' }
  };
  const THEMES = { auto: '跟隨系統', light: '日間', dark: '夜間' };
  const root = document.documentElement;

  let prefs = { size: 100, font: 'sans', theme: 'auto' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY)) || {}); } catch {}
  if (!SIZES.includes(prefs.size)) prefs.size = 100;
  if (!FONTS[prefs.font]) prefs.font = 'sans';
  if (!THEMES[prefs.theme]) prefs.theme = 'auto';

  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const loaded = new Set();

  function apply() {
    root.style.fontSize = prefs.size + '%';
    root.dataset.font = prefs.font;
    const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && mq && mq.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    const f = FONTS[prefs.font];
    if (f.css && !loaded.has(prefs.font)) {
      loaded.add(prefs.font);
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = f.css;
      document.head.appendChild(l);
    }
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
    syncPanel();
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', () => prefs.theme === 'auto' && apply());

  // ---------- 面板 ----------
  let panel, fab;
  function seg(group, items, cur) {
    return `<div class="qp-seg" data-group="${group}">${Object.entries(items).map(([k, v]) =>
      `<button type="button" data-v="${k}" class="${k === cur ? 'on' : ''}">${v}</button>`).join('')}</div>`;
  }
  function build() {
    fab = document.createElement('button');
    fab.type = 'button'; fab.className = 'qp-fab'; fab.setAttribute('aria-label', '閱讀設定');
    fab.innerHTML = '<span>Aa</span>';
    panel = document.createElement('div');
    panel.className = 'qp-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '閱讀設定');
    document.body.append(fab, panel);
    fab.onclick = e => { e.stopPropagation(); panel.hidden = !panel.hidden; render(); };
    // 用 composedPath：面板按鈕點下後會重繪，e.target 已不在 DOM 中
    document.addEventListener('click', e => { if (!panel.hidden && !e.composedPath().includes(panel)) panel.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') panel.hidden = true; });
    panel.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'minus' || b.dataset.act === 'plus') {
        const i = SIZES.indexOf(prefs.size) + (b.dataset.act === 'plus' ? 1 : -1);
        if (SIZES[i]) prefs.size = SIZES[i];
      } else if (b.dataset.act === 'reset') {
        prefs = { size: 100, font: 'sans', theme: 'auto' };
      } else {
        const g = b.closest('.qp-seg')?.dataset.group;
        if (g) prefs[g] = b.dataset.v;
      }
      apply();
    });
  }
  function render() {
    if (!panel || panel.hidden) return;
    panel.innerHTML = `
      <div class="qp-title">閱讀設定</div>
      <div class="qp-row"><span>文字大小</span>
        <div class="qp-size">
          <button type="button" data-act="minus" ${prefs.size === SIZES[0] ? 'disabled' : ''} aria-label="縮小">A−</button>
          <b>${Math.round(prefs.size)}%</b>
          <button type="button" data-act="plus" ${prefs.size === SIZES.at(-1) ? 'disabled' : ''} aria-label="放大">A＋</button>
        </div></div>
      <div class="qp-row"><span>字體</span>${seg('font', Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.name])), prefs.font)}</div>
      <div class="qp-row"><span>模式</span>${seg('theme', THEMES, prefs.theme)}</div>
      <button type="button" class="qp-reset" data-act="reset">恢復預設</button>`;
  }
  function syncPanel() { render(); }

  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
