// notam-api — server.js
//
// v4 (2026-08-06): se suma la vigilancia de aeródromos (alertas.js).
// v3 (2026-08-06): la lista de lugares se lee de ANAC, ya no está hardcodeada.
//
// EL PROBLEMA QUE ARREGLA LA v3
// -----------------------------
// La v2 tenía 61 indicadores fijos en el código y trataba cualquier fallo
// como error, conservando el dato viejo. Eso producía dos bugs serios:
//
//  1. ANAC dice, textual, en su página: "El control de selección muestra
//     únicamente lugares que registran notams activos. Los lugares sin
//     novedades activas no se incluyen en la lista." O sea que pedir un
//     lugar sin novedades NO es un error: es la respuesta "no hay nada".
//     La v2 lo contaba como fallo, se quedaba con el NOTAM anterior y lo
//     servía como si siguiera vigente. Al momento de detectarlo había
//     datos de 13 días presentados como actuales.
//
//  2. Al revés: ANAC publicaba 77 lugares con novedades activas y la app
//     sólo consultaba 61. Faltaban 33, casi todos de aviación general
//     —Saladillo, Las Flores, Pehuajó, Punta Indio, San Pedro, Balcarce—
//     y para esos la app respondía "sin NOTAM" habiendo NOTAM.
//
// LA SOLUCIÓN
// -----------
// Cada pasada se lee primero el selector de ANAC, que es la lista
// autoritativa del momento. De ahí salen tres estados posibles y bien
// distintos:
//
//   · está en la lista y se pudo scrapear  → NOTAMs
//   · NO está en la lista                  → sin novedades activas (count 0)
//   · está en la lista pero falló          → dato viejo, marcado stale
//
// El segundo caso es el que antes se confundía con el tercero.
//
// LO QUE SUMA LA v4
// -----------------
// Después de cada pasada del scraper se revisa si algo cambió en los
// aeródromos que alguien está vigilando, y si corresponde se manda un push.
// Todo eso vive en alertas.js; acá sólo está el enganche. Si no hay base de
// datos configurada, la vigilancia queda apagada y el resto sigue igual.

import express from "express";
import * as cheerio from "cheerio";
import * as alertas from "./alertas.js";

const app = express();
app.use(express.json({ limit: "64kb" }));

const PORT = process.env.PORT || 3000;

const REFRESH_PAUSE_MS = 5 * 60 * 1000; // pausa entre pasadas completas
const DELAY_BETWEEN_MS = 1500;          // ANAC devuelve 500 si se le pega seguido
const LIST_URL = "https://ais.anac.gob.ar/notam";
const PIB_URL  = "https://ais.anac.gob.ar/notam/pib";

// ── Estado en memoria ────────────────────────────────────────────────────
// indicador → { data, timestamp }
const cache = new Map();
// indicador → mensaje del último error real de scrapeo
const scrapeErrors = new Map();
// Lista viva de ANAC: indicador → nombre. Se refresca en cada pasada.
let locations = new Map();
let locationsUpdatedAt = null;
const startedAt = Date.now();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Lista de lugares con novedades activas ───────────────────────────────

async function fetchLocations() {
  const res = await fetch(LIST_URL, {
    headers: { "User-Agent": "NotamApi/4.0" }
  });
  if (!res.ok) throw new Error(`ANAC lista respondió ${res.status}`);

  const $ = cheerio.load(await res.text());
  const found = new Map();
  $("select option").each((_, o) => {
    const value = ($(o).attr("value") || "").trim();
    const text = $(o).text().replace(/\s+/g, " ").trim();
    // La primera opción es el placeholder "Seleccione un lugar".
    if (value && value !== "Seleccione un lugar") found.set(value, text);
  });
  if (found.size === 0) throw new Error("no se encontró ninguna opción en el selector");
  return found;
}

// Si la lista falla, se CONSERVA la anterior. Quedarse sin lista sería peor
// que tenerla algo vieja: dejaría de scrapearse todo.
async function refreshLocations() {
  try {
    locations = await fetchLocations();
    locationsUpdatedAt = Date.now();
    console.log(`[locations] ${locations.size} lugares con novedades activas`);
  } catch (e) {
    console.error(`[locations] falló, se conserva la lista anterior: ${e.message}`);
  }
}

// ── Parser ───────────────────────────────────────────────────────────────

function parseNotamHtml(html) {
  const $ = cheerio.load(html);
  const notams = [];

  $("#pibdata tr").each((_, row) => {
    const place = $(row).find("td#place p")
      .map((_, p) => $(p).text().trim()).get().filter(Boolean);
    const info = $(row).find("td#info p")
      .map((_, p) => $(p).text().trim()).get().filter(Boolean);

    const numero = place[0] || null;
    const lugar = place[1] || null;
    const indicador = place[2]?.replace(/[()]/g, "") || null;
    const desde = info.find(t => t.startsWith("Desde:"))?.replace("Desde:", "").trim() || null;
    const hasta = info.find(t => t.startsWith("Hasta:"))?.replace("Hasta:", "").trim() || null;
    const texto = info
      .filter(t => !t.startsWith("Desde:") && !t.startsWith("Hasta:"))
      .join(" ").trim();

    if (numero || texto) notams.push({ numero, lugar, indicador, desde, hasta, texto });
  });

  return notams;
}

// ── Scraper ──────────────────────────────────────────────────────────────

async function scrapeNotams(indicador) {
  const response = await fetch(PIB_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": LIST_URL,
      "User-Agent": "NotamApi/4.0"
    },
    body: new URLSearchParams({ indicador })
  });
  if (!response.ok) throw new Error(`ANAC respondió con status ${response.status}`);

  const notams = parseNotamHtml(await response.text());
  return {
    source: "ANAC AIS",
    indicador,
    nombre: locations.get(indicador) || null,
    retrieved_at: new Date().toISOString(),
    count: notams.length,
    notams,
    warning: "Información de referencia. No reemplaza briefing oficial ARO-AIS."
  };
}

async function refreshOne(indicador) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      cache.set(indicador, { data: await scrapeNotams(indicador), timestamp: Date.now() });
      scrapeErrors.delete(indicador);
      return;
    } catch (error) {
      if (attempt === 2) {
        scrapeErrors.set(indicador, error.message);
        console.error(`[refresher] ${indicador}: ${error.message}`);
      } else {
        await sleep(5000);
      }
    }
  }
}

// ── METAR para la vigilancia ─────────────────────────────────────────────
//
// El scraper de NOTAM no toca el clima; la vigilancia sí lo necesita. Se
// pide en bloque a aviationweather.gov, la misma fuente que usa la app, y
// sólo para los aeródromos que alguien está vigilando: no tiene sentido
// traer los 693.

async function fetchMetars(icaos) {
  if (icaos.length === 0) return new Map();
  const url = "https://aviationweather.gov/api/data/metar?format=raw&ids="
            + icaos.join(",");
  const out = new Map();
  try {
    const r = await fetch(url, { headers: { "User-Agent": "NotamApi/4.0" } });
    if (!r.ok) throw new Error(`aviationweather respondió ${r.status}`);
    for (const linea of (await r.text()).split("\n")) {
      const l = linea.trim();
      if (!l) continue;
      const icao = l.split(/\s+/)[0];
      if (icao && icao.length === 4) out.set(icao, l);
    }
  } catch (e) {
    // Si falla, se devuelve vacío y NO se compara nada. Un fetch fallido
    // no es un cambio de clima.
    console.error(`[alertas] METAR falló: ${e.message}`);
  }
  return out;
}

// ── Ciclo de vigilancia ──────────────────────────────────────────────────

const MIN_ENTRE_PUSH_MS = 30 * 60 * 1000;

async function procesarVigilancia() {
  if (!alertas.activo()) return;

  let subs;
  try {
    subs = await alertas.suscripcionesVigentes();
  } catch (e) {
    console.error(`[alertas] no se pudieron leer las suscripciones: ${e.message}`);
    return;
  }
  if (subs.length === 0) return;

  const icaos = [...new Set(subs.map(s => s.icao))];
  const metars = await fetchMetars(icaos);

  // Primero se resuelve el estado OBJETIVO de cada aeródromo —lo que pasó,
  // sin opinar—; recién después se evalúa contra los umbrales de cada
  // dispositivo. Los umbrales son personales: el límite de viento de un
  // alumno no es el de alguien con horas, así que el mismo METAR puede
  // ameritar aviso para uno y no para otro.
  const porIcao = new Map();

  for (const icao of icaos) {
    const previo = await alertas.estadoDe(icao);
    const indicador = subs.find(s => s.icao === icao).indicador;

    // ── NOTAM: sólo ALTAS ──
    // Un NOTAM que desaparece casi siempre es un problema de la fuente, no
    // una novedad operativa. Avisar de bajas generaría un falso positivo
    // cada vez que ANAC falla.
    const entrada = cache.get(indicador);
    let notamNuevos = [];
    if (entrada && !scrapeErrors.has(indicador)) {
      const ahora = entrada.data.notams.map(n => n.numero).filter(Boolean);
      if (previo?.notams != null) {
        notamNuevos = ahora.filter(n => !previo.notams.includes(n));
      }
      await alertas.guardarNotams(icao, ahora);
    }

    // ── METAR: se guardan los dos snapshots, sin evaluar todavía ──
    const raw = metars.get(icao);
    let antes = null, ahora = null;
    if (raw) {
      if (previo?.metar_raw) {
        antes = alertas.parseMetar(previo.metar_raw);
        ahora = alertas.parseMetar(raw);
      }
      await alertas.guardarMetar(icao, raw);
    }

    porIcao.set(icao, { notamNuevos, antes, ahora });
  }

  // ── Ahora sí, por dispositivo y con SUS umbrales ──
  for (const s of subs) {
    const est = porIcao.get(s.icao);
    if (!est) continue;

    // Techo de un push cada 30 min por aeródromo y dispositivo, aunque
    // haya varios cambios: se agrupan en un solo mensaje.
    if (s.ultimo_push &&
        Date.now() - new Date(s.ultimo_push).getTime() < MIN_ENTRE_PUSH_MS) {
      continue;
    }

    const cambiosClima = (est.antes && est.ahora)
      ? alertas.cambiosMetar(est.antes, est.ahora, s)
      : [];

    const partes = [];
    if (est.notamNuevos.length) {
      partes.push(est.notamNuevos.length === 1
        ? `NOTAM nuevo: ${est.notamNuevos[0]}`
        : `${est.notamNuevos.length} NOTAM nuevos`);
    }
    const malos = cambiosClima.filter(x => x.empeora);
    partes.push(...(malos.length ? malos : cambiosClima).map(x => x.texto));
    if (partes.length === 0) continue;

    const urgente = est.notamNuevos.length > 0 || malos.length > 0;
    const res = await alertas.enviarPush(s.token, s.icao, partes.join(" · "), urgente);

    if (res.ok) {
      await alertas.marcarPush(s.token, s.icao);
    } else if (res.status === 410) {
      // Apple avisa que el token murió: la app se desinstaló.
      await alertas.borrarToken(s.token);
    }
  }
}

// ── Loop ─────────────────────────────────────────────────────────────────

async function refresherLoop() {
  while (true) {
    const t0 = Date.now();
    await refreshLocations();

    // Los lugares que YA NO están en la lista perdieron sus novedades:
    // se limpian del cache para no seguir sirviendo NOTAM vencidos.
    for (const ind of [...cache.keys()]) {
      if (!locations.has(ind)) {
        cache.delete(ind);
        scrapeErrors.delete(ind);
      }
    }

    for (const indicador of locations.keys()) {
      await refreshOne(indicador);
      await sleep(DELAY_BETWEEN_MS);
    }

    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`[refresher] pasada: ${locations.size} lugares en ${secs}s (${scrapeErrors.size} con error)`);

    // La vigilancia no puede tumbar el scraper: si explota, se loguea y el
    // loop sigue.
    try {
      await procesarVigilancia();
    } catch (e) {
      console.error(`[alertas] ciclo falló: ${e.message}`);
    }

    await sleep(REFRESH_PAUSE_MS);
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "NOTAM API", version: 4, example: "/notams/MOR" });
});

app.get("/health", async (req, res) => {
  const timestamps = [...cache.values()].map(e => e.timestamp);
  res.json({
    ok: true,
    version: 4,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    locations_activas: locations.size,
    locations_updated_s: locationsUpdatedAt
      ? Math.round((Date.now() - locationsUpdatedAt) / 1000) : null,
    cached: cache.size,
    oldest_cache_s: timestamps.length
      ? Math.round((Date.now() - Math.min(...timestamps)) / 1000) : null,
    scrape_errors: scrapeErrors.size,
    // Cuáles fallan, para no tener que adivinar desde afuera.
    con_error: [...scrapeErrors.keys()],
    vigilancia: {
      base: alertas.activo(),
      apns: alertas.apnsConfigurado(),
      ...(await alertas.contarSuscripciones())
    }
  });
});

app.get("/locations", (req, res) => {
  res.json({
    count: locations.size,
    updated_at: locationsUpdatedAt ? new Date(locationsUpdatedAt).toISOString() : null,
    nota: "Sólo lugares con NOTAM activos. ANAC no lista los que no tienen novedades.",
    locations: [...locations].map(([indicador, nombre]) => ({ indicador, nombre }))
  });
});

app.get("/notams/:indicador", async (req, res) => {
  const indicador = req.params.indicador.toUpperCase();

  // Caso 1 — no está en la lista de ANAC.
  //
  // Es el caso que la v2 confundía con un fallo y por el que servía NOTAM
  // vencidos. Pero OJO con el otro extremo: tampoco se puede afirmar "no
  // hay NOTAM". Verificado el 2026-08-06 que ANAC publica novedades con
  // inicio futuro (Aeroparque tenía una que arrancaba 19 días después) y
  // aun así hubo un NOTAM real de Morón para el día siguiente que su sitio
  // no mostraba. La ausencia en ANAC NO garantiza ausencia de NOTAM.
  //
  // Por eso la respuesta dice qué sabemos —que ANAC no lo publica— y no
  // más que eso.
  if (locations.size > 0 && !locations.has(indicador)) {
    return res.json({
      source: "ANAC AIS",
      indicador,
      retrieved_at: new Date().toISOString(),
      count: 0,
      notams: [],
      no_publicado_por_anac: true,
      nota: "ANAC no lista novedades activas para este lugar. Esto no garantiza que no existan: consultá ARO-AIS.",
      warning: "Información de referencia. No reemplaza briefing oficial ARO-AIS."
    });
  }

  // Caso 2 — está en la lista pero el loop todavía no llegó.
  if (!cache.has(indicador)) await refreshOne(indicador);

  const entry = cache.get(indicador);

  // Caso 3 — está en la lista y no se pudo obtener.
  if (!entry) {
    return res.status(502).json({
      error: "No se pudieron obtener los NOTAM",
      indicador,
      detail: scrapeErrors.get(indicador) || "sin datos"
    });
  }

  res.json({
    ...entry.data,
    cache: true,
    stale: scrapeErrors.has(indicador),
    cache_age_s: Math.round((Date.now() - entry.timestamp) / 1000)
  });
});

// ── Vigilancia ───────────────────────────────────────────────────────────
//
// La app manda SIEMPRE su lista completa de aeródromos vigilados, no altas
// y bajas sueltas: así el servidor no puede quedar desincronizado con lo
// que el usuario ve en pantalla.

app.post("/watch", async (req, res) => {
  if (!alertas.activo()) {
    return res.status(503).json({ error: "vigilancia no disponible" });
  }
  const { token, aerodromos, reglas } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "falta token" });
  }
  try {
    await alertas.guardarSuscripcion({ token, aerodromos, reglas });
    res.json({ ok: true, vigilando: (aerodromos || []).length });
  } catch (e) {
    console.error(`[alertas] /watch: ${e.message}`);
    res.status(500).json({ error: "no se pudo guardar" });
  }
});

// Push de prueba a un dispositivo, para verificar la cadena entera sin
// esperar a que cambie el clima de verdad.
app.post("/watch/test", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "falta token" });
  const r = await alertas.enviarPush(
    token, "Oscar", "Prueba de notificación: la vigilancia está funcionando.", false);
  res.json(r);
});

app.listen(PORT, async () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  try {
    await alertas.initDB();
  } catch (e) {
    // Sin base, la vigilancia queda apagada pero los NOTAM siguen andando.
    console.error(`[alertas] initDB falló: ${e.message}`);
  }
  refresherLoop();
});
