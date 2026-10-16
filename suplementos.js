// suplementos.js — Suplementos a la AIP (AIP SUP) vigentes, por aeródromo.
//
// QUÉ ES (2026-10-16, Matías, mirando lo que muestra Pilotfy): en la ficha
// del aeródromo, la hoja «AIP» suma una pestaña «Suplementos» con los
// suplementos VIGENTES de ese aeródromo. Son los cambios temporales largos o
// con gráficos que no entran en un NOTAM: obras, plataformas modificadas,
// horarios, normas particulares temporales.
//
// DE DÓNDE SALE
// -------------
// https://ais.anac.gob.ar/sup arma la lista con un `$.get('/sup/a')` y
// `/sup/b`. Igual que el índice del AIP (cartas.js), esos fragmentos sólo
// responden con `X-Requested-With: XMLHttpRequest`.
//   - Serie A: aeródromos del AIP. El título trae el código entre paréntesis:
//     «AD MORÓN (MOR/SADM) – …».
//   - Serie B: aeródromos y helipuertos de uso doméstico (los del MADHEL):
//     «HLP PÚBLICO HUDSON - MANUEL AFONSO (HMA): …».
// Cada fila trae «si/no» de vigencia; sólo se publican los vigentes.
//
// CÓMO SE ASOCIA AL AERÓDROMO
// ---------------------------
// Por los códigos entre paréntesis, nunca por el nombre: «SAN FERNANDO» o
// «MORÓN» aparecen en títulos que no son de ese aeródromo (TMA, rutas…).
// Un paréntesis cuenta si tiene un indicador OACI (SA**/SR**); en la serie
// B, también uno con un único código local de tres letras. Así se evita
// tomar «(JUL/AGO)» o «(ESP/ENG)» como aeródromos.
// Los suplementos generales (ENR, GEN, TMA…) quedan afuera: no son de un
// aeródromo.
//
// La app baja todo el índice (unos pocos KB) y busca por el OACI o el código
// local del aeródromo abierto.

import * as cheerio from "cheerio";

const BASE = "https://ais.anac.gob.ar";
const SERIES = ["a", "b"];
// Seis horas: salen suplementos nuevos casi todos los días hábiles.
const TTL_MS = 6 * 60 * 60 * 1000;
const REINTENTOS = 3;
const ESPERA_MS = 4000;
const NO_SON_CODIGOS = new Set(["ESP", "ENG", "TEMP", "PERM"]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mismos meses que cartas.js (ANAC escribe «14-Oct-26»).
const MESES = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12
};

function aISO(txt) {
  const m = /^(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóú]{3})-(\d{2})$/.exec((txt || "").trim());
  if (!m) return null;
  const mes = MESES[m[2].toLowerCase()];
  if (!mes) return null;
  const dia = Number(m[1]);
  if (dia < 1 || dia > 31) return null;
  return `${2000 + Number(m[3])}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/// Códigos de aeródromo de un título (ver arriba).
export function codigosDe(titulo, serie) {
  const out = new Set();
  for (const [, grupo] of titulo.matchAll(/\(([^)]*)\)/g)) {
    const tokens = grupo.split(/[\s\/,–-]+/).filter(t => /^[A-Z]{3,4}$/.test(t) && !NO_SON_CODIGOS.has(t));
    const tieneOACI = tokens.some(t => /^S[AR][A-Z]{2}$/.test(t));
    if (tieneOACI) tokens.forEach(t => out.add(t));
    else if (serie === "B" && tokens.length === 1 && tokens[0].length === 3) out.add(tokens[0]);
  }
  // POR QUÉ (2026-10-16): algunos traen la lista suelta, sin paréntesis:
  // «AD SAAR, SARI, SAZN, SAZS: …» o «… OFICINAS MET AD SAZG, SAZY, …».
  // Sólo los OACI que siguen a «AD», para no levantar cualquier palabra.
  for (const [, lista] of titulo.matchAll(/\bAD\s+((?:S[AR][A-Z]{2}\b(?:\s*,\s*|\s+Y\s+)?)+)/g)) {
    for (const t of lista.match(/S[AR][A-Z]{2}/g) ?? []) out.add(t);
  }
  return [...out];
}

// ── Estado en memoria ────────────────────────────────────────────────────

let indice = null;      // { generado, suplementos: { CODIGO: [sup] }, _stats }
let indiceAt = 0;
let ultimoError = null;
let bajando = null;

async function bajarSerie(s) {
  let err;
  for (let i = 0; i < REINTENTOS; i++) {
    if (i > 0) await sleep(ESPERA_MS * i);
    try {
      const r = await fetch(`${BASE}/sup/${s}`, {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "text/html, */*; q=0.01",
          "User-Agent": "Oscar/1.0 (+app de aviación general; contacto vía App Store)"
        }
      });
      if (!r.ok) { err = new Error(`HTTP ${r.status}`); continue; }
      const html = await r.text();
      // Sin la tabla es la página de error (8 KB), no la lista.
      if (!html.includes("<table")) { err = new Error(`sin tabla (${html.length} B)`); continue; }
      return html;
    } catch (e) { err = e; }
  }
  throw err ?? new Error(`no se pudo bajar la serie ${s}`);
}

function parsear(html, serie) {
  const $ = cheerio.load(html);
  const lista = [];
  $("tr").each((_, tr) => {
    const $tr = $(tr);
    // Por la celda y no por la clase: «vigente» es una clase que ANAC
    // podría cambiar; el «si» de la primera columna es el dato.
    const vigente = $tr.find("td").first().text().trim().toLowerCase();
    if (vigente !== "si" && vigente !== "sí") return;
    const nro = $tr.find("#nroanno").text().replace(/\s+/g, " ").trim();
    const a = $tr.find('a[href*="descarga"]').first();
    const titulo = ($tr.find("#title").text() || "").replace(/\s+/g, " ").trim();
    const fecha = aISO($tr.find("#from").text());
    const href = a.attr("href") || "";
    if (!nro || !titulo || !href) return;
    lista.push({
      nro, serie, titulo, fecha,
      url: href.startsWith("http") ? href : BASE + href,
      codigos: codigosDe(titulo, serie)
    });
  });
  return lista;
}

async function obtener({ forzar = false } = {}) {
  const fresco = indice && Date.now() - indiceAt < TTL_MS;
  if (fresco && !forzar) return indice;
  if (bajando) return bajando;

  bajando = (async () => {
    try {
      const todos = [];
      for (const s of SERIES) todos.push(...parsear(await bajarSerie(s), s.toUpperCase()));
      // Cero vigentes en las dos series es un parseo roto, no la realidad.
      if (todos.length === 0) throw new Error("parseo sin resultados");
      const porCodigo = {};
      let generales = 0;
      for (const sup of todos) {
        if (!sup.codigos.length) { generales++; continue; }
        const item = { nro: sup.nro, serie: sup.serie, titulo: sup.titulo, fecha: sup.fecha, url: sup.url };
        for (const c of sup.codigos) (porCodigo[c] ||= []).push(item);
      }
      // Lo más nuevo primero (la fecha ISO ordena como texto).
      for (const c of Object.keys(porCodigo)) {
        porCodigo[c].sort((x, y) => (y.fecha || "").localeCompare(x.fecha || ""));
      }
      indice = {
        generado: new Date().toISOString(),
        suplementos: porCodigo,
        _stats: { vigentes: todos.length, generales, codigos: Object.keys(porCodigo).length }
      };
      indiceAt = Date.now();
      ultimoError = null;
      console.log(`[suplementos] ok: ${todos.length} vigentes, ${generales} generales, `
        + `${Object.keys(porCodigo).length} códigos`);
      return indice;
    } catch (e) {
      ultimoError = e.message;
      console.error("[suplementos] fallo:", e.message);
      if (indice) return indice;   // lo de antes sirve
      throw e;
    } finally {
      bajando = null;
    }
  })();
  return bajando;
}

// ── Rutas ────────────────────────────────────────────────────────────────

export function montar(app) {
  // Índice completo por código (OACI y código local). Es lo que baja la app.
  app.get("/suplementos", async (req, res) => {
    try {
      const i = await obtener({ forzar: req.query.forzar === "1" });
      res.set("Cache-Control", "public, max-age=1800");
      res.json({
        generado: i.generado,
        fuente: `${BASE}/sup`,
        nota: "Suplementos a la AIP vigentes (series A y B), por código de aeródromo. "
            + "Los PDF se sirven desde ais.anac.gob.ar.",
        suplementos: i.suplementos
      });
    } catch (e) {
      res.status(502).json({ error: "No se pudo leer la lista de suplementos de ANAC", detalle: e.message });
    }
  });

  // Un aeródromo suelto, para probar a mano.
  app.get("/suplementos/:codigo", async (req, res) => {
    const codigo = req.params.codigo.toUpperCase();
    try {
      const i = await obtener();
      res.json({ codigo, generado: i.generado, suplementos: i.suplementos[codigo] ?? [] });
    } catch (e) {
      res.status(502).json({ error: "No se pudo leer la lista de suplementos de ANAC", detalle: e.message });
    }
  });
}

/// Para el /health del servicio.
export function estado() {
  return {
    vigentes: indice?._stats.vigentes ?? 0,
    codigos: indice?._stats.codigos ?? 0,
    generado: indice?.generado ?? null,
    edad_s: indiceAt ? Math.round((Date.now() - indiceAt) / 1000) : null,
    ultimo_error: ultimoError
  };
}

export function precalentar() {
  obtener().catch(() => {});
}
