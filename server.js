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
// Índice de cartas del AIP. Independiente de todo lo demás: no usa la base
// de datos, así que sigue funcionando aunque la vigilancia esté apagada.
import * as cartas from "./cartas.js";
// Lectura del libro de papel con Gemini. La API key vive acá y NUNCA en la
// app: una key en el binario se extrae y la factura la paga Matías.
import * as logbook from "./logbook.js";

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
      // OJO: las líneas vienen con el tipo adelante —"METAR SAAR 151200Z…"—
      // así que el primer token NO es el indicador (2026-08-15).
      //
      // Éste fue el bug que dejó la vigilancia de clima muerta desde el
      // día uno: se tomaba `split()[0]`, que daba "METAR", se exigía que
      // midiera 4 caracteres y como mide 5 se descartaban TODOS. El mapa
      // quedaba siempre vacío, nunca había un "antes" contra qué comparar
      // y por eso no salió jamás una alerta de METAR. Los avisos de FIR
      // sí llegaban, porque no pasan por acá.
      let tokens = l.split(/\s+/);
      if (tokens[0] === "METAR" || tokens[0] === "SPECI") tokens = tokens.slice(1);
      const icao = tokens[0];
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

  // El METAR se pide por ESTACIÓN, no por aeródromo. Luján no publica
  // METAR: le corresponde el de Morón. Sin esto, la campanita en un campo
  // chico no podía avisar nada de clima nunca (2026-08-15).
  const estacionDe = s => (s.estacion || s.icao).toUpperCase();
  const estaciones = [...new Set(subs.map(estacionDe))];
  const metars = await fetchMetars(estaciones);

  // ── NOTAM de FIR ──
  //
  // ANAC publica bajo la FIR ("-EF" Ezeiza) avisos que no figuran bajo el
  // aeródromo pero que igual lo afectan. El caso que lo destapó: no había
  // NOTAM para Morón pero sí uno de FIR Ezeiza que lo tocaba.
  //
  // Las altas se calculan UNA vez por FIR —son las mismas para todos— y
  // después se filtra por cercanía para cada aeródromo, que es lo que
  // cambia entre suscriptores.
  const nuevosPorFir = new Map();
  for (const fir of new Set(subs.map(s => s.fir).filter(Boolean))) {
    const entrada = cache.get(fir);
    if (!entrada || scrapeErrors.has(fir)) continue;
    const previo = await alertas.estadoDe(fir);
    const ahora = entrada.data.notams.filter(n => n.numero);
    if (previo?.notams != null) {
      const conocidos = new Set(previo.notams);
      nuevosPorFir.set(fir, ahora.filter(n => !conocidos.has(n.numero)));
    }
    // La primera vez sólo se memoriza: sin estado previo, "todos son
    // nuevos" y llegarían 40 notificaciones de golpe.
    await alertas.guardarNotams(fir, ahora.map(n => n.numero));
  }

  // Primero se resuelve el estado OBJETIVO de cada aeródromo —lo que pasó,
  // sin opinar—; recién después se evalúa contra los umbrales de cada
  // dispositivo. Los umbrales son personales: el límite de viento de un
  // alumno no es el de alguien con horas, así que el mismo METAR puede
  // ameritar aviso para uno y no para otro.
  const porIcao = new Map();

  // ── Clima, una vez por estación ──
  // Se guarda con la estación como clave, así dos aeródromos que comparten
  // METAR comparten también el estado: no se compara dos veces lo mismo.
  const porEstacion = new Map();
  for (const est of estaciones) {
    const raw = metars.get(est);
    if (!raw) { porEstacion.set(est, { antes: null, ahora: null }); continue; }
    const previo = await alertas.estadoDe(est);
    porEstacion.set(est, previo?.metar_raw
      ? { antes: alertas.parseMetar(previo.metar_raw),
          ahora: alertas.parseMetar(raw) }
      : { antes: null, ahora: null });
    await alertas.guardarMetar(est, raw);
  }

  for (const icao of icaos) {
    const previo = await alertas.estadoDe(icao);
    const indicador = subs.find(s => s.icao === icao).indicador;

    // ── NOTAM: sólo ALTAS ──
    // Un NOTAM que desaparece casi siempre es un problema de la fuente, no
    // una novedad operativa. Avisar de bajas generaría un falso positivo
    // cada vez que ANAC falla.
    //
    // ANAC lista SÓLO los lugares con novedades activas, así que un
    // aeródromo tranquilo no aparece y no tiene entrada en el cache. Eso
    // hay que leerlo como "cero NOTAM", que es un dato, y no como "no sé
    // nada", que es la ausencia de dato (2026-08-15).
    //
    // Tratarlo como ausencia era el segundo motivo por el que no llegaban
    // avisos: en un campo chico —que casi nunca está en la lista— nunca se
    // guardaba un estado previo, así que cuando por fin salía un NOTAM
    // caía en la rama de "primera pasada, sólo memorizar" y se lo tragaba
    // en silencio. El primer NOTAM de cada aeródromo tranquilo, que es
    // justo el que importa, no se avisaba nunca.
    //
    // Los tres estados posibles, que ya distingue el scraper:
    //   · en la lista y scrapeado bien → los números que trajo
    //   · NO está en la lista          → [] (sin novedades activas)
    //   · en la lista pero falló       → no se toca nada
    const entrada = cache.get(indicador);
    const fallo = scrapeErrors.has(indicador);
    let notamNuevos = [];
    if (!fallo) {
      //
      // El `locations.size > 0` no es paranoia: si la lista de ANAC falla
      // entera, "no está en la lista" dejaría de significar "sin novedades"
      // y pasaría a significar "no pudimos preguntar". Guardar [] ahí
      // borraría los NOTAM conocidos y la pasada siguiente los avisaría
      // como nuevos.
      const ahora = entrada
        ? entrada.data.notams.map(n => n.numero).filter(Boolean)
        : (locations.size > 0 && !locations.has(indicador) ? [] : null);
      if (ahora != null) {
        if (previo?.notams != null) {
          notamNuevos = ahora.filter(n => !previo.notams.includes(n));
        }
        await alertas.guardarNotams(icao, ahora);
      }
    }

    porIcao.set(icao, { notamNuevos });
  }

  // ── Ahora sí, por dispositivo y con SUS umbrales ──
  //
  // Si alguien vigila Luján y Morón a la vez, el METAR es el mismo y sin
  // cuidado saldrían dos notificaciones idénticas. Se manda una sola: la
  // primera que sale se anota acá y las siguientes del mismo dispositivo
  // omiten la parte de clima —pero conservan sus NOTAM, que sí son propios
  // de cada aeródromo—. Se ordena para que gane el aeródromo que ES la
  // estación, que es donde el dato realmente se midió.
  const climaYaAvisado = new Map();   // token → Set de estaciones
  const ordenadas = [...subs].sort((a, b) =>
    (a.icao === estacionDe(a) ? 0 : 1) - (b.icao === estacionDe(b) ? 0 : 1));

  for (const s of ordenadas) {
    const est = porIcao.get(s.icao);
    if (!est) continue;

    // Techo de un push cada 30 min por aeródromo y dispositivo, aunque
    // haya varios cambios: se agrupan en un solo mensaje.
    if (s.ultimo_push &&
        Date.now() - new Date(s.ultimo_push).getTime() < MIN_ENTRE_PUSH_MS) {
      continue;
    }

    const estacion = estacionDe(s);
    const clima = porEstacion.get(estacion) || {};
    const yaSalio = climaYaAvisado.get(s.token)?.has(estacion) === true;

    const cambiosClima = (!yaSalio && clima.antes && clima.ahora)
      ? alertas.cambiosMetar(clima.antes, clima.ahora, s)
      : [];

    const partes = [];
    if (est.notamNuevos.length) {
      partes.push(est.notamNuevos.length === 1
        ? `NOTAM nuevo: ${est.notamNuevos[0]}`
        : `${est.notamNuevos.length} NOTAM nuevos`);
    }

    // Avisos de FIR que caen cerca de ESTE aeródromo. Los que no traen
    // coordenadas se avisan igual: no se puede saber si tocan, y callarlos
    // sería decidir por el piloto.
    let firCerca = [];
    if (s.fir && s.lat != null && s.lon != null) {
      firCerca = (nuevosPorFir.get(s.fir) || []).filter(n =>
        alertas.notamFirAfecta(n.texto, { lat: s.lat, lon: s.lon }).afecta);
    }
    if (firCerca.length) {
      partes.push(firCerca.length === 1
        ? `Aviso FIR: ${firCerca[0].numero}`
        : `${firCerca.length} avisos FIR en tu zona`);
    }
    const malos = cambiosClima.filter(x => x.empeora);
    const textosClima = (malos.length ? malos : cambiosClima).map(x => x.texto);
    if (textosClima.length) {
      // Se aclara de dónde salió el dato cuando no es del propio campo: en
      // Luján el viento medido es el de Morón y el piloto tiene que poder
      // pesarlo con esa distancia en la cabeza.
      partes.push(estacion === s.icao
        ? textosClima.join(" · ")
        : `${textosClima.join(" · ")} (METAR ${estacion})`);
    }
    if (partes.length === 0) continue;

    const urgente = est.notamNuevos.length > 0 || malos.length > 0
                 || firCerca.length > 0;
    const res = await alertas.enviarPush(
      s.token, s.nombre || s.icao, partes.join(" · "), urgente);

    if (res.ok) {
      if (textosClima.length) {
        if (!climaYaAvisado.has(s.token)) climaYaAvisado.set(s.token, new Set());
        climaYaAvisado.get(s.token).add(estacion);
      }
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
  res.json({ status: "ok", service: "NOTAM API", version: 6, example: "/notams/MOR" });
});

app.get("/health", async (req, res) => {
  const timestamps = [...cache.values()].map(e => e.timestamp);
  res.json({
    ok: true,
    version: 6,
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
    cartas: cartas.estado(),
    logbook: logbook.estado(),
    vigilancia: {
      base: alertas.activo(),
      apns: alertas.apnsConfigurado(),
      ...(await alertas.contarSuscripciones())
    }
  });
});

cartas.montar(app);
logbook.montar(app);

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

// Qué tiene guardado la vigilancia de un aeródromo. Sirve para contestar
// "¿por qué no me llegó nada?" sin adivinar: si `notams` es null, nunca se
// guardó estado y el próximo NOTAM se avisaría; si es [], el estado está
// tomado y una alta se detecta. No expone nada de nadie —el estado es el
// mismo para todos los dispositivos, no hay tokens ni suscriptores acá—.
app.get("/watch/estado/:icao", async (req, res) => {
  if (!alertas.activo()) return res.status(503).json({ error: "vigilancia apagada" });
  const icao = req.params.icao.toUpperCase();
  const e = await alertas.estadoDe(icao);
  res.json(e ? {
    icao,
    notams: e.notams, notams_ts: e.notams_ts,
    metar_raw: e.metar_raw, metar_ts: e.metar_ts
  } : { icao, estado: null });
});

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
  const { token, urgente } = req.body || {};
  if (!token) return res.status(400).json({ error: "falta token" });
  // Urgente por defecto: una prueba que no se ve no prueba nada.
  const r = await alertas.enviarPush(
    token, "Oscar", "Prueba de notificación: la vigilancia está funcionando.",
    urgente !== false);
  res.json(r);
});

app.listen(PORT, async () => {
  // Se baja el índice de cartas al arrancar para que el primer piloto que
  // abra una ficha no espere los 6 MB. Si falla, no pasa nada: se reintenta
  // en el primer pedido.
  cartas.precalentar();
  await logbook.initDB();
  console.log(`Servidor corriendo en puerto ${PORT}`);
  try {
    await alertas.initDB();
  } catch (e) {
    // Sin base, la vigilancia queda apagada pero los NOTAM siguen andando.
    console.error(`[alertas] initDB falló: ${e.message}`);
  }
  refresherLoop();
});
