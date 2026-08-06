// alertas.js — vigilancia de aeródromos y push a los dispositivos
//
// Se separa del scraper a propósito: server.js se ocupa de traer datos de
// ANAC, este módulo de decidir a quién avisarle y mandarlo.
//
// Variables de entorno que necesita:
//   DATABASE_URL   Postgres de Render (Internal URL)
//   APNS_KEY_P8    contenido del .p8 de Apple, con los saltos de línea
//                  como \n literales (Render no acepta multilínea)
//   APNS_KEY_ID    Key ID de esa clave
//   APNS_TEAM_ID   Team ID de la cuenta de desarrollador
//   APNS_TOPIC     bundle id — Lavaworks.Flight-Center
//   APNS_ENV       "prod" o "sandbox" (default prod)

import pg from "pg";
import jwt from "jsonwebtoken";
import http2 from "node:http2";

const { Pool } = pg;
let pool = null;

// ── Base ─────────────────────────────────────────────────────────────────

export async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("[alertas] sin DATABASE_URL — la vigilancia queda desactivada");
    return false;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Una fila por (dispositivo, aeródromo). Las reglas se guardan por
  // dispositivo, repetidas en cada fila: son cuatro enteros, no vale la
  // pena una tabla aparte y así una sola consulta trae todo lo necesario.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suscripciones (
      token         TEXT NOT NULL,
      icao          TEXT NOT NULL,
      indicador     TEXT NOT NULL,
      vence         TIMESTAMPTZ NOT NULL,
      viento_kt     INT  NOT NULL DEFAULT 20,
      rafaga_kt     INT  NOT NULL DEFAULT 25,
      visibilidad_m INT  NOT NULL DEFAULT 5000,
      techo_ft      INT  NOT NULL DEFAULT 1500,
      tormenta      BOOLEAN NOT NULL DEFAULT TRUE,
      mejoras       BOOLEAN NOT NULL DEFAULT TRUE,
      ultimo_push   TIMESTAMPTZ,
      PRIMARY KEY (token, icao)
    );
  `);

  // Último estado conocido por aeródromo, compartido por todos los
  // dispositivos: el clima y los NOTAM son los mismos para todos.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estado_aerodromo (
      icao          TEXT PRIMARY KEY,
      metar_raw     TEXT,
      metar_ts      TIMESTAMPTZ,
      notams        TEXT[],
      notams_ts     TIMESTAMPTZ
    );
  `);

  console.log("[alertas] base lista");
  return true;
}

export function activo() { return pool !== null; }

// ── Suscripciones ────────────────────────────────────────────────────────

export async function guardarSuscripcion({ token, aerodromos, reglas }) {
  if (!pool) throw new Error("sin base");
  const r = reglas || {};
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    // Se reemplaza la suscripción completa del dispositivo: la app manda
    // siempre su lista entera, así que lo que no viene es porque se dio
    // de baja.
    await cliente.query("DELETE FROM suscripciones WHERE token = $1", [token]);
    for (const a of aerodromos || []) {
      if (!a.icao || !a.indicador) continue;
      await cliente.query(
        `INSERT INTO suscripciones
           (token, icao, indicador, vence, viento_kt, rafaga_kt,
            visibilidad_m, techo_ft, tormenta, mejoras)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [token, a.icao.toUpperCase(), a.indicador.toUpperCase(), a.vence,
         r.vientoKt ?? 20, r.rafagaKt ?? 25, r.visibilidadM ?? 5000,
         r.techoFt ?? 1500, r.tormenta ?? true, r.mejoras ?? true]
      );
    }
    await cliente.query("COMMIT");
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
}

/// Suscripciones vigentes. Las vencidas se borran solas acá, que es el
/// único lugar donde hace falta mirarlas.
export async function suscripcionesVigentes() {
  if (!pool) return [];
  await pool.query("DELETE FROM suscripciones WHERE vence < NOW()");
  const { rows } = await pool.query("SELECT * FROM suscripciones");
  return rows;
}

export async function contarSuscripciones() {
  if (!pool) return { dispositivos: 0, aerodromos: 0 };
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT token)::int AS dispositivos,
            COUNT(DISTINCT icao)::int  AS aerodromos
     FROM suscripciones WHERE vence >= NOW()`
  );
  return rows[0];
}

// ── Estado anterior ──────────────────────────────────────────────────────

export async function estadoDe(icao) {
  if (!pool) return null;
  const { rows } = await pool.query(
    "SELECT * FROM estado_aerodromo WHERE icao = $1", [icao]);
  return rows[0] || null;
}

export async function guardarMetar(icao, raw) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO estado_aerodromo (icao, metar_raw, metar_ts)
     VALUES ($1,$2,NOW())
     ON CONFLICT (icao) DO UPDATE SET metar_raw = $2, metar_ts = NOW()`,
    [icao, raw]);
}

export async function guardarNotams(icao, numeros) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO estado_aerodromo (icao, notams, notams_ts)
     VALUES ($1,$2,NOW())
     ON CONFLICT (icao) DO UPDATE SET notams = $2, notams_ts = NOW()`,
    [icao, numeros]);
}

// ── METAR: parseo y cruces de umbral ─────────────────────────────────────
//
// Porteado tal cual del cliente (AerodromeWatch.swift) para que las dos
// puntas coincidan. La regla de fondo: se alerta por CRUCE de umbral, no
// por diferencia. El viento de 8 a 14 kt no genera nada; de 16 a 24 sí.
// Sin esto son decenas de notificaciones por día y el usuario las apaga.

export function parseMetar(raw) {
  const s = { viento: 0, rafaga: 0, vis: 10000, techo: null, tormenta: false };
  if (!raw) return s;
  let vientoLeido = false, visLeida = false;

  for (const t of raw.toUpperCase().split(/\s+/).filter(Boolean)) {
    if (!vientoLeido && t.endsWith("KT") && t.length >= 7) {
      const cuerpo = t.slice(0, -2);
      const dir = cuerpo.slice(0, 3);
      if (dir === "VRB" || /^\d{3}$/.test(dir)) {
        const kt = parseInt(cuerpo.slice(3, 5), 10);
        if (!isNaN(kt)) { s.viento = kt; vientoLeido = true; }
        const g = cuerpo.match(/G(\d{2,3})/);
        if (g) s.rafaga = parseInt(g[1], 10);
      }
      continue;
    }
    if (t === "CAVOK") { s.vis = 10000; visLeida = true; continue; }
    if (!visLeida && /^\d{4}$/.test(t)) {
      s.vis = Math.min(parseInt(t, 10), 10000); visLeida = true; continue;
    }
    if ((t.startsWith("BKN") || t.startsWith("OVC")) && t.length >= 6) {
      const h = t.slice(3, 6);
      if (/^\d{3}$/.test(h)) {
        const ft = parseInt(h, 10) * 100;
        s.techo = s.techo === null ? ft : Math.min(s.techo, ft);
      }
      continue;
    }
    if (t.includes("TS") && !t.startsWith("BKN") && !t.startsWith("OVC")) {
      s.tormenta = true;
    }
  }
  return s;
}

export function cambiosMetar(antes, ahora, reglas) {
  const out = [];
  const evaluar = (a, b, umbral, menorEsPeor, textoMal, textoBien) => {
    const malA = menorEsPeor ? a < umbral : a > umbral;
    const malB = menorEsPeor ? b < umbral : b > umbral;
    if (malA === malB) return;
    if (!malB && !reglas.mejoras) return;
    out.push({ texto: malB ? textoMal : textoBien, empeora: malB });
  };

  evaluar(antes.viento, ahora.viento, reglas.viento_kt, false,
    `Viento ${ahora.viento} kt, sobre tu límite de ${reglas.viento_kt}`,
    `El viento bajó a ${ahora.viento} kt`);

  evaluar(antes.rafaga, ahora.rafaga, reglas.rafaga_kt, false,
    `Ráfagas de ${ahora.rafaga} kt`, "Ya no hay ráfagas fuertes");

  evaluar(antes.vis, ahora.vis, reglas.visibilidad_m, true,
    `Visibilidad ${ahora.vis} m`, "La visibilidad mejoró");

  // Sin techo se toma un valor altísimo, así "apareció techo bajo" cuenta
  // como cruce.
  evaluar(antes.techo ?? 99000, ahora.techo ?? 99000, reglas.techo_ft, true,
    `Techo en ${ahora.techo} ft`, "El techo levantó");

  if (reglas.tormenta && antes.tormenta !== ahora.tormenta) {
    out.push(ahora.tormenta
      ? { texto: "Tormenta reportada", empeora: true }
      : { texto: "Pasó la tormenta", empeora: false });
  }
  return reglas.mejoras ? out : out.filter(c => c.empeora);
}

// ── APNs ─────────────────────────────────────────────────────────────────

let tokenJWT = null, tokenJWTts = 0;

function bearerAPNs() {
  // Apple rechaza tokens de más de 1 hora y también que se regeneren muy
  // seguido: se reusa 50 minutos.
  const ahora = Date.now();
  if (tokenJWT && ahora - tokenJWTts < 50 * 60 * 1000) return tokenJWT;
  const clave = (process.env.APNS_KEY_P8 || "").replace(/\\n/g, "\n");
  if (!clave) throw new Error("falta APNS_KEY_P8");
  tokenJWT = jwt.sign({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(ahora / 1000) },
    clave, { algorithm: "ES256", header: { alg: "ES256", kid: process.env.APNS_KEY_ID } });
  tokenJWTts = ahora;
  return tokenJWT;
}

export function apnsConfigurado() {
  return !!(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID &&
            process.env.APNS_TEAM_ID && process.env.APNS_TOPIC);
}

export function enviarPush(deviceToken, titulo, cuerpo, urgente = true) {
  return new Promise((resolve) => {
    if (!apnsConfigurado()) return resolve({ ok: false, motivo: "APNs sin configurar" });

    const host = process.env.APNS_ENV === "sandbox"
      ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    const cliente = http2.connect(host);
    cliente.on("error", () => resolve({ ok: false, motivo: "conexión" }));

    const payload = JSON.stringify({
      aps: {
        alert: { title: titulo, body: cuerpo },
        sound: urgente ? "default" : undefined,
        "interruption-level": urgente ? "time-sensitive" : "passive"
      }
    });

    const req = cliente.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      "authorization": `bearer ${bearerAPNs()}`,
      "apns-topic": process.env.APNS_TOPIC,
      "apns-push-type": "alert",
      // Prioridad 5 y sin sonido para las mejoras: no vale despertar a
      // nadie de madrugada para decirle que levantó el techo.
      "apns-priority": urgente ? "10" : "5",
      "content-type": "application/json"
    });

    let status = 0, cuerpoResp = "";
    req.on("response", h => { status = h[":status"]; });
    req.on("data", d => { cuerpoResp += d; });
    req.on("end", () => {
      cliente.close();
      resolve({ ok: status === 200, status, detalle: cuerpoResp });
    });
    req.on("error", () => { cliente.close(); resolve({ ok: false, motivo: "request" }); });
    req.end(payload);
  });
}

/// Baja el dispositivo si Apple dice que el token ya no sirve. Sin esto la
/// tabla se llena de tokens muertos de apps desinstaladas.
export async function borrarToken(token) {
  if (!pool) return;
  await pool.query("DELETE FROM suscripciones WHERE token = $1", [token]);
}

/// Sella el momento del último aviso, para respetar el techo de uno cada
/// 30 minutos por aeródromo y dispositivo.
export async function marcarPush(token, icao) {
  if (!pool) return;
  await pool.query(
    "UPDATE suscripciones SET ultimo_push = NOW() WHERE token = $1 AND icao = $2",
    [token, icao]);
}
