// cartas.js — índice de cartas del AIP de ANAC
//
// QUÉ RESUELVE
// ------------
// Las cartas oficiales (plano de aeródromo, estacionamiento, aproximación
// visual) viven en ais.anac.gob.ar detrás de URLs con hash:
//
//     https://ais.anac.gob.ar/descarga/aip-6468ed1cc6654
//
// El hash cambia con cada enmienda, así que NO se puede construir una URL a
// partir del código OACI. Hay que resolverla contra el índice, y el índice es
// una página de 6 MB. Este módulo la baja cada tanto, la parsea y deja un
// JSON de unos pocos KB que la app sí puede pedir en cada arranque.
//
// EL HEADER NO ES OPCIONAL
// ------------------------
// `GET /aip/ad` sin `X-Requested-With: XMLHttpRequest` devuelve **404**.
// Verificado contra el servidor real el 2026-08-18: sin el header, 404 y
// 7,9 KB de página de error; con el header, 200 y 6,18 MB con los 51
// aeródromos. Es un partial de una jQuery DataTable y ANAC lo sirve sólo a
// pedidos que se declaran AJAX. Si algún día esto devuelve 404, empezar por
// acá antes de suponer que se cayó el sitio.
//
// POR QUÉ ACÁ Y NO EN LA APP
// --------------------------
// Por los 6 MB, y porque parsear HTML ajeno es frágil: si ANAC cambia el
// markup, se arregla en un deploy y no en una versión de App Store que hay
// que esperar a que la gente actualice.

import * as cheerio from "cheerio";

const BASE = "https://ais.anac.gob.ar";
const AD_URL = `${BASE}/aip/ad`;

// Doce horas. El AIP se mueve por ciclos AIRAC de 28 días, así que ni
// siquiera esto hace falta — pero es barato y cubre las enmiendas urgentes.
const TTL_MS = 12 * 60 * 60 * 1000;

// Reintentos espaciados: el resto del servicio ya aprendió que ANAC devuelve
// 500 si se le pega seguido (ver DELAY_BETWEEN_MS en server.js).
const REINTENTOS = 3;
const ESPERA_MS = 4000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Qué es cada sección AD-2.x ───────────────────────────────────────────
//
// Los nombres son los del Anexo 4 de OACI, acortados a lo que un piloto
// diría. `vfr: true` marca las que sirven volando visual; el resto son de
// vuelo por instrumentos y la app las esconde para no llenar la ficha de
// cosas que no se van a tocar.
const SECCIONES = {
  "0": { nombre: "Datos del aeródromo",        vfr: true,  orden: 4 },
  "A": { nombre: "Plano de aeródromo",         vfr: true,  orden: 1 },
  "B": { nombre: "Estacionamiento y atraque",  vfr: true,  orden: 2 },
  "C": { nombre: "Movimiento en tierra",       vfr: true,  orden: 3 },
  "D": { nombre: "Obstáculos (tipo A)",        vfr: false, orden: 20 },
  "E": { nombre: "Obstáculos (tipo B)",        vfr: false, orden: 21 },
  "G": { nombre: "Topográfica de precisión",   vfr: false, orden: 22 },
  "H": { nombre: "Carta de área",              vfr: false, orden: 23 },
  "I": { nombre: "Salida normalizada (SID)",   vfr: false, orden: 24 },
  "K": { nombre: "Llegada normalizada (STAR)", vfr: false, orden: 25 },
  "M": { nombre: "Aproximación instrumental",  vfr: false, orden: 26 },
  "N": { nombre: "Aproximación visual",        vfr: true,  orden: 0 }
};

// Meses en español Y en inglés.
//
// ANAC escribe "11-Jun-26" y "13-Jul-23", que se leen igual en los dos
// idiomas — justo los tres meses ambiguos son idénticos. Pero Ene/Jan,
// Abr/Apr, Ago/Aug y Dic/Dec NO lo son, y no hay forma de saber cuál usa
// hasta que aparezca una carta de enero. Aceptar los dos cuesta cuatro
// líneas y evita que un día se caiga el parseo de un mes entero.
const MESES = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12
};

/// "13-Jul-23" → "2023-07-13". Devuelve null si no se entiende, y el que
/// llama decide: acá una fecha mal leída es peor que ninguna, porque toda la
/// gracia de mostrar la carta es poder decir de cuándo es.
function aISO(txt) {
  const m = /^(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóú]{3})-(\d{2})$/.exec(txt.trim());
  if (!m) return null;
  const mes = MESES[m[2].toLowerCase()];
  if (!mes) return null;
  const dia = Number(m[1]);
  if (dia < 1 || dia > 31) return null;
  // Dos dígitos: el AIP no tiene cartas del siglo pasado ni las va a tener
  // más allá de 2099.
  const anio = 2000 + Number(m[3]);
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

// ── Estado en memoria ────────────────────────────────────────────────────

let indice = null;        // { generado, aerodromos: { ICAO: [carta] } }
let indiceAt = 0;
let ultimoError = null;
let bajando = null;       // promesa en curso, para no bajar 6 MB dos veces

// ── Descarga y parseo ────────────────────────────────────────────────────

async function bajarHTML() {
  let err;
  for (let i = 0; i < REINTENTOS; i++) {
    if (i > 0) await sleep(ESPERA_MS * i);
    try {
      const r = await fetch(AD_URL, {
        headers: {
          // Sin esto: 404. Ver el comentario de arriba.
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "text/html, */*; q=0.01",
          "User-Agent": "Oscar/1.0 (+app de aviación general; contacto vía App Store)"
        }
      });
      if (!r.ok) { err = new Error(`HTTP ${r.status}`); continue; }
      const html = await r.text();
      // Una respuesta de 8 KB es la página de error, no el índice. Sin este
      // chequeo el parseo devolvería cero filas y publicaríamos un índice
      // vacío como si fuera bueno.
      if (html.length < 100_000) { err = new Error(`respuesta corta (${html.length} B)`); continue; }
      return html;
    } catch (e) { err = e; }
  }
  throw err ?? new Error("no se pudo bajar el índice");
}

/// Filas del tipo:
///   SADM-AD-2.A  Cartas relativas al aeródromo - Plano de ... - OACI  01/23  13-Jul-23
function parsear(html) {
  const $ = cheerio.load(html);
  const aerodromos = {};
  let filas = 0, descartadas = 0;

  // Se lee CELDA POR CELDA y no con una regex sobre el texto de la fila.
  //
  // La fila real tiene dos celdas: "SADM-AD-2.A  <descripción>" y
  // "01/23  13-Jul-23". Una regex sobre `$tr.text()` depende de que haya un
  // espacio donde termina una celda y empieza la otra, y eso lo pone el
  // formateo del HTML, no el dato: si ANAC minifica la página, la
  // descripción y la enmienda quedan pegadas ("...OACI01/23") y el parseo
  // devuelve cero filas sin fallar. Las celdas no tienen ese problema.
  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const a = $tr.find('a[href*="descarga"]').first();
    if (!a.length) return;

    const celdas = $tr.find("td, th").toArray()
      .map(c => $(c).text().replace(/\s+/g, " ").trim());
    const cabecera = celdas.find(c => /^[A-Z]{4}-AD-2\./.test(c)) ?? "";
    const mCab = /^([A-Z]{4})-AD-2\.([0-9A-Z]+)\s*(.*)$/.exec(cabecera);
    if (!mCab) return;

    // La enmienda y la fecha pueden estar en la misma celda o separadas.
    const resto = celdas.join(" ");
    // `(?!\d)` y no `\b`: la celda puede terminar pegada al texto del link
    // ("13-Jul-23PDF") y ahí NO hay borde de palabra entre el 3 y la P, así
    // que `\b` no matchea y la fila entera se pierde en silencio. Lo único
    // que hay que descartar es que siga otro dígito, que sería un año de
    // cuatro cifras mal leído.
    const mFecha = /(\d\d\/\d\d)\s+(\d{1,2}-[A-Za-zÁÉÍÓÚáéíóú]{3}-\d{2})(?!\d)/.exec(resto);
    if (!mFecha) return;

    filas++;
    const [, icao, sec] = mCab;
    const [, amdt, fechaTxt] = mFecha;
    const meta = SECCIONES[sec];
    const fecha = aISO(fechaTxt);

    // Sección desconocida o fecha ilegible → afuera. Preferimos publicar
    // menos cartas que publicar una sin poder decir de cuándo es.
    if (!meta || !fecha) { descartadas++; return; }

    const href = a.attr("href") || "";
    (aerodromos[icao] ||= []).push({
      sec,
      tipo: meta.nombre,
      vfr: meta.vfr,
      amdt,
      fecha,
      url: href.startsWith("http") ? href : BASE + href
    });
  });

  for (const icao of Object.keys(aerodromos)) {
    aerodromos[icao].sort((x, y) =>
      (SECCIONES[x.sec]?.orden ?? 99) - (SECCIONES[y.sec]?.orden ?? 99));
  }

  return {
    generado: new Date().toISOString(),
    fuente: AD_URL,
    aerodromos,
    _stats: { filas, descartadas, aerodromos: Object.keys(aerodromos).length }
  };
}

/// Devuelve el índice, bajándolo si hace falta. Nunca dos descargas a la vez.
async function obtener({ forzar = false } = {}) {
  const fresco = indice && Date.now() - indiceAt < TTL_MS;
  if (fresco && !forzar) return indice;
  if (bajando) return bajando;

  bajando = (async () => {
    try {
      const nuevo = parsear(await bajarHTML());
      // Un índice sin aeródromos es un parseo roto, no un AIP vacío. Si ya
      // teníamos uno bueno, se conserva: servir datos de ayer es mucho mejor
      // que servir una lista vacía que la app leería como "no hay cartas".
      if (nuevo._stats.aerodromos === 0) throw new Error("parseo sin resultados");
      indice = nuevo;
      indiceAt = Date.now();
      ultimoError = null;
      console.log(`[cartas] índice ok: ${nuevo._stats.aerodromos} aeródromos, `
        + `${nuevo._stats.filas} filas, ${nuevo._stats.descartadas} descartadas`);
      return indice;
    } catch (e) {
      ultimoError = e.message;
      console.error("[cartas] fallo:", e.message);
      if (indice) return indice;   // lo viejo sirve
      throw e;
    } finally {
      bajando = null;
    }
  })();

  return bajando;
}

// ── Rutas ────────────────────────────────────────────────────────────────

export function montar(app) {
  // Índice completo. Es lo que baja la app y se guarda.
  app.get("/cartas", async (req, res) => {
    try {
      const i = await obtener({ forzar: req.query.forzar === "1" });
      res.set("Cache-Control", "public, max-age=3600");
      res.json({
        generado: i.generado,
        fuente: i.fuente,
        nota: "Índice del AIP de ANAC. Los PDF se sirven desde ais.anac.gob.ar. "
            + "Sólo los aeródromos con sección AD-2 publicada tienen cartas: "
            + "los aeroclubes no están.",
        aerodromos: i.aerodromos
      });
    } catch (e) {
      res.status(502).json({ error: "No se pudo leer el índice de ANAC", detalle: e.message });
    }
  });

  // Un aeródromo suelto, para probar a mano.
  app.get("/cartas/:icao", async (req, res) => {
    const icao = req.params.icao.toUpperCase();
    try {
      const i = await obtener();
      const cartas = i.aerodromos[icao] ?? [];
      res.json({
        icao,
        generado: i.generado,
        cartas,
        // La ausencia se explica: sin esto parece un error del servicio.
        ...(cartas.length ? {} : {
          nota: "ANAC no publica sección AD-2 para este aeródromo. "
              + "Es lo normal en aeroclubes y campos privados."
        })
      });
    } catch (e) {
      res.status(502).json({ error: "No se pudo leer el índice de ANAC", detalle: e.message });
    }
  });
}

/// Para el /health del servicio.
export function estado() {
  return {
    aerodromos: indice ? Object.keys(indice.aerodromos).length : 0,
    generado: indice?.generado ?? null,
    edad_s: indiceAt ? Math.round((Date.now() - indiceAt) / 1000) : null,
    ultimo_error: ultimoError
  };
}

/// Se llama al arrancar para que el primer usuario no espere los 6 MB.
export function precalentar() {
  obtener().catch(() => {});
}
