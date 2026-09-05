// DeepSeek Harness "custom cursor" plugin - CLIENT half (v4).
// Three-state cursor: idle (default) / typing (pointer over text fields, pure CSS)
// / busy (agent running, pushed from the host). Plus a draggable buddy bubble at the
// top-right that reacts to events, cycles local lines on click, and can call the host
// for a short AI-generated line (opt-in, throttled).
// Settings page "鼠标光标" controls everything. License: MIT

const EXTRA_RULES = '';

const IDLE_LINES = [
  '在呢在呢，随时听候差遣~', '要不要我帮你按个按钮？',
  '发呆中……想找我聊天就戳我一下！', '今天也要元气满满哦~',
  '主人去哪啦？我都等半天了…', '呼……没人说话就偷偷打个盹~',
  '要不要我泡杯茶给你？（虽然只能看）', '无聊到数窗外的小鸟了……',
  '我猜你现在正盯着屏幕发呆，嘿嘿~', '休息一下，眼睛该放松啦！',
];
const BUSY_LINES = [
  '思考中…嘘——', '马上好马上好！', '嘿嘿，这个我拿手！',
  '让 AI 再转两圈~', '加油加油，快出来了！', '脑子里的小齿轮转得飞快……',
  '就差最后一步了！', '哼哼，难不倒我~', '让我再捋捋思路……',
];
const USER_LINES = [
  '收到收到！这就去办~', '哦哦，有新任务！', '交给我啦，保证搞定！',
  '来啦来啦，主人请讲~', '哇，看起来是个大工程！', '我来盯梢，保证不偷懒！',
  '收到！已经开始期待结果啦~', '交给我吧，我可是专业的女仆！',
];
const AI_PENDING = '让我想想说点什么…';
const CLICK_LINES = [
  '诶？点我有什么事吗~', '嘿嘿，又被我发现啦！', '主人手好闲哦~',
  '再点我就要收费啦！（开玩笑的）', '点到哪里啦？我也想看！',
  '这一下点得真清脆~', '咦，是在叫我吗？', '点我是要付工资的哦，开玩笑的~',
  '好啦好啦，我在听呢！', '你点的不是按钮，是我的心哦～',
];
const DRAG_LINES = [
  '哎呀——别拽我头发！！', '呜哇，我会飞了！？', '住手住手，要被拎起来啦！',
  '轻、轻一点啦！', '放我下来！我自己会走！', '救命——女仆要被拐走啦！',
];
const DRAG_DROP_LINES = [
  '哼，终于把我放下了。', '这里风景不错嘛~', '好啦，就在这待着吧。',
  '下次记得轻拿轻放哦~', '总算脚踏实地了……',
];
const TYPING_LINES = [
  '噼里啪啦……在打字呢~', '敲键盘的声音真好听~', '慢慢打，我等你~',
];
const ANGRY_LINES = [
  '哼！再这样我可要生气了！', '（鼓起腮帮子）', '呜——超——级——生——气！',
  '你这样对我，我要去告诉主人！', '（眉头一皱）人家可是有脾气的！',
];
const SHY_LINES = [
  '诶？诶诶？！', '脸、脸好烫……', '别、别这样盯着我看啦！',
  '呜……害羞到冒烟了……', '（捂脸）这种时候该说什么好……',
];
const native = (function () {
  try {
    return typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function' &&
      typeof document !== 'undefined';
  } catch (e) { return false; }
})();
let focusTyping = false;
let lastBuddyPress = 0;
let moodOverride = null;
let moodUntil = 0;
let lastMoveAt = 0;
const clickLog = [];
let autoHidden = false;
let nextTalkAt = 0;
const IDLE_HIDE_MS = 12000;
const IDLE_GAP_MS = 18000;
const TYPE_GAP_MS = 12000;

let disposeStyle = null;
let lastCss = null;
let shared = null;          // { cfg, busy, userSeq, meta }
const subs = [];
let pollDispose = null;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function subscribe(fn) { subs.push(fn); return function () { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }
function notify() { for (let i = 0; i < subs.length; i++) { try { subs[i](); } catch (e) {} } }
function setShared(next) { shared = next; notify(); }

function stateDims(stateName, size) {
  if (!shared || !shared.meta || !shared.meta.states) return null;
  const st = shared.meta.states[stateName];
  if (!st || !st.sizes) return null;
  for (let i = 0; i < st.sizes.length; i++) if (st.sizes[i].size === size) return st.sizes[i];
  return null;
}
function fracToPx(fx, fy, w, h) {
  return { x: clamp(Math.round(fx * (w - 1)), 0, w - 1), y: clamp(Math.round(fy * (h - 1)), 0, h - 1) };
}
function pxToFrac(x, y, w, h) {
  return { fx: w > 1 ? x / (w - 1) : 0, fy: h > 1 ? y / (h - 1) : 0 };
}
const lastLineAt = {};
function pickLine(arr) {
  if (!arr || arr.length === 0) return '';
  const key = arr;
  const last = lastLineAt[key] || -1;
  let i = Math.floor(Math.random() * arr.length);
  if (arr.length > 1) { let guard = 0; while (i === last && guard < 8) { i = Math.floor(Math.random() * arr.length); guard++; } }
  lastLineAt[key] = i;
  return arr[i];
}

function cursorCssFor(stateName, cfg) {
  const d = stateDims(stateName, cfg.size);
  if (!d) return '';
  const idle = stateDims('idle', cfg.size);
  let fx = 0.5, fy = 0.5;
  if (idle) { const f = pxToFrac(cfg.x, cfg.y, idle.width, idle.height); fx = f.fx; fy = f.fy; }
  const p = fracToPx(fx, fy, d.width, d.height);
  return 'url("' + d.url + '") ' + p.x + ' ' + p.y + ', auto';
}

function buildCss(cfg, mode) {
  if (!cfg || !cfg.enabled) return '';
  const sel = 'input, textarea, [contenteditable], [role="textbox"]';
  const autoVisual = cfg.visualSwitch !== false;
  let css = '';
  const m = (mode === 'busy' && cfg.busyEnable && autoVisual) ? 'busy' :
            (mode === 'typing' && cfg.typingEnable && autoVisual) ? 'typing' : 'idle';
  const cur = cursorCssFor(m, cfg);
  if (!cur) return '';
  css = '*{cursor:' + cur + ' !important}' + 'html,body{cursor:' + cur + ' !important}';
  if (m === 'idle' && cfg.typingEnable && autoVisual) {
    const typingCur = cursorCssFor('typing', cfg);
    if (typingCur) css += sel + '{cursor:' + typingCur + ' !important}';
  }
  if (EXTRA_RULES) css += EXTRA_RULES;
  return css;
}

function currentMode() {
  if (!shared || !shared.cfg) return 'idle';
  const cfg = shared.cfg;
  if (shared.busy && cfg.busyEnable !== false) return 'busy';
  if (focusTyping && cfg.typingEnable !== false) return 'typing';
  if (cfg.moveWork !== false && movingNow() && cfg.busyEnable !== false) return 'busy';
  return 'idle';
}
function applyCursor() {
  const css = shared ? buildCss(shared.cfg, currentMode()) : '';
  if (css === lastCss) return false;
  lastCss = css;
  if (disposeStyle) { try { disposeStyle(); } catch (e) {} disposeStyle = null; }
  if (!css) return false;
  disposeStyle = styles.insert(css);
  return true;
}
function refreshVisual() {
  const prevShared = shared;
  const changed = applyCursor();
  if (changed || !prevShared || shared === prevShared) notify();
}

async function saveCfg(next) {
  try {
    await host.call('dsh-cursor:set', next);
  } catch (e) {
    console.error('dsh-cursor: save failed: ' + (e && e.message ? e.message : String(e)));
  }
}
function commitCfg(next) {
  const snap = Object.assign({}, shared.cfg, next);
  setShared(Object.assign({}, shared, { cfg: snap }));
  refreshVisual();
  saveCfg(snap);
  return snap;
}

// ---------- speech state ----------
let speech = { text: '', pending: false };
let lastBusy = false;
let lastSeq = 0;
let busyEdgeHandled = true;
function movingNow() { return Date.now() - lastMoveAt < 1500; }
function setMood(m, ms) { moodOverride = m; moodUntil = Date.now() + ms; notify(); }
function clearMoodIfDue() { if (moodOverride && Date.now() > moodUntil) { moodOverride = null; notify(); } }
function setSpeech(text) { speech = Object.assign({}, speech, { text: text }); notify(); }
function clearPending() { speech = Object.assign({}, speech, { pending: false }); notify(); }

async function askAi(hint) {
  if (!shared || !shared.cfg || !shared.cfg.buddyAi) return null;
  if (speech.pending) return null;
  speech = Object.assign({}, speech, { pending: true, text: AI_PENDING });
  notify();
  let res = null;
  try { res = await host.call('dsh-cursor:line', { hint: hint }); } catch (e) { res = null; }
  speech = Object.assign({}, speech, { pending: false });
  if (res && res.ok && res.text) { speech = Object.assign({}, speech, { text: res.text }); notify(); return res.text; }
  notify();
  return null;
}

function reactToLive() {
  if (!shared) return;
  const busyStart = shared.busy && !lastBusy && shared.cfg.busyEnable;
  const userUp = shared.userSeq > lastSeq;
  lastBusy = shared.busy;
  const wasSeq = lastSeq;
  lastSeq = shared.userSeq;
  if (busyStart) {
    if (shared.cfg.buddyAi && Date.now() - (shared.lastAiFallback || 0) > 40000) {
      shared.lastAiFallback = Date.now();
      askAi('busy').then(function (t) { if (!t) setSpeech(pickLine(BUSY_LINES)); });
    } else {
      setSpeech(pickLine(BUSY_LINES));
    }
    return;
  }
  if (userUp && wasSeq > 0) {
    if (shared.cfg.buddyAi && Date.now() - (shared.lastAiFallback || 0) > 40000) {
      shared.lastAiFallback = Date.now();
      askAi('user').then(function (t) { if (!t) setSpeech(pickLine(USER_LINES)); });
    } else {
      setSpeech(pickLine(USER_LINES));
    }
  }
  void busyEdgeHandled;
}

function manageAutoTalk() {
  if (!shared || !shared.cfg) return;
  const cfg = shared.cfg;
  if (!cfg.buddyShow || autoHidden) return;
  const now = Date.now();
  const mode = currentMode();
  const idleMode = mode === 'idle';
  const typingMode = mode === 'typing';
  const inactiveMs = now - lastMoveAt;
  if (idleMode) {
    if (inactiveMs > IDLE_HIDE_MS) {
      autoHidden = true;
      notify();
      return;
    }
  }
  if (!typingMode && !idleMode) return;
  if (now < nextTalkAt) return;
  nextTalkAt = now + (typingMode ? TYPE_GAP_MS : IDLE_GAP_MS) + Math.floor(Math.random() * 6000);
  setSpeech(pickLine(typingMode ? TYPING_LINES : IDLE_LINES));
}

async function tick() {
  try {
    clearMoodIfDue();
    const res = await host.call('dsh-cursor:get', {});
    if (res && res.cfg && res.meta) {
      const changed =
        !shared ||
        shared.busy !== res.live.busy ||
        shared.userSeq !== res.live.userSeq ||
        JSON.stringify(shared.cfg) !== JSON.stringify(res.cfg);
      if (changed) {
        const prevBusy = shared ? shared.busy : false;
        const prevSeq = shared ? shared.userSeq : 0;
        const prevCfg = shared ? shared.cfg : null;
        setShared({ cfg: res.cfg, busy: res.live.busy, userSeq: res.live.userSeq, meta: res.meta });
        const cfgSw = prevCfg ? JSON.stringify(prevCfg) !== JSON.stringify(res.cfg) : false;
        if (!prevCfg || cfgSw || prevBusy !== res.live.busy || res.live.userSeq !== prevSeq) reactToLive();
      }
    }
    refreshVisual();
    manageAutoTalk();
  } catch (e) {
    console.error('dsh-cursor: tick failed: ' + (e && e.message ? e.message : String(e)));
  }
}

// ---------- React ----------
const H = React.createElement;
function useShared() {
  const [, b] = React.useState(0);
  React.useEffect(function () { return subscribe(function () { b(function (v) { return v + 1; }); }); }, []);
  return shared;
}

const textMuted = { color: 'var(--dsw-alias-label-secondary)' };
const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const chip = (active) => ({
  cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1)',
  background: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
  color: active ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
  borderRadius: 6, padding: '4px 10px', fontSize: 13,
});
const label = { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', margin: '14px 0 6px', fontWeight: 600 };

function baseMood() {
  if (!shared || !shared.cfg) return 'idle';
  const cfg = shared.cfg;
  if (shared.busy && cfg.busyEnable !== false) return 'busy';
  if (focusTyping && cfg.typingEnable !== false) return 'typing';
  if (cfg.moveWork !== false && movingNow() && cfg.busyEnable !== false) return 'busy';
  return 'idle';
}
function buddyArtState() {
  const urls = shared && shared.meta && shared.meta.buddyUrls ? shared.meta.buddyUrls : {};
  const m = moodOverride || (shared && shared.cfg && shared.cfg.bubbleFollow === false ? 'idle' : baseMood());
  return urls[m] ? m : 'idle';
}
function autoShow() {
  if (autoHidden) { autoHidden = false; nextTalkAt = 0; notify(); }
}
function onAnyActivity() {
  lastMoveAt = Date.now();
  autoShow();
}
function globalPointerDown() {
  lastMoveAt = Date.now();
  autoShow();
  if (!shared || !shared.cfg || !shared.cfg.buddyShow) return;
  if (Date.now() - lastBuddyPress < 260) return;
  if (speech.pending) return;
  const now = Date.now();
  clickLog.push(now);
  while (clickLog.length && clickLog[0] < now - 2500) clickLog.shift();
  if (clickLog.length >= 4) {
    clickLog.length = 0;
    setMood('angry', 4500);
    setSpeech(pickLine(ANGRY_LINES));
    return;
  }
  setSpeech(pickLine(CLICK_LINES));
}
function globalFocusIn(e) {
  const tt = e && e.target;
  const next = !!(tt && (tt.tagName === 'INPUT' || tt.tagName === 'TEXTAREA' || tt.isContentEditable === true));
  if (next !== focusTyping) { focusTyping = next; refreshVisual(); }
}

// ---------- buddy card ----------
function BuddyCard(props) {
  useShared();
  const [dragInfo, setDragInfo] = React.useState(null);

  if (autoHidden || !shared || !shared.cfg || !shared.cfg.buddyShow || !shared.meta || !shared.meta.buddyUrls) {
    if (shared && !shared.cfg.buddyShow) return null;
    return H('div', { style: { position: 'fixed', right: 14, top: 14, padding: 6, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, '加载中…');
  }
  const cfg = shared.cfg;
  const buddySt = buddyArtState();
  const budUrls = shared.meta.buddyUrls || {};
  const bmeta = budUrls[buddySt] || budUrls.idle;
  const style = { position: 'fixed', zIndex: 9999, display: 'flex', alignItems: 'flex-end', gap: 8, opacity: (cfg.buddyOpacity || 100) / 100 };
  if (dragInfo) {
    style.left = dragInfo.x; style.top = dragInfo.y;
  } else if (typeof cfg.buddyX === 'number') {
    style.left = cfg.buddyX; style.top = cfg.buddyY;
  } else {
    style.right = 14; style.top = 14;
  }

  function onCardDown(e) {
    lastBuddyPress = Date.now();
    if (e && e.target && e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDragInfo({ sx: e.clientX, sy: e.clientY, baseX: r.left, baseY: r.top, x: r.left, y: r.top, moved: false });
  }
  function moveDrag(e) {
    if (!dragInfo) return;
    if (e.clientX === undefined || e.clientY === undefined) return;
    const dx = e.clientX - dragInfo.sx;
    const dy = e.clientY - dragInfo.sy;
    if (!dragInfo.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    if (!dragInfo.moved) {
      setMood('angry', 4500);
      setSpeech(pickLine(DRAG_LINES));
      setDragInfo(Object.assign({}, dragInfo, { moved: true, x: dragInfo.baseX, y: dragInfo.baseY }));
      return;
    }
    const x = Math.max(0, Math.round(dragInfo.baseX + dx));
    const y = Math.max(0, Math.round(dragInfo.baseY + dy));
    setDragInfo(Object.assign({}, dragInfo, { x: x, y: y }));
  }
  function endDrag(e) {
    if (!dragInfo) return;
    let dx = 0, dy = 0;
    if (e && typeof e.clientX === 'number' && typeof e.clientY === 'number') {
      dx = e.clientX - dragInfo.sx; dy = e.clientY - dragInfo.sy;
    }
    const x = Math.max(0, Math.round(dragInfo.baseX + dx));
    const y = Math.max(0, Math.round(dragInfo.baseY + dy));
    const moved = dragInfo.moved;
    setDragInfo(null);
    if (!moved) return;
    commitCfg({ buddyX: x, buddyY: y });
    setMood('shy', 4000);
    setSpeech(pickLine(DRAG_DROP_LINES));
  }
  function cycle() {
    setSpeech(pickLine(IDLE_LINES));
  }

  return H('div', {
    style: style,
    onPointerDown: onCardDown,
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerLeave: endDrag,
  },
    H('div', {
      style: {
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12, padding: '8px 12px', maxWidth: 250,
        boxShadow: '0 4px 18px rgba(0,0,0,0.18)', fontSize: 13, lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', userSelect: 'none',
      },
      onClick: cycle,
      title: '戳我说话（可拖动）',
    },
      H('div', null,
        speech.pending ? H('span', { style: textMuted }, '… ') : null,
        speech.text || '戳我说说话吧~'),
      H('div', { style: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' } },
        cfg.buddyAi ? H('button', {
          style: Object.assign({}, chip(false), { padding: '2px 8px', fontSize: 12 }),
          onClick: function (e) { e.stopPropagation(); askAi('click').then(function (t) { if (!t) setSpeech(pickLine(IDLE_LINES)); }); },
        }, '✨ AI 说一句') : null,
        H('button', {
          style: Object.assign({}, chip(false), { padding: '2px 8px', fontSize: 12 }),
          onClick: function (e) { e.stopPropagation(); commitCfg({ buddyShow: false }); },
        }, '隐藏'))),
    H('img', {
      key: buddySt,
      src: bmeta ? bmeta.url : null, draggable: false, alt: buddySt,
      style: {
        width: cfg.buddySize || 150, height: 'auto', pointerEvents: 'none', userSelect: 'none',
        filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.25))',
        transition: 'opacity 0.15s',
      },
    }));
}

// ---------- settings panel ----------
function CursorPanel(props) {
  useShared();
  const [dragging, setDragging] = React.useState(false);
  if (!shared || !shared.cfg) {
    return H('div', { style: Object.assign({}, textMuted, { padding: '8px 0' }) }, '正在加载光标设置…');
  }
  const cfg = shared.cfg;
  const d = stateDims('idle', cfg.size);
  const dTyping = stateDims('typing', cfg.size);
  const dBusy = stateDims('busy', cfg.size);

  function setHotFrac(fx, fy) { if (!d) return; const p = fracToPx(fx, fy, d.width, d.height); commitCfg({ x: p.x, y: p.y }); }
  function setSize(nextSize) {
    const cur = d; const nxt = stateDims('idle', nextSize);
    if (!cur || !nxt) return;
    const f = pxToFrac(cfg.x, cfg.y, cur.width, cur.height);
    const p = fracToPx(f.fx, f.fy, nxt.width, nxt.height);
    commitCfg({ size: nextSize, x: p.x, y: p.y });
  }
  function nudge(dx, dy) { if (!d) return; commitCfg({ x: clamp(cfg.x + dx, 0, d.width - 1), y: clamp(cfg.y + dy, 0, d.height - 1) }); }
  function setNumeric(nx, ny) { if (!d) return; commitCfg({ x: clamp(Math.round(nx), 0, d.width - 1), y: clamp(Math.round(ny), 0, d.height - 1) }); }
  function fromEvent(e) {
    if (!d) return null;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
    const fy = clamp((e.clientY - r.top) / r.height, 0, 1);
    const p = fracToPx(fx, fy, d.width, d.height);
    return { x: p.x, y: p.y };
  }
  function onDown(e) { e.preventDefault(); setDragging(true); const n = fromEvent(e); if (n) commitCfg(n); }
  function onMove(e) { if (!dragging) return; const n = fromEvent(e); if (n) commitCfg(n); }
  function onUp(e) { if (!dragging) return; setDragging(false); const n = fromEvent(e); if (n) commitCfg(n); }

  const PRESETS = [
    { label: '左上', fx: 0.267, fy: 0.19 }, { label: '头顶', fx: 0.5, fy: 0.12 },
    { label: '脸/胸口', fx: 0.5, fy: 0.3 }, { label: '画面中心', fx: 0.5, fy: 0.5 },
    { label: '脚底', fx: 0.44, fy: 0.97 },
  ];
  const fxp = d ? cfg.x / (d.width - 1) : 0.5;
  const fyp = d ? cfg.y / (d.height - 1) : 0.5;
  const checker = {
    backgroundImage: 'conic-gradient(#d8d8d8 0 25%, #f3f3f3 0 50%, #d8d8d8 0 75%, #f3f3f3 0)',
    backgroundSize: '16px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative', userSelect: 'none', touchAction: 'none',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
    width: '100%', height: 200, overflow: 'hidden',
  };
  const input = {
    width: 60, padding: '3px 6px', fontSize: 13, borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  };

  const card = {
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12,
    padding: '14px 16px', background: 'var(--dsw-alias-bg-layer-2)',
  };
  const cardTitle = { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 };
  const smallNote = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, marginTop: 8 };

  return H('div', { style: { maxWidth: 700, display: 'flex', flexDirection: 'column', gap: 14 } },

    // ---- 总开关 ----
    H('div', { style: card },
      H('div', { style: cardTitle },
        cfg.enabled ? '●' : '○',
        cfg.enabled ? '自定义光标已启用' : '自定义光标已停用'),
      H('button', {
        onClick: function () { commitCfg({ enabled: !cfg.enabled }); },
        style: Object.assign({}, chip(cfg.enabled), { width: '100%', padding: '9px 0', fontSize: 14 }),
        'aria-pressed': cfg.enabled,
      }, cfg.enabled ? '点击停用（恢复系统光标）' : '点击启用'),
      H('div', { style: smallNote }, cfg.enabled ? '改动即时生效，无需刷新页面。' : '当前使用系统默认光标。')),

    // ---- 形象自动切换 ----
    H('div', { style: card },
      H('div', { style: cardTitle }, '形象自动切换',
        H('span', { style: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, '光标与右上角角色同步')),
      H('div', { style: Object.assign({}, row, { gap: 8 }) },
        H('button', { onClick: function () { commitCfg({ visualSwitch: !cfg.visualSwitch }); }, style: chip(cfg.visualSwitch !== false) },
          cfg.visualSwitch !== false ? '✓ 形象自动切换' : '✗ 形象自动切换已关'),
        H('button', { onClick: function () { commitCfg({ moveWork: !cfg.moveWork }); }, style: chip(cfg.moveWork !== false) },
          cfg.moveWork !== false ? '✓ 鼠标移动=工作' : '✗ 不按移动切换'),
        H('button', { onClick: function () { commitCfg({ typingEnable: !cfg.typingEnable }); }, style: chip(cfg.typingEnable) },
          cfg.typingEnable ? '✓ 输入框=打字' : '✗ 打字切换关'),
        H('button', { onClick: function () { commitCfg({ busyEnable: !cfg.busyEnable }); }, style: chip(cfg.busyEnable) },
          cfg.busyEnable ? '✓ Agent运行=工作' : '✗ 忙碌切换关'),
        H('button', { onClick: function () { commitCfg({ bubbleFollow: !cfg.bubbleFollow }); }, style: chip(cfg.bubbleFollow !== false) },
          cfg.bubbleFollow !== false ? '✓ 气泡表情同步' : '✗ 气泡表情独立')),
      H('div', { style: smallNote },
        '只要鼠标在动就切「工作」形象，静止后回「休闲」；输入框获得焦点切「键盘」；Agent 思考/回复期间强制「工作」。' +
        '形象图在 assets/states/{idle,typing,busy,angry,shy}/source.png，重建：node scripts/build-cursor.js。')),

    // ---- 尺寸 & 热点 ----
    H('div', { style: card },
      H('div', { style: cardTitle }, '光标大小与热点',
        H('span', { style: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, '尺寸三态共用，热点按比例换算')),
      H('div', { style: row },
        [32, 48, 64, 96].map(function (s) {
          return H('button', { key: s, onClick: function () { setSize(s); }, style: chip(cfg.size === s) }, s + 'px');
        })),
      H('div', { style: Object.assign({}, row, { justifyContent: 'space-between', marginTop: 12 }) },
        H('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '热点位置（点/拖预览图）'),
        H('span', { style: textMuted, fontSize: 12 },
          d ? ('待机 ' + cfg.x + ',' + cfg.y +
            (dTyping ? ' · 输入 ' + Math.round(cfg.x * (dTyping.width - 1) / Math.max(1, d.width - 1)) + ',' + Math.round(cfg.y * (dTyping.height - 1) / Math.max(1, d.height - 1)) : '') +
            (dBusy ? ' · 工作 ' + Math.round(cfg.x * (dBusy.width - 1) / Math.max(1, d.width - 1)) + ',' + Math.round(cfg.y * (dBusy.height - 1) / Math.max(1, d.height - 1)) : '')) : '')),
      H('div', { style: checker, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: onUp },
        d ? H('img', { src: d.url, draggable: false, style: { maxWidth: 300, maxHeight: 170, width: 'auto', height: 'auto', pointerEvents: 'none', imageRendering: 'pixelated' } }) : null,
        H('div', { style: { position: 'absolute', left: (fxp * 100) + '%', top: (fyp * 100) + '%', width: 0, height: 0, pointerEvents: 'none' } },
          H('div', { style: { position: 'relative', left: -8, top: -8, width: 16, height: 16, border: '2px solid #ff00ff', borderRadius: '50%', background: 'rgba(255,255,255,0.8)', boxShadow: '0 0 0 2px rgba(255,255,255,0.5)' } }))),
      H('div', { style: Object.assign({}, row, { marginTop: 10 }) },
        H('span', { style: textMuted, fontSize: 13 }, '预设：'),
        PRESETS.map(function (p) {
          return H('button', { key: p.label, onClick: function () { setHotFrac(p.fx, p.fy); }, style: Object.assign({}, chip(false), { padding: '3px 10px', fontSize: 12 }) }, p.label);
        })),
      H('div', { style: Object.assign({}, row, { marginTop: 10 }) },
        H('button', { onClick: function () { nudge(-1, 0); }, style: chip(false) }, '←'),
        H('button', { onClick: function () { nudge(1, 0); }, style: chip(false) }, '→'),
        H('button', { onClick: function () { nudge(0, -1); }, style: chip(false) }, '↑'),
        H('button', { onClick: function () { nudge(0, 1); }, style: chip(false) }, '↓'),
        H('span', { style: textMuted, fontSize: 13 }, 'x '),
        H('input', { type: 'number', min: 0, max: d ? d.width - 1 : 0, value: cfg.x, style: input,
          onChange: function (e) { setNumeric(Number(e.target.value), cfg.y); } }),
        H('span', { style: textMuted, fontSize: 13 }, 'y '),
        H('input', { type: 'number', min: 0, max: d ? d.height - 1 : 0, value: cfg.y, style: input,
          onChange: function (e) { setNumeric(cfg.x, Number(e.target.value)); } }))),

    // ---- 气泡伙伴 ----
    H('div', { style: card },
      H('div', { style: cardTitle }, '右上角气泡伙伴',
        H('span', { style: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, '可拖动 · 点它说话')),
      H('div', { style: Object.assign({}, row, { gap: 8 }) },
        H('button', { onClick: function () { if (!cfg.buddyShow) autoHidden = false; commitCfg({ buddyShow: !cfg.buddyShow }); }, style: chip(cfg.buddyShow) },
          cfg.buddyShow ? '● 气泡显示中' : '○ 气泡已隐藏'),
        H('button', { onClick: function () { commitCfg({ buddyAi: !cfg.buddyAi }); }, style: chip(cfg.buddyAi) },
          cfg.buddyAi ? '✓ ✨AI 台词(节流)' : '✗ AI 台词关'),
        H('button', { onClick: function () { commitCfg({ buddyX: null, buddyY: null }); }, style: chip(false) }, '位置回右上角')),
      H('div', { style: Object.assign({}, row, { marginTop: 10 }) },
        H('span', { style: textMuted, fontSize: 13 }, '气泡大小 '),
        H('input', {
          type: 'range', min: 60, max: 360, step: 5, value: cfg.buddySize || 150,
          onChange: function (e) { commitCfg({ buddySize: Number(e.target.value) }); },
          style: { flex: 1, maxWidth: 200 },
        }),
        H('span', { style: textMuted, fontSize: 13 }, String(cfg.buddySize || 150) + 'px')),
      H('div', { style: Object.assign({}, row, { marginTop: 10 }) },
        H('span', { style: textMuted, fontSize: 13 }, '气泡不透明度 '),
        H('input', {
          type: 'range', min: 30, max: 100, value: cfg.buddyOpacity || 100,
          onChange: function (e) { commitCfg({ buddyOpacity: Number(e.target.value) }); },
          style: { flex: 1, maxWidth: 200 },
        }),
        H('span', { style: textMuted, fontSize: 13 }, String(cfg.buddyOpacity || 100) + '%')),
      H('div', { style: smallNote },
        (native ? '已启用全局监听：点页面任意位置它都会搭话；拖拽时生气、放下后害羞、连点 4 次会真生气。' : '全局监听不可用（降级：点气泡才搭话）。') +
        'AI 台词使用当前默认模型（约 20 秒/条节流，产生少量 token）。')),

    // ---- 说明 ----
    H('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.7, padding: '2px 4px' } },
      '换形象图：把 PNG 放到 assets/states/<形象>/source.png（黑底/白底均可自动抠图，不会误伤人物），然后运行 node scripts/build-cursor.js；配置保存在插件进程内，刷新页面不丢失。'));

}

return {
  async apply(ctx) {
    const slots = ctx.get('slots');
    const timer = ctx.get('timer');
    if (native) {
      try {
        window.addEventListener('pointerdown', globalPointerDown);
        window.addEventListener('pointermove', function () { onAnyActivity(); applyCursor(); });
        window.addEventListener('keydown', onAnyActivity);
        window.addEventListener('focusin', globalFocusIn, true);
        ctx.effect(function () {
          return function () {
            try { window.removeEventListener('pointerdown', globalPointerDown); window.removeEventListener('keydown', onAnyActivity); window.removeEventListener('focusin', globalFocusIn, true); } catch (er) {}
          };
        });
      } catch (er) {
        console.error('dsh-cursor: native listeners failed: ' + (er && er.message ? er.message : String(er)));
      }
    }
    if (timer !== undefined) {
      pollDispose = timer.interval(function () { tick(); }, 700);
      ctx.effect(function () { return pollDispose; });
    }
    try {
      const res = await host.call('dsh-cursor:get', {});
      if (res && res.cfg && res.meta) {
        setShared({ cfg: res.cfg, busy: res.live ? res.live.busy : false, userSeq: res.live ? res.live.userSeq : 0, meta: res.meta });
        lastBusy = res.live ? res.live.busy : false;
        lastSeq = res.live ? res.live.userSeq : 0;
        refreshVisual();
        setSpeech(pickLine(IDLE_LINES));
      }
    } catch (e) {
      console.error('dsh-cursor: init failed (host offline?): ' + (e && e.message ? e.message : String(e)));
    }
    if (slots === undefined) return;
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'dsh-cursor-buddy', order: 90, label: 'Cursor buddy' },
      function (props) { return H(BuddyCard, {}); },
    ));
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'dsh-cursor', order: 30, label: () => '鼠标光标' },
      function (props) { return H(CursorPanel, {}); },
    ));
  },
};