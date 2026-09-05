// DeepSeek Harness "custom cursor" plugin - HOST half (v4, multi-state + buddy + AI lines).
// - Serves transparent cursor PNGs per state (idle / typing / busy) x size, plus the
//   buddy image, over the harness web server.
// - Tracks agent activity: busy (agent/status running) and user-message events
//   (agent/inbox/inserted) so the CLIENT can swap cursors and make the buddy talk.
// - Keeps control-panel state in memory; exposes dsh-cursor:get/set RPC.
// - dsh-cursor:line generates one short AI "buddy line" (opt-in, throttled, tiny tokens).
//
// EDIT: IMAGE_DIR must point at your clone's assets/ folder.
// License: MIT

const IMAGE_DIR = 'D:\\33061\\Documents\\dsh\\mouse cursor\\assets';
const ROUTE_PREFIX = '/.dsh-cursor/';
const MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_CFG = {
  enabled: true, size: 48, x: 12, y: 9,
  typingEnable: true, busyEnable: true, visualSwitch: true, bubbleFollow: true, moveWork: true,
  buddyShow: true, buddyAi: false, buddyOpacity: 100, buddySize: 150, buddyX: null, buddyY: null,
};
const AI_SYSTEM =
  '你是出现在 DeepSeek Harness 页面右上角的 Q 版女仆吉祥物（奥兰，碧蓝航线风格）。' +
  '用一句俏皮可爱的中文回应画面外的玩家，长度 8~35 字，可带 ~ 或简单颜文字，' +
  '不要解释、不要引号、不要换行。';
const AI_MIN_GAP_MS = 20000;

function pngDims(bytes) {
  if (!bytes || bytes.length < 26) return null;
  return {
    width: ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0,
    height: ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0,
  };
}

return {
  async apply(ctx) {
    const fs = ctx.get('fs');
    const webServer = ctx.get('webServer');
    if (fs === undefined || webServer === undefined) return;

    const readBytes = async (rel) => {
      try {
        const target = await fs.resolve(IMAGE_DIR + '\\' + rel);
        return await fs.readBytes(target, undefined, MAX_BYTES);
      } catch (err) {
        console.error('cursor host: read failed for ' + rel + ': ' +
          (err && err.message ? err.message : String(err)));
        return null;
      }
    };
    const readText = async (rel) => {
      try {
        const target = await fs.resolve(IMAGE_DIR + '\\' + rel);
        return await fs.readText(target, undefined);
      } catch (err) {
        console.error('cursor host: read text failed for ' + rel + ': ' +
          (err && err.message ? err.message : String(err)));
        return null;
      }
    };

    // ---- load manifest & bytes ----
    const manifestText = await readText('states-manifest.json');
    let manifest = null;
    try { manifest = manifestText ? JSON.parse(manifestText) : null; } catch (e) { manifest = null; }
    if (!manifest || !manifest.states) {
      console.error('cursor host: assets/states-manifest.json missing or invalid under ' + IMAGE_DIR);
      return;
    }

    const meta = { states: {}, buddyUrls: {} };
    const routes = [];
    const rev = String(Date.now());

    const stateNames = ['idle', 'typing', 'busy'];
    for (const name of stateNames) {
      const st = manifest.states[name];
      if (!st || !st.sizes) continue;
      const list = [];
      for (const s of st.sizes) {
        const rel = 'states\\' + name + '\\' + s.file;
        const bytes = await readBytes(rel);
        if (!bytes || bytes.length === 0) continue;
        const dims = pngDims(bytes) || { width: s.width, height: s.height };
        const url = ROUTE_PREFIX + name + '/' + s.file + '?v=' + rev;
        list.push({ size: s.size, url: url, width: dims.width, height: dims.height });
        const payload = bytes;
        routes.push({ path: ROUTE_PREFIX + name + '/' + s.file, payload: payload });
      }
      meta.states[name] = { sizes: list };
    }
    meta.buddyUrls = {};
    if (manifest.buddy && manifest.buddy.states) {
      for (const stName of Object.keys(manifest.buddy.states)) {
        const b = manifest.buddy.states[stName];
        if (!b || !b.file) continue;
        const rel = 'buddy\\' + b.file;
        const bytes = await readBytes(rel);
        if (!bytes || bytes.length === 0) continue;
        const dims = pngDims(bytes) || { width: b.width, height: b.height };
        const url = ROUTE_PREFIX + 'buddy/' + b.file + '?v=' + rev;
        meta.buddyUrls[stName] = { url: url, width: dims.width, height: dims.height };
        routes.push({ path: ROUTE_PREFIX + 'buddy/' + b.file, payload: bytes });
      }
    }
    if (routes.length === 0) {
      console.error('cursor host: no assets could be loaded');
      return;
    }
    for (const r of routes) {
      const route = { kind: 'exact', path: r.path, handler(req, res) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache',
          'Content-Length': r.payload.length,
        });
        res.end(r.payload);
      } };
      ctx.effect(() => webServer.register(route));
    }
    console.log('cursor host: registered ' + routes.length + ' asset routes');

    // ---- state & events ----
    let cfg = Object.assign({}, DEFAULT_CFG);
    let busy = false;
    let userSeq = 0;
    const lastUser = { time: 0 };
    ctx.on('agent/status', (payload) => {
      const st = payload && payload.status;
      busy = st === 'running';
    });
    ctx.on('agent/inbox/inserted', (payload) => {
      if (payload && payload.message && payload.message.role === 'user') {
        userSeq++;
        lastUser.time = Date.now();
      }
    });

    // ---- RPC ----
    harness.handle('dsh-cursor:get', () => ({
      cfg: cfg,
      meta: meta,
      live: { busy: busy, userSeq: userSeq },
    }));

    harness.handle('dsh-cursor:set', (patch) => {
      const p = patch || {};
      const n = Object.assign({}, cfg);
      if (typeof p.enabled === 'boolean') n.enabled = p.enabled;
      if (typeof p.size === 'number') n.size = p.size;
      if (typeof p.x === 'number') n.x = p.x;
      if (typeof p.y === 'number') n.y = p.y;
      if (typeof p.typingEnable === 'boolean') n.typingEnable = p.typingEnable;
      if (typeof p.busyEnable === 'boolean') n.busyEnable = p.busyEnable;
      if (typeof p.buddyShow === 'boolean') n.buddyShow = p.buddyShow;
      if (typeof p.buddyAi === 'boolean') n.buddyAi = p.buddyAi;
      if (typeof p.buddyOpacity === 'number') n.buddyOpacity = Math.max(30, Math.min(100, p.buddyOpacity));
      if (typeof p.buddySize === 'number') n.buddySize = Math.max(60, Math.min(360, p.buddySize));
      if (p.buddyX === null || typeof p.buddyX === 'number') n.buddyX = p.buddyX;
      if (p.buddyY === null || typeof p.buddyY === 'number') n.buddyY = p.buddyY;
      if (typeof p.visualSwitch === 'boolean') n.visualSwitch = p.visualSwitch;
      if (typeof p.bubbleFollow === 'boolean') n.bubbleFollow = p.bubbleFollow;
      if (typeof p.moveWork === 'boolean') n.moveWork = p.moveWork;
      cfg = n;
      return { cfg: cfg };
    });

    let lastAiAt = 0;
    let aiRunning = false;
    const AI_PROMPT_EXTRA = {
      click: '（她正被玩家点了一下，想和你闲聊）',
      busy: '（主人刚刚让 AI 开始干活，她在旁边加油打气）',
      user: '（主人刚发来一条消息，她在卖萌回应）',
    };
    harness.handle('dsh-cursor:line', async (args) => {
      const a = args || {};
      const hint = typeof a.hint === 'string' ? a.hint : 'click';
      if (!cfg.buddyAi) return { ok: false, why: 'ai-off' };
      const now = Date.now();
      if (aiRunning) return { ok: false, why: 'busy' };
      if (now - lastAiAt < AI_MIN_GAP_MS) return { ok: false, why: 'throttle' };
      const llm = ctx.get('llm');
      const adm = ctx.get('agentDefaultModel');
      if (llm === undefined || adm === undefined) return { ok: false, why: 'no-llm' };
      aiRunning = true;
      try {
        const sel = adm.currentSelection();
        const provider = sel && sel.provider ? sel.provider : null;
        const model = sel && sel.model ? sel.model : null;
        if (!provider || !model) return { ok: false, why: 'no-model' };
        const extra = AI_PROMPT_EXTRA[hint] || AI_PROMPT_EXTRA.click;
        const msg = {
          id: 'dshc-' + now + '-' + Math.floor(Math.random() * 1e6),
          role: 'user',
          content: [{ type: 'text', text: extra }],
          source: { kind: 'user' },
        };
        let out = '';
        for await (const chunk of llm.stream({
          provider: provider,
          model: model,
          system: AI_SYSTEM,
          messages: [msg],
          maxTokens: 90,
          temperature: 1.2,
        })) {
          if (chunk.type === 'text-delta') out += chunk.text;
          else if (chunk.type === 'finish') break;
        }
        const text = String(out || '').trim().replace(/\s+/g, ' ').slice(0, 200);
        if (!text) return { ok: false, why: 'empty' };
        lastAiAt = now;
        return { ok: true, text: text };
      } catch (err) {
        console.error('cursor host: ai line failed: ' + (err && err.message ? err.message : String(err)));
        return { ok: false, why: 'error' };
      } finally {
        aiRunning = false;
      }
    });
  },
};