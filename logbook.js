// logbook.js — leer una página del libro de vuelo de papel con Gemini
//
// POR QUÉ ACÁ Y NO EN LA APP
// --------------------------
// Por la API key. Una key metida en el binario se extrae en diez minutos con
// herramientas que están en cualquier tutorial, y el que la saca gasta CON LA
// CUENTA DE MATÍAS. No hay forma de esconderla bien: la app tiene que poder
// leerla para usarla, así que el que tiene el archivo la tiene. La única
// solución real es que la key no viaje nunca.
//
// De paso, tener el prompt acá permite corregirlo con un deploy en vez de con
// una versión de App Store que hay que esperar a que la gente actualice.
//
// EL 95% NO ES SUFICIENTE, Y ESO NO ES UN DEFECTO DEL MODELO
// ---------------------------------------------------------
// Una hoja tiene 15 renglones por 8 campos: 120 valores. Con 95% de acierto
// por campo son SEIS errores por hoja. Por eso este módulo no devuelve "los
// vuelos": devuelve los vuelos MÁS una lista de qué campos no cierran, para
// que la pantalla de revisión los pinte y el piloto mire ahí.
//
// La regla que hace que esto sea usable: **ante la duda, null**. Un campo
// vacío el piloto lo completa mirando su libro. Un campo inventado no lo
// mira nadie, y termina siendo una hora de vuelo que no existió.
//
// LOS CRUCES SON LO QUE APORTAMOS NOSOTROS
// ----------------------------------------
// Cualquiera le pasa la foto a Gemini. Lo que no puede hacer cualquiera es
// saber que la hoja del libro TIENE su propia fila de totales escrita a mano
// por el piloto, y que si la suma de los tiempos leídos no cierra con ese
// total, hay un error en algún renglón. Ese cruce, más los tipos de aeronave
// y el formato de matrícula, es lo que convierte 95% en algo confiable.

import express from "express";
import pg from "pg";

const MODELO   = process.env.GEMINI_MODELO || "gemini-3.5-flash";
const ENDPOINT = process.env.GEMINI_ENDPOINT
  || "https://generativelanguage.googleapis.com/v1beta/interactions";

/// Páginas por dispositivo, de por vida. Un libro entero son 15-20 hojas, así
/// que 25 alcanza para digitalizar el pasado completo y deja margen para las
/// que salgan mal. No es un límite de uso: es un tope de gasto.
const TOPE_DISPOSITIVO = Number(process.env.LOGBOOK_TOPE_DISPOSITIVO || 25);

/// Tope global por día. Es el cortacircuitos: si algo se vuelve loco —un bug,
/// un script, un dispositivo que reinstala para resetear su cuota— esto lo
/// frena antes de que llegue la factura.
const TOPE_DIARIO_GLOBAL = Number(process.env.LOGBOOK_TOPE_DIARIO || 400);

const MAX_BYTES = 8 * 1024 * 1024;

// ── Estado ───────────────────────────────────────────────────────────────

let pool = null;
let hoy = null;          // "2026-08-19"
let usadasHoy = 0;
const memoria = new Map();   // dispositivo → usadas (fallback sin base)
let ultimoError = null;
let leidasTotal = 0;

function claveDia() {
  return new Date().toISOString().slice(0, 10);
}

function contarGlobal() {
  const d = claveDia();
  if (d !== hoy) { hoy = d; usadasHoy = 0; }
  return usadasHoy;
}

// ── Cuota ────────────────────────────────────────────────────────────────

export async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log("[logbook] sin DATABASE_URL: la cuota por dispositivo vive en memoria");
    return;
  }
  try {
    // Pool chico y propio. `alertas.js` no exporta el suyo y no vale la pena
    // tocarlo: dos conexiones más no mueven la aguja y este módulo queda
    // independiente, que es lo que necesita para sobrevivir si algún día se
    // apaga la vigilancia.
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS logbook_cuota (
        dispositivo TEXT PRIMARY KEY,
        usadas      INTEGER NOT NULL DEFAULT 0,
        primera     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ultima      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`);
    console.log("[logbook] cuota persistida en Postgres");
  } catch (e) {
    pool = null;
    console.error("[logbook] no se pudo preparar la tabla de cuota:", e.message);
  }
}

async function usadasDe(dispositivo) {
  if (!pool) return memoria.get(dispositivo) ?? 0;
  const { rows } = await pool.query(
    "SELECT usadas FROM logbook_cuota WHERE dispositivo = $1", [dispositivo]);
  return rows[0]?.usadas ?? 0;
}

/// Se suma DESPUÉS de una lectura exitosa. Si Gemini falla o la foto no se
/// entiende, no se le cobra al piloto una página de su cuota por un problema
/// nuestro.
async function sumarUso(dispositivo) {
  contarGlobal();
  usadasHoy++;
  leidasTotal++;
  if (!pool) {
    memoria.set(dispositivo, (memoria.get(dispositivo) ?? 0) + 1);
    return;
  }
  await pool.query(`
    INSERT INTO logbook_cuota (dispositivo, usadas) VALUES ($1, 1)
    ON CONFLICT (dispositivo) DO UPDATE
      SET usadas = logbook_cuota.usadas + 1, ultima = NOW();`, [dispositivo]);
}

// ── El esquema que se le exige al modelo ─────────────────────────────────

const ESQUEMA = {
  type: "object",
  properties: {
    anio: {
      type: ["integer", "null"],
      description: "Año que figura en el recuadro AÑO 20__ de la hoja. null si no se ve."
    },
    totalPaginaHoras: {
      type: ["number", "null"],
      description: "El TOTAL de la página escrito a mano al pie, en horas decimales. null si no se ve."
    },
    vuelos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          renglon:   { type: "integer", description: "Número de renglón en la hoja, empezando en 1." },
          fecha:     { type: ["string", "null"], description: "AAAA-MM-DD. null si no se lee con seguridad." },
          matricula: { type: ["string", "null"], description: "Ej: LV-ABC. Sin espacios, en mayúsculas." },
          tipo:      { type: ["string", "null"], description: "Tipo de aeronave. Ej: C152, C172, AB-115, PA-11." },
          desde:     { type: ["string", "null"], description: "Aeródromo de salida como está escrito." },
          hasta:     { type: ["string", "null"], description: "Aeródromo de llegada como está escrito." },
          salida:    { type: ["string", "null"], description: "HH:MM en 24 h." },
          llegada:   { type: ["string", "null"], description: "HH:MM en 24 h." },
          horas:     { type: ["number", "null"], description: "Duración en horas decimales. 1:30 se escribe 1.5." },
          aterrizajes: { type: ["integer", "null"] },
          observaciones: { type: ["string", "null"] },
          dudosos: {
            type: "array",
            items: { type: "string" },
            description: "Nombres de los campos de ESTE renglón que no pudiste leer con seguridad."
          }
        },
        required: ["renglon", "dudosos"]
      }
    }
  },
  required: ["vuelos"]
};

const PROMPT = `Sos un asistente que transcribe páginas de libros de vuelo argentinos (formulario ANAC) escritas a mano.

LA HOJA
La foto es la página IZQUIERDA de un libro de vuelo abierto. Las columnas, de izquierda a derecha, son:
DIA/MES/AÑO · MARCA Y MODELO de la aeronave · MATRÍCULA · PILOTO · DESDE · HASTA · TIEMPOS · ATERRIZAJES.
La columna TIEMPOS tiene varias sub-columnas (instrucción doble comando, solo, travesía, nocturno, etc.). Un alumno anota casi siempre en las PRIMERAS sub-columnas; no asumas que el tiempo está en una posición fija: buscá en cuál de todas hay un número escrito en ese renglón.
Arriba a la derecha suele haber un recuadro "AÑO 20__". Al pie hay una fila de TOTALES escrita a mano.

REGLA MÁS IMPORTANTE
Ante la MENOR duda, poné null y agregá el nombre del campo a "dudosos" de ese renglón.
NO adivines. NO completes por contexto. NO infieras un valor porque "tiene sentido".
Un campo vacío lo corrige el piloto en dos segundos mirando su libro. Un campo inventado no lo revisa nadie y termina siendo una hora de vuelo que no existió. Preferimos veinte campos vacíos antes que uno inventado.

CÓMO LEER CADA COSA
- Fecha: devolvela como AAAA-MM-DD. Si el renglón sólo dice día y mes, usá el año del recuadro AÑO. Si no hay año en ningún lado, poné null y marcá "fecha" como dudoso.
- Matrícula: las argentinas son LV- seguido de tres o cuatro caracteres. Escribila en mayúsculas y con el guión.
- Tipo: transcribí lo que está escrito. Los más comunes en Argentina son C150, C152, C172, C182, PA-11, PA-25, AB-95, AB-115, AB-150, AB-180, PZL-104, TECNAM P2002. Si lo escrito se parece mucho a uno de esos pero no estás seguro, ponelo IGUAL y marcá "tipo" como dudoso — no lo corrijas en silencio.
- Aeródromos: transcribí exactamente lo que está escrito, sea código OACI (SADM), código local (MOR) o nombre (MORÓN). No traduzcas ni normalices.
- Horas: en decimal. 1:30 es 1.5, 0:45 es 0.75. Si está escrito como 1,5 con coma, es 1.5.
- Renglones vacíos: NO los devuelvas. Sólo los renglones que tienen algo escrito.

Devolvé el resultado en el formato JSON pedido.`;

// ── Llamada a Gemini ─────────────────────────────────────────────────────

async function leerConGemini(base64, mime) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("falta GEMINI_API_KEY en el entorno");

  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODELO,
      input: [
        { type: "text", text: PROMPT },
        { type: "image", data: base64, mime_type: mime }
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: ESQUEMA
      }
    })
  });

  const txt = await r.text();
  if (!r.ok) {
    // Se distingue "no se entendió la foto" de "el servicio no está
    // disponible", porque son dos problemas con dos soluciones distintas y
    // sólo una de ellas es del piloto.
    //
    // Salió de una prueba real: con la facturación de Google sin saldo, la
    // app le decía al piloto "probá con más luz". Mandarlo a sacar la foto de
    // nuevo diez veces por un problema de nuestra cuenta es la peor forma de
    // fallar — se cansa y abandona la función creyendo que no anda.
    const e = new Error(`Gemini HTTP ${r.status}: ${txt.slice(0, 300)}`);
    e.infraestructura = r.status === 401 || r.status === 403 || r.status === 429
                     || r.status >= 500;
    throw e;
  }

  // La respuesta trae el JSON pedido adentro de un sobre. Se busca el primer
  // string que parsee como objeto con `vuelos`, en vez de asumir una ruta
  // fija: si Google cambia la forma del sobre, esto sigue andando.
  let sobre;
  try { sobre = JSON.parse(txt); } catch { throw new Error("Gemini devolvió algo que no es JSON"); }

  const candidatos = [];
  (function buscar(n) {
    if (n === null || n === undefined) return;
    if (typeof n === "string") { candidatos.push(n); return; }
    if (Array.isArray(n)) { n.forEach(buscar); return; }
    if (typeof n === "object") {
      if (Array.isArray(n.vuelos)) candidatos.push(JSON.stringify(n));
      Object.values(n).forEach(buscar);
    }
  })(sobre);

  for (const c of candidatos) {
    try {
      const o = JSON.parse(c);
      if (o && Array.isArray(o.vuelos)) return o;
    } catch { /* seguir buscando */ }
  }
  throw new Error("no se encontró el JSON de vuelos en la respuesta");
}

// ── Cruces: acá es donde 95% se vuelve confiable ─────────────────────────

const TIPOS_CONOCIDOS = [
  "C150", "C152", "C172", "C177", "C182", "C206",
  "PA-11", "PA-12", "PA-18", "PA-25", "PA-28", "PA-38",
  "AB-95", "AB-115", "AB-150", "AB-180",
  "PZL-104", "P2002", "P92", "BRISTELL", "RV-6", "RV-7",
  "ZLIN", "T-35", "IA-46", "IA-50", "CH-7", "EXPLORER"
];

function normalizarTipo(t) {
  return (t || "").toUpperCase().replace(/[\s._]/g, "").replace(/-/g, "");
}

/// Marca campos dudosos que el modelo dio por buenos.
///
/// Cada regla acá responde a "esto se puede verificar sin saber qué escribió
/// el piloto". No se CORRIGE nada: se marca. Corregir en silencio es
/// exactamente el problema que estamos tratando de evitar.
function validar(datos) {
  const avisos = [];
  const vuelos = Array.isArray(datos.vuelos) ? datos.vuelos : [];

  const marcar = (v, campo, motivo) => {
    v.dudosos = Array.isArray(v.dudosos) ? v.dudosos : [];
    if (!v.dudosos.includes(campo)) v.dudosos.push(campo);
    v.motivos = v.motivos || {};
    v.motivos[campo] = motivo;
  };

  const tiposNorm = new Set(TIPOS_CONOCIDOS.map(normalizarTipo));

  for (const v of vuelos) {
    // Matrícula argentina: LV- y tres o cuatro caracteres.
    if (v.matricula && !/^LV-?[A-Z0-9]{3,4}$/i.test(v.matricula.replace(/\s/g, ""))) {
      marcar(v, "matricula", "no tiene forma de matrícula argentina (LV-XXX)");
    }

    // Tipo desconocido: se marca, NO se corrige. Un C150 cambiado a C152 en
    // silencio es un dato falso con apariencia de dato bueno.
    if (v.tipo && !tiposNorm.has(normalizarTipo(v.tipo))) {
      marcar(v, "tipo", "no coincide con ningún tipo habitual en Argentina");
    }

    // Duración contra la diferencia de horarios. Se admite cruce de
    // medianoche y medio grado de redondeo.
    const hhmm = s => {
      const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
      return m ? Number(m[1]) + Number(m[2]) / 60 : null;
    };
    const s = hhmm(v.salida), l = hhmm(v.llegada);
    if (s !== null && l !== null && typeof v.horas === "number") {
      let dif = l - s;
      if (dif < 0) dif += 24;
      if (Math.abs(dif - v.horas) > 0.2) {
        marcar(v, "horas", `no cierra con los horarios (${v.salida}→${v.llegada} son ${dif.toFixed(1)} h)`);
      }
    }

    // Duraciones imposibles para aviación general.
    if (typeof v.horas === "number" && (v.horas <= 0 || v.horas > 12)) {
      marcar(v, "horas", "duración fuera de lo posible");
    }

    // Fecha futura o absurda.
    if (v.fecha) {
      const d = new Date(v.fecha + "T12:00:00Z");
      if (isNaN(d) || d > new Date() || d.getUTCFullYear() < 1950) {
        marcar(v, "fecha", "fecha imposible");
      }
    }
  }

  // EL CRUCE BUENO: la suma contra el total que escribió el piloto.
  //
  // Es el único control que mira la hoja como un todo, y es el que atrapa el
  // error que más importa —una hora mal leída— sin necesitar saber nada del
  // piloto ni de sus vuelos.
  const suma = vuelos.reduce((a, v) => a + (typeof v.horas === "number" ? v.horas : 0), 0);
  if (typeof datos.totalPaginaHoras === "number" && datos.totalPaginaHoras > 0) {
    const dif = Math.abs(suma - datos.totalPaginaHoras);
    if (dif > 0.2) {
      avisos.push({
        tipo: "total_no_cierra",
        texto: `Los tiempos leídos suman ${suma.toFixed(1)} h y el total de la página dice `
             + `${datos.totalPaginaHoras.toFixed(1)} h. Hay al menos un renglón mal leído: `
             + `revisá las horas antes de guardar.`,
        suma, total: datos.totalPaginaHoras
      });
    } else {
      avisos.push({
        tipo: "total_cierra",
        texto: `La suma de los tiempos coincide con el total de la página (${suma.toFixed(1)} h).`,
        suma, total: datos.totalPaginaHoras
      });
    }
  } else {
    avisos.push({
      tipo: "sin_total",
      texto: "No se pudo leer el total de la página, así que no hay con qué verificar la suma. "
           + "Revisá las horas con más atención."
    });
  }

  const conDudas = vuelos.filter(v => (v.dudosos || []).length).length;
  if (conDudas) {
    avisos.push({
      tipo: "dudosos",
      texto: conDudas === 1
        ? "1 renglón tiene campos que no se leyeron con seguridad."
        : `${conDudas} renglones tienen campos que no se leyeron con seguridad.`
    });
  }

  return { vuelos, avisos };
}

// ── Ruta ─────────────────────────────────────────────────────────────────

export function montar(app) {
  // Parser propio y sólo para esta ruta: el global está en 64 kb, que es lo
  // correcto para el resto de la API y muy poco para una foto.
  const jsonGrande = express.json({ limit: "8mb" });

  app.post("/logbook/leer", jsonGrande, async (req, res) => {
    const t0 = Date.now();
    const { imagen, mime = "image/jpeg", dispositivo } = req.body || {};

    if (!dispositivo || typeof dispositivo !== "string") {
      return res.status(400).json({ error: "falta el identificador de dispositivo" });
    }
    if (!imagen || typeof imagen !== "string") {
      return res.status(400).json({ error: "falta la imagen" });
    }
    if (imagen.length * 0.75 > MAX_BYTES) {
      return res.status(413).json({ error: "la foto es demasiado grande", maxMB: MAX_BYTES / 1024 / 1024 });
    }
    if (!/^image\/(jpeg|png|heic|heif|webp)$/.test(mime)) {
      return res.status(415).json({ error: `tipo de imagen no soportado: ${mime}` });
    }

    try {
      // Cortacircuitos global antes que nada.
      if (contarGlobal() >= TOPE_DIARIO_GLOBAL) {
        return res.status(429).json({
          error: "cupo_diario",
          texto: "El servicio de lectura alcanzó su cupo de hoy. Probá mañana."
        });
      }

      const usadas = await usadasDe(dispositivo);
      if (usadas >= TOPE_DISPOSITIVO) {
        return res.status(429).json({
          error: "cupo_dispositivo",
          texto: `Llegaste al límite de ${TOPE_DISPOSITIVO} páginas. `
               + `Si te faltan hojas, escribinos y lo ampliamos.`,
          cuota: { usadas, limite: TOPE_DISPOSITIVO }
        });
      }

      const crudo = await leerConGemini(imagen, mime);
      const { vuelos, avisos } = validar(crudo);

      // Se descuenta recién acá: si falló la lectura, no se le cobra al
      // piloto una página de su cuota por un problema nuestro.
      await sumarUso(dispositivo);
      ultimoError = null;

      res.json({
        anio: crudo.anio ?? null,
        totalPaginaHoras: crudo.totalPaginaHoras ?? null,
        vuelos,
        avisos,
        modelo: MODELO,
        ms: Date.now() - t0,
        cuota: { usadas: usadas + 1, limite: TOPE_DISPOSITIVO }
      });
    } catch (e) {
      ultimoError = e.message;
      console.error("[logbook] fallo leyendo la página:", e.message);
      res.status(502).json(e.infraestructura
        ? {
            error: "servicio_no_disponible",
            texto: "El servicio de lectura no está disponible en este momento. "
                 + "No es tu foto: probá más tarde.",
            detalle: e.message
          }
        : {
            error: "no_se_pudo_leer",
            texto: "No se pudo leer la página. Probá con más luz, la hoja lo más "
                 + "plana posible y sin sombras.",
            detalle: e.message
          });
    }
  });

  // Cuánto le queda al dispositivo, para que la app lo muestre ANTES de que
  // el piloto saque la foto y no después.
  app.get("/logbook/cuota/:dispositivo", async (req, res) => {
    try {
      const usadas = await usadasDe(req.params.dispositivo);
      res.json({ usadas, limite: TOPE_DISPOSITIVO, restantes: Math.max(0, TOPE_DISPOSITIVO - usadas) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

export function estado() {
  return {
    modelo: MODELO,
    key: !!process.env.GEMINI_API_KEY,
    cuota_persistida: !!pool,
    leidas_total: leidasTotal,
    usadas_hoy: contarGlobal(),
    tope_diario: TOPE_DIARIO_GLOBAL,
    ultimo_error: ultimoError
  };
}
