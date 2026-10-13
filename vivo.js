// vivo.js — «Compartí tu vuelo en vivo» (Oscar).
//
// QUÉ ES (2026-10-12, idea de Matías, como en Pilotfy): el piloto toca
// «Compartir en vivo», la app crea un vuelo acá y comparte un link por
// WhatsApp. Quien lo abre ve en un mapa dónde va el avión, por dónde pasó,
// altura, velocidad y hora estimada de llegada, sin instalar nada.
//
// CÓMO: la app manda tandas de posiciones (cada ~20 s) con la `clave` que
// recibe al crear el vuelo (así nadie más puede cargar puntos en ese link).
// La página pide sólo lo nuevo cada 15 s.
//
// QUÉ GUARDA: código, clave, matrícula/origen/destino que manda la app y los
// puntos (hora, lat, lon, altura, velocidad, rumbo). Nada de cuentas. El
// vuelo se borra a los 2 días; el link deja de mostrarse 6 h después del
// último punto o 2 h después de terminado.
//
// Sin DATABASE_URL vive en memoria (para probar en local).

import pg from "pg";
import crypto from "crypto";

const MAX_POR_HORA_IP = 20;          // vuelos nuevos por IP
const MAX_PUNTOS_POR_TANDA = 300;
const MAX_PUNTOS_POR_VUELO = 20_000; // ~55 h a un punto cada 10 s
const VISIBLE_TRAS_ULTIMO_H = 6;
const VISIBLE_TRAS_FIN_H = 2;
const BORRAR_TRAS_DIAS = 2;
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

let pool = null;
let ultimoIntentoDB = 0;
const memoria = new Map();           // codigo -> { vuelo, puntos: [] }
const porIP = new Map();

async function asegurarPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  if (Date.now() - ultimoIntentoDB < 30_000) return null;
  ultimoIntentoDB = Date.now();
  let candidato = null;
  try {
    // Pool propio y chico, como duelos.js y logbook.js.
    candidato = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2
    });
    candidato.on("error", (e) => console.error("[vivo] Postgres:", e.message));
    await candidato.query(`
      CREATE TABLE IF NOT EXISTS vivos (
        codigo      TEXT PRIMARY KEY,
        clave       TEXT NOT NULL,
        matricula   TEXT,
        origen      TEXT,
        destino     TEXT,
        dest_lat    DOUBLE PRECISION,
        dest_lon    DOUBLE PRECISION,
        creado      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        terminado   TIMESTAMPTZ,
        puntos      INTEGER NOT NULL DEFAULT 0
      );`);
    await candidato.query(`
      CREATE TABLE IF NOT EXISTS vivo_puntos (
        codigo  TEXT NOT NULL,
        t       TIMESTAMPTZ NOT NULL,
        lat     DOUBLE PRECISION NOT NULL,
        lon     DOUBLE PRECISION NOT NULL,
        alt_ft  REAL,
        gs_kt   REAL,
        trk     REAL
      );`);
    await candidato.query(
      `CREATE INDEX IF NOT EXISTS vivo_puntos_codigo_t ON vivo_puntos (codigo, t);`);
    // Coordenadas del origen para marcar la salida (2026-10-12).
    await candidato.query(`ALTER TABLE vivos ADD COLUMN IF NOT EXISTS orig_lat DOUBLE PRECISION;`);
    await candidato.query(`ALTER TABLE vivos ADD COLUMN IF NOT EXISTS orig_lon DOUBLE PRECISION;`);
    pool = candidato;
    console.log("[vivo] guardados en Postgres");
    return pool;
  } catch (e) {
    if (candidato) { try { await candidato.end(); } catch {} }
    pool = null;
    console.error("[vivo] no se pudo preparar la tabla:", e.message);
    return null;
  }
}

export async function initDB() {
  await asegurarPool();
  // Limpieza cada hora: los vuelos viejos no tienen por qué quedar.
  setInterval(limpiar, 3_600_000).unref?.();
}

async function limpiar() {
  try {
    const db = await asegurarPool();
    if (db) {
      await db.query(`DELETE FROM vivo_puntos WHERE codigo IN
        (SELECT codigo FROM vivos WHERE actualizado < NOW() - INTERVAL '${BORRAR_TRAS_DIAS} days')`);
      await db.query(`DELETE FROM vivos WHERE actualizado < NOW() - INTERVAL '${BORRAR_TRAS_DIAS} days'`);
    } else {
      const corte = Date.now() - BORRAR_TRAS_DIAS * 86_400_000;
      for (const [c, v] of memoria) if (new Date(v.vuelo.actualizado).getTime() < corte) memoria.delete(c);
    }
  } catch (e) {
    console.error("[vivo] limpiar:", e.message);
  }
}

export function estado() {
  return { persistidos: !!pool, en_memoria: memoria.size };
}

// ── Validación ────────────────────────────────────────────────────────────

function texto(v, largo) {
  const s = String(v ?? "").replace(/[^\p{L}\p{N} .\-_/]/gu, "").trim().slice(0, largo);
  return s || null;
}

function numero(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function nuevoCodigo() {
  const b = crypto.randomBytes(7);
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join("");
}

function permitido(ip) {
  const ahora = Date.now();
  const lista = (porIP.get(ip) || []).filter((t) => ahora - t < 3_600_000);
  if (lista.length >= MAX_POR_HORA_IP) { porIP.set(ip, lista); return false; }
  lista.push(ahora);
  porIP.set(ip, lista);
  return true;
}

function limpiarPunto(p) {
  const t = numero(p?.t, 1.6e9, 4e9);           // segundos epoch
  const lat = numero(p?.lat, -90, 90);
  const lon = numero(p?.lon, -180, 180);
  if (t == null || lat == null || lon == null) return null;
  return {
    t: new Date(t * 1000),
    lat, lon,
    alt_ft: numero(p.alt, -2000, 60000),
    gs_kt: numero(p.gs, 0, 1000),
    trk: numero(p.trk, 0, 360)
  };
}

/// Lo que se ve del vuelo (nunca la clave).
function publico(v) {
  const ult = new Date(v.actualizado).getTime();
  const fin = v.terminado ? new Date(v.terminado).getTime() : null;
  const visible = fin
    ? Date.now() - fin < VISIBLE_TRAS_FIN_H * 3_600_000
    : Date.now() - ult < VISIBLE_TRAS_ULTIMO_H * 3_600_000;
  return {
    codigo: v.codigo,
    matricula: v.matricula, origen: v.origen, destino: v.destino,
    destino_lat: v.dest_lat, destino_lon: v.dest_lon,
    origen_lat: v.orig_lat ?? null, origen_lon: v.orig_lon ?? null,
    creado: new Date(v.creado).toISOString(),
    actualizado: new Date(v.actualizado).toISOString(),
    terminado: v.terminado ? new Date(v.terminado).toISOString() : null,
    vencido: !visible
  };
}

function puntoPublico(p) {
  return { t: new Date(p.t).getTime() / 1000, lat: p.lat, lon: p.lon,
           alt: p.alt_ft, gs: p.gs_kt, trk: p.trk };
}

async function buscar(codigo) {
  const db = await asegurarPool();
  if (!db) return memoria.get(codigo)?.vuelo || null;
  const r = await db.query("SELECT * FROM vivos WHERE codigo = $1", [codigo]);
  return r.rows[0] || null;
}

// ── Página del link ───────────────────────────────────────────────────────

function escapar(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pagina(v) {
  const codigo = v ? escapar(v.codigo) : "";
  const titulo = v
    ? `${v.matricula ? escapar(v.matricula) : "Un avión"} en vuelo · Oscar`
    : "Vuelo en vivo · Oscar";
  const ruta = v && (v.origen || v.destino)
    ? `${escapar(v.origen || "")} → ${escapar(v.destino || "")}` : "Seguí el vuelo en el mapa";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${titulo}</title>
<meta property="og:title" content="${titulo}">
<meta property="og:description" content="${ruta}">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
html,body{margin:0;height:100%;font-family:-apple-system,system-ui,sans-serif;background:#0B1420;color:#F2F4F7}
#mapa{position:absolute;inset:0}
.tarjeta{position:absolute;left:12px;right:12px;z-index:1000;background:rgba(11,20,32,.92);
border-radius:16px;padding:12px 14px;box-shadow:0 4px 16px rgba(0,0,0,.35)}
#arriba{top:12px}#abajo{bottom:12px}
.fila{display:flex;align-items:center;gap:10px}
.mat{font:800 20px ui-monospace,monospace;letter-spacing:1px}
.ruta{color:#9AA5B4;font-size:14px;margin-top:2px}
.estado{margin-left:auto;font-size:12px;font-weight:800;padding:4px 8px;border-radius:8px;background:#161F2B}
.vivo{color:#FF4D5E}.vivo::before{content:"● ";animation:t 1.2s infinite}
@keyframes t{50%{opacity:.25}}
.datos{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center}
.datos b{display:block;font:800 18px ui-rounded,system-ui;font-variant-numeric:tabular-nums}
.datos span{font-size:10px;font-weight:700;letter-spacing:.8px;color:#9AA5B4}
.pie{color:#6B7684;font-size:11px;text-align:center;margin-top:8px}
.pie a{color:#9AA5B4}
.aviso{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:30px}
.avion{width:30px;height:30px;transform-origin:50% 50%}
.etq{background:#0B1420;color:#F2F4F7;border:none;border-radius:6px;font:800 12px ui-monospace,monospace;
padding:2px 6px;box-shadow:0 1px 4px rgba(0,0,0,.4)}
.etq::before{display:none}
</style></head><body>
${v ? `<div id="mapa"></div>
<div class="tarjeta" id="arriba"><div class="fila">
<div><div class="mat">${v.matricula ? escapar(v.matricula) : "En vuelo"}</div><div class="ruta">${ruta}</div></div>
<div class="estado" id="estado">…</div></div></div>
<div class="tarjeta" id="abajo">
<div class="datos">
<div><span>GS</span><b id="gs">—</b></div>
<div><span>ALT</span><b id="alt">—</b></div>
<div><span>RUMBO</span><b id="trk">—</b></div>
<div><span>LLEGA</span><b id="eta">—</b></div></div>
<div class="pie"><span id="hace"></span> · Seguido con Oscar</div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const COD = "${codigo}";
const mapa = L.map("mapa", { zoomControl: false, attributionControl: true });
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 15, attribution: "© OpenStreetMap"
}).addTo(mapa);
mapa.setView([-34.6, -58.6], 8);
const traza = L.polyline([], { color: "#2B86FF", weight: 4 }).addTo(mapa);
const icono = L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
  html: '<svg class="avion" id="av" viewBox="0 0 24 24"><path fill="#FFD60A" stroke="#000" stroke-width=".8" d="M12 2c.8 0 1.3.8 1.3 1.8V9l7.7 4.6v1.9l-7.7-2.3v4.6l2.2 1.6V21L12 20.1 8.5 21v-1.6l2.2-1.6v-4.6L3 15.5v-1.9L10.7 9V3.8C10.7 2.8 11.2 2 12 2z"/></svg>' });
let marca = null, ultimo = 0, encuadrado = false, info = null, ultPunto = null;
let destino = null;
// Salida (verde) y llegada (roja), y lo que falta hasta el destino punteado
// (Matías, 2026-10-12: «para que quede más completo»).
let marcaSalida = null, marcaLlegada = null;
const falta = L.polyline([], { color: "#9AA5B4", weight: 2, dashArray: "6 8" }).addTo(mapa);
function punto(ll, color, texto) {
  const m = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 }).addTo(mapa);
  if (texto) m.bindTooltip(texto, { permanent: true, direction: "top", offset: [0, -8], className: "etq" });
  return m;
}
function marcarExtremos() {
  if (!marcaSalida) {
    let ll = null;
    if (info.origen_lat != null && info.origen_lon != null) ll = [info.origen_lat, info.origen_lon];
    else if (traza.getLatLngs().length) ll = traza.getLatLngs()[0];
    if (ll) marcaSalida = punto(ll, "#34C759", info.origen);
  }
  if (!marcaLlegada && destino) marcaLlegada = punto(destino, "#FF3B30", info.destino);
  else if (marcaLlegada && destino) marcaLlegada.setLatLng(destino);
  falta.setLatLngs(destino && ultPunto && !info.terminado ? [[ultPunto.lat, ultPunto.lon], destino] : []);
}
function encuadre() {
  const b = traza.getLatLngs().length ? traza.getBounds() : null;
  const extras = [marcaSalida, marcaLlegada].filter(Boolean).map((m) => m.getLatLng());
  if (!b && !extras.length) return false;
  const todo = b ? L.latLngBounds(b.getSouthWest(), b.getNorthEast()) : L.latLngBounds(extras[0], extras[0]);
  extras.forEach((e) => todo.extend(e));
  mapa.fitBounds(todo, { padding: [60, 140], maxZoom: 12 });
  return true;
}
function fmtHora(d){ return d.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hourCycle:"h23"}); }
function nm(a,b){ const R=3440.065, r=Math.PI/180;
  const dLat=(b[0]-a[0])*r, dLon=(b[1]-a[1])*r;
  const x=Math.sin(dLat/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x)); }
function pintar(){
  const e = document.getElementById("estado");
  if (info.terminado) { e.textContent = "Terminó"; e.className = "estado"; }
  else { e.textContent = "EN VIVO"; e.className = "estado vivo"; }
  if (!ultPunto) return;
  document.getElementById("gs").textContent = ultPunto.gs!=null ? Math.round(ultPunto.gs)+" kt" : "—";
  document.getElementById("alt").textContent = ultPunto.alt!=null ? Math.round(ultPunto.alt/10)*10+" ft" : "—";
  document.getElementById("trk").textContent = ultPunto.trk!=null ? String(Math.round(ultPunto.trk)).padStart(3,"0")+"°" : "—";
  let eta = "—";
  if (destino && !info.terminado && ultPunto.gs > 30) {
    const d = nm([ultPunto.lat, ultPunto.lon], destino);
    eta = fmtHora(new Date(Date.now() + d / ultPunto.gs * 3600000));
  }
  document.getElementById("eta").textContent = eta;
  const seg = Math.max(0, Math.round(Date.now()/1000 - ultPunto.t));
  document.getElementById("hace").textContent =
    seg < 60 ? "Actualizado hace " + seg + " s" : "Actualizado hace " + Math.round(seg/60) + " min";
}
async function pedir(){
  try {
    const r = await fetch("/vivos/" + COD + "?desde=" + ultimo);
    if (!r.ok) return;
    const j = await r.json();
    info = j.vuelo;
    if (info.destino_lat != null && info.destino_lon != null) destino = [info.destino_lat, info.destino_lon];
    for (const p of j.puntos) { traza.addLatLng([p.lat, p.lon]); ultimo = Math.max(ultimo, p.t); ultPunto = p; }
    if (ultPunto) {
      const ll = [ultPunto.lat, ultPunto.lon];
      if (!marca) marca = L.marker(ll, { icon: icono }).addTo(mapa); else marca.setLatLng(ll);
      const av = document.getElementById("av");
      if (av && ultPunto.trk != null) av.style.transform = "rotate(" + ultPunto.trk + "deg)";
    }
    marcarExtremos();
    if (!encuadrado) encuadrado = encuadre();
    pintar();
    if (info.vencido) return;
  } catch (e) {}
}
pedir(); setInterval(pedir, 15000); setInterval(()=>{ if (info) pintar(); }, 5000);
</script>` : `<div class="aviso"><div><div style="font-size:48px">✈️</div>
<h2>Este vuelo no existe o ya terminó.</h2></div></div>`}
</body></html>`;
}

// ── Rutas ─────────────────────────────────────────────────────────────────

export function montar(app) {
  // Crear un vuelo en vivo. Devuelve código, clave y link.
  app.post("/vivos", async (req, res) => {
    try {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
      if (!permitido(ip)) return res.status(429).json({ error: "Demasiados vuelos seguidos. Probá en un rato." });
      const b = req.body || {};
      const v = {
        codigo: nuevoCodigo(),
        clave: crypto.randomBytes(16).toString("hex"),
        matricula: texto(b.matricula, 10),
        origen: texto(b.origen, 12),
        destino: texto(b.destino, 12),
        dest_lat: numero(b.destino_lat, -90, 90),
        dest_lon: numero(b.destino_lon, -180, 180),
        orig_lat: numero(b.origen_lat, -90, 90),
        orig_lon: numero(b.origen_lon, -180, 180),
        creado: new Date(), actualizado: new Date(), terminado: null, puntos: 0
      };
      const db = await asegurarPool();
      if (db) {
        await db.query(
          `INSERT INTO vivos (codigo, clave, matricula, origen, destino, dest_lat, dest_lon, orig_lat, orig_lon)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [v.codigo, v.clave, v.matricula, v.origen, v.destino, v.dest_lat, v.dest_lon, v.orig_lat, v.orig_lon]);
      } else {
        memoria.set(v.codigo, { vuelo: v, puntos: [] });
      }
      res.json({ ...publico(v), clave: v.clave,
                 link: `https://notam-api.onrender.com/vivo/${v.codigo}` });
    } catch (e) {
      console.error("[vivo] crear:", e.message);
      res.status(500).json({ error: "No se pudo crear el vuelo" });
    }
  });

  // La app manda una tanda de puntos (y, si cambió, el destino).
  app.post("/vivos/:codigo/puntos", async (req, res) => {
    try {
      const codigo = String(req.params.codigo).toUpperCase();
      const b = req.body || {};
      const clave = String(b.clave || "");
      const puntos = (Array.isArray(b.puntos) ? b.puntos : [])
        .slice(0, MAX_PUNTOS_POR_TANDA).map(limpiarPunto).filter(Boolean);
      const v = await buscar(codigo);
      if (!v) return res.status(404).json({ error: "No existe ese vuelo" });
      if (v.clave !== clave) return res.status(403).json({ error: "Este vuelo no es tuyo" });
      if (v.terminado) return res.status(409).json({ error: "El vuelo ya terminó" });
      if (v.puntos + puntos.length > MAX_PUNTOS_POR_VUELO) return res.status(413).json({ error: "Demasiados puntos" });

      const destino = b.destino !== undefined ? texto(b.destino, 12) : v.destino;
      const dLat = b.destino_lat !== undefined ? numero(b.destino_lat, -90, 90) : v.dest_lat;
      const dLon = b.destino_lon !== undefined ? numero(b.destino_lon, -180, 180) : v.dest_lon;

      const db = await asegurarPool();
      if (db) {
        if (puntos.length) {
          // Un solo INSERT con todos los puntos de la tanda.
          const valores = [];
          const params = [];
          puntos.forEach((p, i) => {
            const k = i * 7;
            valores.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5},$${k + 6},$${k + 7})`);
            params.push(codigo, p.t, p.lat, p.lon, p.alt_ft, p.gs_kt, p.trk);
          });
          await db.query(
            `INSERT INTO vivo_puntos (codigo, t, lat, lon, alt_ft, gs_kt, trk) VALUES ${valores.join(",")}`,
            params);
        }
        await db.query(
          `UPDATE vivos SET actualizado = NOW(), puntos = puntos + $2,
             destino = $3, dest_lat = $4, dest_lon = $5 WHERE codigo = $1`,
          [codigo, puntos.length, destino, dLat, dLon]);
      } else {
        const m = memoria.get(codigo);
        m.puntos.push(...puntos);
        Object.assign(m.vuelo, { actualizado: new Date(), puntos: m.vuelo.puntos + puntos.length,
                                 destino, dest_lat: dLat, dest_lon: dLon });
      }
      res.json({ ok: true, recibidos: puntos.length });
    } catch (e) {
      console.error("[vivo] puntos:", e.message);
      res.status(500).json({ error: "No se pudieron guardar los puntos" });
    }
  });

  // La app termina de compartir (o aterrizó).
  app.post("/vivos/:codigo/fin", async (req, res) => {
    try {
      const codigo = String(req.params.codigo).toUpperCase();
      const clave = String(req.body?.clave || "");
      const v = await buscar(codigo);
      if (!v) return res.status(404).json({ error: "No existe ese vuelo" });
      if (v.clave !== clave) return res.status(403).json({ error: "Este vuelo no es tuyo" });
      const db = await asegurarPool();
      if (db) {
        await db.query(`UPDATE vivos SET terminado = COALESCE(terminado, NOW()) WHERE codigo = $1`, [codigo]);
      } else {
        memoria.get(codigo).vuelo.terminado ??= new Date();
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[vivo] fin:", e.message);
      res.status(500).json({ error: "No se pudo terminar" });
    }
  });

  // Lo que pide la página: el vuelo y los puntos desde `desde` (segundos).
  app.get("/vivos/:codigo", async (req, res) => {
    try {
      const codigo = String(req.params.codigo).toUpperCase();
      const v = await buscar(codigo);
      if (!v) return res.status(404).json({ error: "No existe ese vuelo" });
      const pub = publico(v);
      const desde = numero(req.query.desde, 0, 4e9) ?? 0;
      let puntos = [];
      if (!pub.vencido) {
        const db = await asegurarPool();
        if (db) {
          const r = await db.query(
            `SELECT t, lat, lon, alt_ft, gs_kt, trk FROM vivo_puntos
             WHERE codigo = $1 AND t > to_timestamp($2) ORDER BY t LIMIT 5000`,
            [codigo, desde]);
          puntos = r.rows.map(puntoPublico);
        } else {
          puntos = memoria.get(codigo).puntos
            .filter((p) => p.t.getTime() / 1000 > desde).map(puntoPublico);
        }
      }
      res.set("Cache-Control", "no-store");
      res.json({ vuelo: pub, puntos });
    } catch (e) {
      console.error("[vivo] ver:", e.message);
      res.status(500).json({ error: "No se pudo leer el vuelo" });
    }
  });

  // La página que se abre desde el link compartido.
  app.get("/vivo/:codigo", async (req, res) => {
    let v = null;
    try { v = await buscar(String(req.params.codigo).toUpperCase()); } catch {}
    if (v && publico(v).vencido) v = null;
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(pagina(v));
  });
}
