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

  // Columnas para los NOTAM de FIR (v5, 2026-08-09). Se agregan aparte para
  // no romper las suscripciones ya guardadas.
  // `estacion` (2026-08-15): de qué aeródromo sale el METAR que le
  // corresponde a éste. Los campos chicos —Luján, Lobos, Saladillo— no
  // publican METAR propio: sin esto la vigilancia de clima sólo podía
  // funcionar en los ~30 que tienen estación, y activar la campanita en
  // Luján no avisaba nunca nada.
  for (const col of ["lat DOUBLE PRECISION", "lon DOUBLE PRECISION", "fir TEXT",
                     "estacion TEXT", "nombre TEXT"]) {
    await pool.query(`ALTER TABLE suscripciones ADD COLUMN IF NOT EXISTS ${col};`);
  }

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
            visibilidad_m, techo_ft, tormenta, mejoras, lat, lon, fir,
            estacion, nombre)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [token, a.icao.toUpperCase(), a.indicador.toUpperCase(), a.vence,
         r.vientoKt ?? 20, r.rafagaKt ?? 25, r.visibilidadM ?? 5000,
         r.techoFt ?? 1500, r.tormenta ?? true, r.mejoras ?? true,
         // Coordenadas y FIR para poder decidir si un aviso de FIR toca
         // este aeródromo. Si la app no las manda (versión vieja), los
         // NOTAM de FIR simplemente no se evalúan para él.
         a.lat ?? null, a.lon ?? null,
         a.fir ? String(a.fir).toUpperCase() : null,
         // Si la app no manda estación (versión vieja) se usa el propio
         // ICAO, que es el comportamiento anterior.
         a.estacion ? String(a.estacion).toUpperCase() : null,
         // El título del push: "SRDL" no se lee como Luján.
         a.nombre ? String(a.nombre) : null]
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

/// Cómo se escribe una visibilidad para que se entienda.
///
/// El corte va en 9999 y no en 10000: en un METAR "9999" ES el código de
/// "10 km o más" — nadie reporta 10000. Con el corte en 10000 el aviso decía
/// "9999 m", que además de feo invita a compararlo con el mínimo como si fuera
/// una medición, cuando en realidad significa "todo bien".
function fmtVis(m) {
  return m >= 9999 ? "10 km o más" : `${m} m`;
}

/**
 * QUÉ TIENE QUE DECIR UNA NOTIFICACIÓN DE CLIMA
 * ---------------------------------------------
 * Antes decía "Visibilidad 4000 m" y ya. Con eso el piloto no puede decidir
 * nada: no sabe si mejoró o empeoró, ni de cuánto venía, ni si 4000 está bien
 * o mal para él. Termina abriendo la app para enterarse de algo que la
 * notificación podría haber dicho — y si está manejando o en la escuela, no la
 * abre y se queda sin saber.
 *
 * Ahora cada aviso lleva las tres cosas que hacen falta para decidir sin abrir
 * nada:
 *
 *   1. QUÉ PASÓ, con un verbo: "bajó", "mejoró", "levantó". El sentido del
 *      cambio es lo primero que se lee y lo que más importa.
 *   2. DE CUÁNTO A CUÁNTO: "10 km o más → 4000 m". Un número solo no dice si
 *      es un desplome o un ajuste menor.
 *   3. CONTRA QUÉ: "tu mínimo, 5000 m". El umbral es de cada piloto, así que
 *      el mismo 4000 es grave para uno e indiferente para otro. Repetirlo es
 *      lo que convierte el dato en una decisión.
 *
 * OJO: este texto tiene que ser IDÉNTICO al de `MetarChangeDetector.cambios`
 * en `AerodromeWatch.swift`. La app muestra el mismo cambio en pantalla y el
 * backend lo manda por push; si difieren, el piloto ve dos versiones de lo
 * mismo y deja de confiar en las dos.
 */
export function cambiosMetar(antes, ahora, reglas) {
  const out = [];
  // `arma` recibe si el estado nuevo es malo y devuelve el texto. Antes se le
  // pasaban dos strings ya armados; ahora hace falta la función porque el
  // texto depende de los dos valores y no sólo del nuevo.
  const evaluar = (a, b, umbral, menorEsPeor, arma) => {
    const malA = menorEsPeor ? a < umbral : a > umbral;
    const malB = menorEsPeor ? b < umbral : b > umbral;
    if (malA === malB) return;
    if (!malB && !reglas.mejoras) return;
    out.push({ texto: arma(malB), empeora: malB });
  };

  evaluar(antes.viento, ahora.viento, reglas.viento_kt, false, mala =>
    mala
      ? `Viento subió: ${antes.viento} → ${ahora.viento} kt (tu límite, ${reglas.viento_kt})`
      : `Viento bajó: ${antes.viento} → ${ahora.viento} kt (tu límite, ${reglas.viento_kt})`);

  evaluar(antes.rafaga, ahora.rafaga, reglas.rafaga_kt, false, mala => {
    // Igual que con el techo: cuando el valor de antes es 0 no hubo un cambio
    // de intensidad, aparecieron. "Ráfagas: 0 → 34 kt" no es lo que pasó.
    if (mala) {
      return antes.rafaga === 0
        ? `Aparecieron ráfagas de ${ahora.rafaga} kt (tu límite, ${reglas.rafaga_kt})`
        : `Ráfagas: ${antes.rafaga} → ${ahora.rafaga} kt (tu límite, ${reglas.rafaga_kt})`;
    }
    // Sin ráfaga reportada el valor es 0, y "bajaron a 0 kt" se lee raro:
    // lo que pasó es que dejaron de reportarse.
    return ahora.rafaga === 0
      ? `Ya no se reportan ráfagas (eran de ${antes.rafaga} kt)`
      : `Ráfagas bajaron: ${antes.rafaga} → ${ahora.rafaga} kt (tu límite, ${reglas.rafaga_kt})`;
  });

  evaluar(antes.vis, ahora.vis, reglas.visibilidad_m, true, mala =>
    mala
      ? `Visibilidad bajó: ${fmtVis(antes.vis)} → ${fmtVis(ahora.vis)} (tu mínimo, ${reglas.visibilidad_m} m)`
      : `Visibilidad mejoró: ${fmtVis(antes.vis)} → ${fmtVis(ahora.vis)} (tu mínimo, ${reglas.visibilidad_m} m)`);

  // Sin techo se toma un valor altísimo, así "apareció techo bajo" cuenta
  // como cruce.
  evaluar(antes.techo ?? 99000, ahora.techo ?? 99000, reglas.techo_ft, true, mala => {
    // El techo es el único que puede no existir, y "de sin techo a 800 ft" se
    // lee mal. Cuando aparece o desaparece, se dice eso mismo.
    if (mala) {
      return antes.techo == null
        ? `Apareció techo: ${ahora.techo} ft (tu mínimo, ${reglas.techo_ft} ft)`
        : `Techo bajó: ${antes.techo} → ${ahora.techo} ft (tu mínimo, ${reglas.techo_ft} ft)`;
    }
    return ahora.techo == null
      ? `Se despejó el techo (era de ${antes.techo} ft)`
      : `Techo levantó: ${antes.techo} → ${ahora.techo} ft (tu mínimo, ${reglas.techo_ft} ft)`;
  });

  if (reglas.tormenta && antes.tormenta !== ahora.tormenta) {
    out.push(ahora.tormenta
      ? { texto: "Tormenta reportada en el METAR", empeora: true }
      : { texto: "Ya no se reporta tormenta", empeora: false });
  }
  return reglas.mejoras ? out : out.filter(c => c.empeora);
}

// ── NOTAM de FIR: ¿me afecta a mí? ────────────────────────────────────────
//
// ANAC publica bajo la FIR (indicador "-EF" para Ezeiza) avisos que no
// figuran bajo el aeródromo pero que igual lo tocan: paracaidismo, vuelos
// no tripulados, áreas restringidas temporarias, ejercicios. El caso que lo
// destapó (2026-08-09): no había NOTAM para Morón pero sí uno de FIR Ezeiza
// que lo afectaba.
//
// El problema es el volumen: la FIR Ezeiza tiene 41 avisos activos y casi
// todos son de lugares lejanos. Avisarlos todos sería ruido puro. Por eso
// se filtra por geografía: la mayoría del texto trae las coordenadas del
// lugar y muchas veces el radio.

const RADIO_FIR_NM = 25;

/// Extrae la primera coordenada del texto de un NOTAM.
/// Formato de ANAC: "COORD GEO 344436S/0583912W", a veces sin el "COORD GEO"
/// y con separaciones distintas. Devuelve null si no hay ninguna.
export function coordenadaDeNotam(texto) {
  if (!texto) return null;
  const m = /(\d{2})(\d{2})(\d{2})(?:[.,]\d+)?\s*([NS])\s*\/?\s*(\d{3})(\d{2})(\d{2})(?:[.,]\d+)?\s*([EW])/
    .exec(texto.toUpperCase());
  if (!m) return null;
  const lat = (+m[1] + m[2] / 60 + m[3] / 3600) * (m[4] === "S" ? -1 : 1);
  const lon = (+m[5] + m[6] / 60 + m[7] / 3600) * (m[8] === "W" ? -1 : 1);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/// Radio declarado en el texto ("RDO 2NM"), o 0 si no dice.
export function radioDeNotam(texto) {
  const m = /RDO\s*(\d{1,3})\s*NM/i.exec(texto || "");
  return m ? +m[1] : 0;
}

export function distanciaNM(a, b) {
  const R = 3440.065, p = Math.PI / 180;
  const c = Math.sin(a.lat * p) * Math.sin(b.lat * p)
          + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.cos((b.lon - a.lon) * p);
  return R * Math.acos(Math.min(1, Math.max(-1, c)));
}

/// ¿Este NOTAM de FIR le importa a un aeródromo en (lat, lon)?
///
/// Devuelve { afecta, motivo }. Cuando NO hay coordenadas se responde que sí
/// con motivo "sin_coordenadas": no se puede saber si toca o no, y callarlo
/// sería decidir por el piloto. Como sólo se avisa de NOTAM NUEVOS, son uno
/// o dos por semana, no siete por día.
export function notamFirAfecta(texto, aero, radioNM = RADIO_FIR_NM) {
  const c = coordenadaDeNotam(texto);
  if (!c) return { afecta: true, motivo: "sin_coordenadas" };
  const d = distanciaNM(c, aero) - radioDeNotam(texto);
  return d <= radioNM
    ? { afecta: true, motivo: "cerca", distNM: Math.max(0, Math.round(d)) }
    : { afecta: false };
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

/// Manda el push y, si Apple rechaza el token por venir del otro entorno,
/// reintenta una vez contra el que corresponde.
///
/// POR QUÉ (2026-08-09): un build de Xcode registra token de SANDBOX y uno
/// del App Store de PRODUCCIÓN. Con un solo entorno configurado, uno de los
/// dos siempre falla con `BadDeviceToken`. Antes había que ir a Render a
/// cambiar `APNS_ENV` para probar desde Xcode —y acordarse de volverlo a
/// `prod` antes de publicar, que es un olvido carísimo: dejaría a todos los
/// usuarios reales sin notificaciones sin que nadie se entere.
///
/// Con el reintento, los dos tipos de build funcionan siempre y la variable
/// deja de ser una trampa.
export function enviarPush(deviceToken, titulo, cuerpo, urgente = true) {
  return enviarA(hostPreferido(), deviceToken, titulo, cuerpo, urgente)
    .then(r => {
      const rechazoDeEntorno =
        r.status === 400 && /BadDeviceToken/i.test(r.detalle || "");
      if (!rechazoDeEntorno) return r;
      return enviarA(hostAlternativo(), deviceToken, titulo, cuerpo, urgente)
        .then(r2 => r2.ok ? { ...r2, entornoAlternativo: true } : r);
    });
}

function hostPreferido() {
  return process.env.APNS_ENV === "sandbox"
    ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}
function hostAlternativo() {
  return process.env.APNS_ENV === "sandbox"
    ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
}

function enviarA(host, deviceToken, titulo, cuerpo, urgente) {
  return new Promise((resolve) => {
    if (!apnsConfigurado()) return resolve({ ok: false, motivo: "APNs sin configurar" });
    const cliente = http2.connect(host);
    cliente.on("error", () => resolve({ ok: false, motivo: "conexión" }));

    const payload = JSON.stringify({
      aps: {
        alert: { title: titulo, body: cuerpo },
        sound: urgente ? "default" : undefined,
        // "passive" no muestra banner ni aparece en la pantalla bloqueada:
        // queda enterrado en el centro de notificaciones y el piloto no se
        // entera nunca. Para las mejoras alcanza con "active", que se ve
        // pero no suena — no hace falta despertar a nadie para avisarle
        // que levantó el techo, pero tampoco esconderlo.
        "interruption-level": urgente ? "time-sensitive" : "active"
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
