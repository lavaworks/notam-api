// duelos.js — Duelos de preguntas entre pilotos (Academia de Oscar).
//
// QUÉ ES (2026-10-06, idea de Matías tomada de Preguntados): un piloto
// desafía a un amigo con un link y los dos juegan LAS MISMAS 10 preguntas en
// la app; gana el que acierta más (a igualdad, el más rápido).
//
// ORDEN (2026-10-07, Matías): PRIMERO se crea y se comparte el desafío y
// DESPUÉS juega cada uno. Al revés —jugar y recién ahí compartir— nadie
// mandaba un desafío en el que le había ido mal. Por eso el duelo nace sin
// resultado del retador; él lo manda después con la `clave` que recibe al
// crearlo (así nadie más puede cargar el resultado del retador).
//
// QUÉ GUARDA: sólo el código del duelo, los nombres que cada uno escribió,
// los ids de las preguntas, aciertos y segundos. Nada de cuentas ni datos
// del teléfono. Los duelos vencen a los 30 días.
//
// CONFIANZA: el puntaje lo manda la app y no se puede verificar acá; es un
// juego entre amigos, no un ranking. Igual se acotan los valores y se limita
// la cantidad de duelos por IP para que nadie llene la base.
//
// Sin DATABASE_URL los duelos viven en memoria (se pierden al reiniciar):
// sirve para probar en local.

import pg from "pg";
import crypto from "crypto";

const VENCE_DIAS = 30;
const MAX_POR_HORA_IP = 30;
const PREGUNTAS = 10;
// Sin 0/O, 1/I/L: el código se dicta por teléfono o se copia a mano.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

let pool = null;
let ultimoIntentoDB = 0;
const memoria = new Map();          // codigo -> duelo (sin base)
const porIP = new Map();            // ip -> [timestamps]

async function asegurarPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  if (Date.now() - ultimoIntentoDB < 30_000) return null;
  ultimoIntentoDB = Date.now();
  let candidato = null;
  try {
    // Pool propio y chico, como logbook.js: el módulo queda independiente.
    candidato = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2
    });
    candidato.on("error", (e) => console.error("[duelos] Postgres:", e.message));
    await candidato.query(`
      CREATE TABLE IF NOT EXISTS duelos (
        codigo      TEXT PRIMARY KEY,
        preguntas   INTEGER[] NOT NULL,
        retador     TEXT NOT NULL,
        r_aciertos  INTEGER,
        r_segundos  REAL,
        r_clave     TEXT,
        rival       TEXT,
        v_aciertos  INTEGER,
        v_segundos  REAL,
        creado      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        respondido  TIMESTAMPTZ
      );`);
    // La tabla ya existe en producción con el esquema del 2026-10-06 (el
    // retador jugaba antes de crear): se relaja y se agrega la clave.
    await candidato.query(`ALTER TABLE duelos ALTER COLUMN r_aciertos DROP NOT NULL;`);
    await candidato.query(`ALTER TABLE duelos ALTER COLUMN r_segundos DROP NOT NULL;`);
    await candidato.query(`ALTER TABLE duelos ADD COLUMN IF NOT EXISTS r_clave TEXT;`);
    pool = candidato;
    console.log("[duelos] guardados en Postgres");
    return pool;
  } catch (e) {
    if (candidato) { try { await candidato.end(); } catch {} }
    pool = null;
    console.error("[duelos] no se pudo preparar la tabla:", e.message);
    return null;
  }
}

export async function initDB() { await asegurarPool(); }

export function estado() {
  return { persistidos: !!pool, en_memoria: memoria.size };
}

// ── Validación ────────────────────────────────────────────────────────────

function limpiarNombre(n) {
  // Letras, números, espacios y algo de puntuación; 24 caracteres.
  const s = String(n ?? "").replace(/[^\p{L}\p{N} .\-_']/gu, "").trim().slice(0, 24);
  return s || "Piloto";
}

function entero(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

function segundos(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(3600, Math.max(0, Math.round(n * 10) / 10)) : null;
}

function nuevoCodigo() {
  const b = crypto.randomBytes(6);
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

function publico(d) {
  const vencido = Date.now() - new Date(d.creado).getTime() > VENCE_DIAS * 86_400_000;
  return {
    codigo: d.codigo,
    preguntas: d.preguntas,
    // aciertos/segundos en null = el retador todavía no jugó.
    retador: { nombre: d.retador, aciertos: d.r_aciertos ?? null, segundos: d.r_segundos ?? null },
    rival: d.rival == null ? null
      : { nombre: d.rival, aciertos: d.v_aciertos, segundos: d.v_segundos },
    creado: new Date(d.creado).toISOString(),
    vencido
  };
}

async function buscar(codigo) {
  const db = await asegurarPool();
  if (!db) return memoria.get(codigo) || null;
  const r = await db.query("SELECT * FROM duelos WHERE codigo = $1", [codigo]);
  return r.rows[0] || null;
}

// ── Página del link (para el que todavía no tiene la app) ────────────────

let urlAppStore = null;
async function linkAppStore() {
  if (urlAppStore) return urlAppStore;
  try {
    const r = await fetch("https://itunes.apple.com/lookup?bundleId=Lavaworks.Flight-Center&country=ar");
    const j = await r.json();
    urlAppStore = j.results?.[0]?.trackViewUrl || null;
  } catch {}
  return urlAppStore || "https://apps.apple.com/ar/search?term=Oscar%20aviaci%C3%B3n";
}

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pagina(d, appStore) {
  const titulo = d ? `${escapar(d.retador)} te desafió en Oscar` : "Duelo de Oscar";
  const detalle = d
    ? `${PREGUNTAS} preguntas de aviación, las mismas para los dos. ¿Quién acierta más?`
    : "Este duelo no existe o ya venció.";
  const codigo = d ? escapar(d.codigo) : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title>
<meta property="og:title" content="${titulo}">
<meta property="og:description" content="${escapar(detalle)}">
<style>
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0B1420;color:#F2F4F7;
display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}
.c{max-width:420px;padding:32px}
h1{font-size:26px;margin:.2em 0}.d{color:#9AA5B4;font-size:16px}
.cod{font:800 34px ui-monospace,monospace;letter-spacing:6px;margin:22px 0;padding:14px;border-radius:14px;background:#161F2B}
a.b{display:block;margin:12px 0;padding:15px;border-radius:14px;background:#2B86FF;color:#fff;
font-weight:800;text-decoration:none;box-shadow:0 4px 0 #1a5cb3}
a.s{background:#161F2B;box-shadow:0 4px 0 #0a0f16}
</style></head><body><div class="c">
<div style="font-size:52px">✈️</div>
<h1>${titulo}</h1><p class="d">${escapar(detalle)}</p>
${d ? `<div class="cod">${codigo}</div>
<a class="b" href="oscar://duelo/${codigo}">Abrir en Oscar</a>
<p class="d">¿No tenés Oscar? Bajala y en Academia › Práctica › Duelo poné el código.</p>` : ""}
<a class="b s" href="${escapar(appStore)}">App Store</a>
<a class="b s" href="https://play.google.com/store/apps/details?id=ar.lavaworks.oscar">Google Play</a>
</div></body></html>`;
}

// ── Rutas ─────────────────────────────────────────────────────────────────

export function montar(app) {
  // Crear un duelo: el retador ya jugó y manda su resultado.
  app.post("/duelos", async (req, res) => {
    try {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
      if (!permitido(ip)) return res.status(429).json({ error: "Demasiados duelos seguidos. Probá en un rato." });
      const b = req.body || {};
      const preguntas = Array.isArray(b.preguntas)
        ? b.preguntas.map((x) => entero(x, 1, 1_000_000)).filter((x) => x != null) : [];
      // El resultado del retador es opcional: la app nueva crea sin jugar
      // (y lo manda después a /retador); la del 2026-10-06 lo manda acá.
      const conResultado = b.aciertos != null;
      const aciertos = conResultado ? entero(b.aciertos, 0, PREGUNTAS) : null;
      const segs = conResultado ? segundos(b.segundos) : null;
      if (preguntas.length !== PREGUNTAS || new Set(preguntas).size !== PREGUNTAS
          || (conResultado && (aciertos == null || segs == null))) {
        return res.status(400).json({ error: "Duelo inválido" });
      }
      const clave = crypto.randomBytes(12).toString("hex");
      const d = {
        codigo: nuevoCodigo(), preguntas, retador: limpiarNombre(b.nombre),
        r_aciertos: aciertos, r_segundos: segs, r_clave: clave, rival: null,
        v_aciertos: null, v_segundos: null, creado: new Date()
      };
      const db = await asegurarPool();
      if (db) {
        await db.query(
          `INSERT INTO duelos (codigo, preguntas, retador, r_aciertos, r_segundos, r_clave)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [d.codigo, d.preguntas, d.retador, d.r_aciertos, d.r_segundos, clave]);
      } else {
        memoria.set(d.codigo, d);
      }
      // La clave va SÓLO en esta respuesta: es lo que le permite al retador
      // cargar su resultado después.
      res.json({ ...publico(d), clave, link: `https://notam-api.onrender.com/duelo/${d.codigo}` });
    } catch (e) {
      console.error("[duelos] crear:", e.message);
      res.status(500).json({ error: "No se pudo crear el duelo" });
    }
  });

  // Ver un duelo (para jugarlo, o para ver si el amigo ya respondió).
  app.get("/duelos/:codigo", async (req, res) => {
    try {
      const d = await buscar(String(req.params.codigo).toUpperCase());
      if (!d) return res.status(404).json({ error: "No existe ese duelo" });
      res.json(publico(d));
    } catch (e) {
      console.error("[duelos] ver:", e.message);
      res.status(500).json({ error: "No se pudo leer el duelo" });
    }
  });

  // El retador manda su resultado (después de compartir). Una sola vez.
  app.post("/duelos/:codigo/retador", async (req, res) => {
    try {
      const codigo = String(req.params.codigo).toUpperCase();
      const b = req.body || {};
      const aciertos = entero(b.aciertos, 0, PREGUNTAS);
      const segs = segundos(b.segundos);
      const clave = String(b.clave || "");
      if (aciertos == null || segs == null || !clave) return res.status(400).json({ error: "Resultado inválido" });
      const db = await asegurarPool();
      let d;
      if (db) {
        const r = await db.query(
          `UPDATE duelos SET r_aciertos = $3, r_segundos = $4
           WHERE codigo = $1 AND r_clave = $2 AND r_aciertos IS NULL
           RETURNING *`, [codigo, clave, aciertos, segs]);
        d = r.rows[0];
        if (!d) {
          const existe = await buscar(codigo);
          if (!existe) return res.status(404).json({ error: "No existe ese duelo" });
          if (existe.r_clave !== clave) return res.status(403).json({ error: "Este duelo no es tuyo" });
          return res.status(409).json({ error: "Ya jugaste este duelo", duelo: publico(existe) });
        }
      } else {
        d = memoria.get(codigo);
        if (!d) return res.status(404).json({ error: "No existe ese duelo" });
        if (d.r_clave !== clave) return res.status(403).json({ error: "Este duelo no es tuyo" });
        if (d.r_aciertos != null) return res.status(409).json({ error: "Ya jugaste este duelo", duelo: publico(d) });
        Object.assign(d, { r_aciertos: aciertos, r_segundos: segs });
      }
      res.json(publico(d));
    } catch (e) {
      console.error("[duelos] retador:", e.message);
      res.status(500).json({ error: "No se pudo guardar el resultado" });
    }
  });

  // El rival manda su resultado. Una sola vez por duelo.
  app.post("/duelos/:codigo/responder", async (req, res) => {
    try {
      const codigo = String(req.params.codigo).toUpperCase();
      const b = req.body || {};
      const aciertos = entero(b.aciertos, 0, PREGUNTAS);
      const segs = segundos(b.segundos);
      if (aciertos == null || segs == null) return res.status(400).json({ error: "Resultado inválido" });
      const nombre = limpiarNombre(b.nombre);
      const db = await asegurarPool();
      let d;
      if (db) {
        // El WHERE rival IS NULL hace que sólo el primero que responda quede.
        const r = await db.query(
          `UPDATE duelos SET rival = $2, v_aciertos = $3, v_segundos = $4, respondido = NOW()
           WHERE codigo = $1 AND rival IS NULL
             AND creado > NOW() - INTERVAL '${VENCE_DIAS} days'
           RETURNING *`, [codigo, nombre, aciertos, segs]);
        d = r.rows[0];
        if (!d) {
          const existe = await buscar(codigo);
          if (!existe) return res.status(404).json({ error: "No existe ese duelo" });
          return res.status(409).json({ error: "Este duelo ya se jugó", duelo: publico(existe) });
        }
      } else {
        d = memoria.get(codigo);
        if (!d) return res.status(404).json({ error: "No existe ese duelo" });
        if (d.rival != null) return res.status(409).json({ error: "Este duelo ya se jugó", duelo: publico(d) });
        Object.assign(d, { rival: nombre, v_aciertos: aciertos, v_segundos: segs });
      }
      res.json(publico(d));
    } catch (e) {
      console.error("[duelos] responder:", e.message);
      res.status(500).json({ error: "No se pudo guardar el resultado" });
    }
  });

  // La página que se abre desde el link compartido.
  app.get("/duelo/:codigo", async (req, res) => {
    let d = null;
    try { d = await buscar(String(req.params.codigo).toUpperCase()); } catch {}
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(pagina(d, await linkAppStore()));
  });
}
