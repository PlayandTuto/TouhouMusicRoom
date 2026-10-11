import TRACKS from "./tracks.js";
const DUR = 60, MAX = 12;
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/room\/([a-z0-9]{1,24})$/);
    if (!m) return new Response("Touhou Music Room relay");
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    if (env.ALLOWED_ORIGIN && req.headers.get("Origin") !== env.ALLOWED_ORIGIN) return new Response("Forbidden", { status: 403 });
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  }
};

export class Room {
  constructor() { this.players = new Map(); this.round = null; this.used = []; this.timer = null; this.nid = 1; }

  async fetch() {
    if (this.players.size >= MAX) return new Response("Pokój pełny", { status: 403 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const p = { id: this.nid++, ws: server, n: "", s: 0, g: false, joined: false, last: 0 };
    this.players.set(p.id, p);
    server.send(JSON.stringify({ t: "hello", id: p.id }));
    server.addEventListener("message", e => {
      if (typeof e.data !== "string" || e.data.length > 600) return;
      const now = Date.now(); if (now - p.last < 150) return; p.last = now;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m === "object") this.handle(p, m);
    });
    const bye = () => {
      if (!this.players.delete(p.id)) return;
      if (!this.players.size) { clearTimeout(this.timer); this.round = null; this.used = []; return; }
      if (this.round && this.allGuessed()) this.end();
      this.sync();
    };
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }

  joined() { return [...this.players.values()].filter(p => p.joined); }
  send(p, m) { try { p.ws.send(JSON.stringify(m)); } catch {} }
  bc(m) { for (const p of this.joined()) this.send(p, m); }
  sync() { const h = this.joined()[0]; this.bc({ t: "state", host: h ? h.id : null, p: this.joined().map(p => ({ n: p.n, s: p.s })) }); }
  allGuessed() { const j = this.joined(); return j.length > 0 && j.every(p => p.g); }

  handle(p, m) {
    if (m.t === "join" && !p.joined) {
      p.n = String(m.name || "").replace(/[<>]/g, "").trim().slice(0, 16) || "Gracz" + p.id;
      p.joined = true;
      this.send(p, { t: "titles", l: TRACKS.map(x => x.title) });
      this.sync();
      return;
    }
    if (!p.joined) return;
    const host = this.joined()[0];
    if (m.t === "chat") { const x = String(m.x || "").slice(0, 200).trim(); if (x) this.bc({ t: "chat", n: p.n, x }); }
    else if (m.t === "guess") this.guess(p, String(m.x || "").slice(0, 100));
    else if (m.t === "start" && host === p) this.start();
    else if (m.t === "skip" && host === p) this.end();
  }

  start() {
    if (!TRACKS.length) return;
    if (this.round) this.end();
    let pool = TRACKS.map((_, i) => i).filter(i => !this.used.includes(i));
    if (!pool.length) { this.used = []; pool = TRACKS.map((_, i) => i); }
    const i = pool[Math.random() * pool.length | 0];
    this.used.push(i);
    this.joined().forEach(p => p.g = false);
    this.round = { tr: TRACKS[i], end: Date.now() + DUR * 1000 };
    this.bc({ t: "round", url: this.round.tr.url, sec: DUR });
    this.timer = setTimeout(() => this.end(), DUR * 1000);
  }

  end() {
    if (!this.round) return;
    clearTimeout(this.timer);
    const r = this.round; this.round = null;
    this.bc({ t: "reveal", title: r.tr.title, game: r.tr.game });
  }

  guess(p, x) {
    if (!this.round || p.g) return;
    const g = norm(x); if (g.length < 2) return;
    const keys = [this.round.tr.title, ...(this.round.tr.aliases || [])].map(norm);
    if (keys.some(k => g === k || (g.length >= 5 && k.includes(g)) || (k.length >= 5 && g.includes(k)))) {
      p.g = true;
      p.s += Math.max(1, Math.ceil((this.round.end - Date.now()) / 6000));
      this.bc({ t: "chat", n: "system", x: p.n + " zgadł(a)!" });
      this.sync();
      if (this.allGuessed()) this.end();
    }
  }
}
