/* Graph3D · seguimiento de metástasis cerebrales: interfaz.
   Casos de ejemplo: data/indice.js y data/p_<id>.js (los genera exportar_dashboard.py).
   Estudios nuevos: se envían a servidor.py (/api/analizar). */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const st = {
  pid: null, k: 0, lesion: null, modo: "lesiones", metrica: "vol",
  capas: { crecido: true, reducido: true, estable: true },   // zonas visibles en el modo "cambio"
  fijadas: new Set(),       // lesiones con su tarjeta fija en el 3D
  reproduciendo: null,
  hover: null,
  medida: "vol",            // cuadro de la lesión: "vol" (volumen + evolución) o "diam" (diámetro)              // lesión bajo el mouse en el 3D (el panel la muestra mientras tanto)
  verResonancia: false,      // en "Ubicación en el cerebro": mostrar la resonancia del paciente ubicada
};
window.DATOS = window.DATOS || {};

const C = {
  realce: "#3e9c78", diametro: "#e3a21a",
  serie: ["#1f5fae", "#4f9bd9", "#2c7a8c", "#7c93b3", "#9fbfe3", "#36507a", "#5fa8a0", "#a3b1c6", "#245a87"],
};

/* ---------- tema claro / oscuro ---------- */
function leerTema() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  Object.assign(C, {
    azul: v("--azul"), texto: v("--texto"), texto2: v("--texto-2"), texto3: v("--texto-3"), borde: v("--borde"), card: v("--card"),
    grilla: v("--grilla"), cabeza: v("--cabeza3d"), opCabeza: +v("--op-cabeza3d"), necrosis: v("--necrosis3d"),
    region: v("--region3d"), opRegion: +v("--op-region3d"), regionActiva: v("--region-activa3d"),
  });
}
function aplicarTema(t) {
  document.documentElement.dataset.tema = t;
  try { localStorage.setItem("tema", t); } catch { /* sin almacenamiento: solo esta sesión */ }
  leerTema();
  $("#tema").setAttribute("aria-label", t === "oscuro" ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
  $("#tema").innerHTML = t === "oscuro"
    ? `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>`
    : `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>`;
  if (st.pid && !$("#vista-paciente").hidden) renderTodo();
}

/* ---------- utilidades ---------- */
const vacio = (n) => n === null || n === undefined || Number.isNaN(n);
const fmt = (n, d = 1) => (vacio(n) ? "—" : Number(n).toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n) => (vacio(n) ? "—" : (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n), 0) + " %");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cambio = (a, b) => (vacio(a) || vacio(b) || b === 0 ? null : (100 * (a - b)) / b);

function tipoEstado(txt) {
  const t = (txt || "").toLowerCase();
  if (t.startsWith("progres") || t === "nueva") return "prog";
  if (t.startsWith("respuesta")) return "resp";
  if (t.startsWith("estable")) return "est";
  if (t.startsWith("sin lesiones")) return "aviso";
  return "basal";
}
function etiqueta(txt) {
  if (!txt) return "—";
  const t = txt.split(" (")[0];
  if (t === "NUEVA") return "Lesión nueva";
  if (t === "basal") return "Basal";
  if (t.startsWith("sin lesiones")) return "Sin lesiones medibles";
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const badge = (txt) => `<span class="badge b-${tipoEstado(txt)}">${esc(etiqueta(txt))}</span>`;
const tratCorto = (t) => (t.includes("SRS") ? "SRS" : t.includes("WBRT") ? "WBRT" : t.toLowerCase().includes("cirug") ? "Cirugía" : "Sistémico");
const primario = (p) => (p || "").replace(" no microcítico (NSCLC)", " (NSCLC)");

function cargando(txt) {
  const el = $("#cargando");
  el.innerHTML = txt ? `<span>${esc(txt)}</span>` : "";
  el.classList.toggle("visible", !!txt);
}

/* =====================================================================
   NAVEGACIÓN: Cargar estudios / Historial / Paciente
   ===================================================================== */
const API = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
let servidorOk = false;
let historialCargados = [];
let filtroOrigen = "todos";

function mostrarVista(v) {
  ["cargar", "historial", "paciente"].forEach((x) => ($(`#vista-${x}`).hidden = x !== v));
  cerrarMenu();
  if (v === "historial") renderHistorial();
  window.scrollTo(0, 0);
}

async function verificarServidor() {
  try {
    const r = await fetch(`${API}/api/estado`, { cache: "no-store" });
    servidorOk = r.ok;
  } catch { servidorOk = false; }
  // si abrieron el archivo con doble clic y el servidor está corriendo, pasar a la versión del servidor
  if (servidorOk && location.protocol === "file:") { location.replace(`http://localhost:8000/${location.hash}`); return; }
  const c = $("#conexion");
  c.classList.toggle("ok", servidorOk);
  c.textContent = servidorOk ? "Motor de análisis activo" : "Motor de análisis apagado";
  $("#aviso-servidor").hidden = servidorOk;
  if (servidorOk) await cargarHistorial();
  else setTimeout(verificarServidor, 3000);   // sigue probando: si se enciende el motor, la página se actualiza sola
}

async function cargarHistorial() {
  try {
    const r = await fetch(`${API}/api/historial`, { cache: "no-store" });
    historialCargados = r.ok ? await r.json() : [];
  } catch { historialCargados = []; }
  if (!$("#vista-historial").hidden) renderHistorial();
}

function itemsHistorial() {
  const cargados = historialCargados.map((p) => ({ ...p, origen: "cargado", clave: p.id }));
  const ejemplos = (window.INDICE || []).map((p) => ({ ...p, origen: "ejemplo", clave: p.paciente_id }));
  return [...cargados, ...ejemplos];
}

function renderHistorial() {
  const q = ($("#buscar").value || "").trim().toLowerCase();
  const todos = itemsHistorial();
  const items = todos.filter((p) => (filtroOrigen === "todos" || p.origen === filtroOrigen) &&
    (!q || [p.paciente_id, p.tumor_primario, etiqueta(p.vol_ultimo), p.fecha_carga, p.origen === "ejemplo" ? "ejemplo" : "cargado"]
      .join(" ").toLowerCase().includes(q)));
  const nCarg = todos.filter((p) => p.origen === "cargado").length;
  $("#hist-cuenta").textContent = `${todos.length} pacientes · ${nCarg} ${nCarg === 1 ? "cargado" : "cargados"} y ${todos.length - nCarg} de ejemplo`;
  const t = $("#tabla-historial");
  if (!items.length) { t.innerHTML = `<tr><td class="vacio">No hay pacientes que coincidan con la búsqueda.</td></tr>`; return; }
  t.innerHTML = `<tr><th>Paciente</th><th>Tumor primario</th><th class="num">Lesiones</th><th class="num">Controles</th>
      <th class="num">Seguimiento</th><th>Estado actual (volumétrico)</th><th></th></tr>` +
    items.map((p) => `<tr class="clic" data-clave="${esc(p.clave)}" data-origen="${p.origen}">
      <td><div class="origen"><b>${esc(p.paciente_id)}</b>${p.origen === "ejemplo" ? "Caso de ejemplo" : `Cargado el ${esc(p.fecha_carga)}`}</div></td>
      <td>${esc(primario(p.tumor_primario) || "—")}</td>
      <td class="num">${p.n_lesiones}</td><td class="num">${p.n_controles}</td>
      <td class="num">${p.dia_fin - p.dia_inicio} días</td>
      <td>${badge(p.vol_ultimo)}</td><td class="abrir">Abrir →</td></tr>`).join("");
  t.querySelectorAll("tr.clic").forEach((tr) => (tr.onclick = () =>
    tr.dataset.origen === "ejemplo" ? abrirEjemplo(tr.dataset.clave) : abrirCargado(tr.dataset.clave)));
}

function abrirEjemplo(pid) {
  if (window.DATOS[pid]) return abrirPaciente(pid);
  cargando("Cargando paciente…");
  const s = document.createElement("script");
  s.src = `data/p_${pid}.js`;
  s.onload = () => { cargando(null); abrirPaciente(pid); };
  s.onerror = () => { cargando(null); alert("No se encontraron los datos. Corré python exportar_dashboard.py"); };
  document.body.appendChild(s);
}

async function abrirCargado(id) {
  if (window.DATOS[id]) return abrirPaciente(id);
  cargando("Cargando paciente…");
  try {
    const r = await fetch(`${API}/api/paciente/${encodeURIComponent(id)}`);
    window.DATOS[id] = await r.json();
    cargando(null);
    abrirPaciente(id);
  } catch { cargando(null); alert("No se pudo abrir el análisis guardado."); }
}

/* ---------- carga de estudios ---------- */
let grupos = [];

function agruparArchivos(files) {
  const mapa = new Map();
  [...files].forEach((f) => {
    const nombre = f.name;
    if (!/\.nii(\.gz)?$/i.test(nombre)) return;
    const base = nombre.replace(/\.nii(\.gz)?$/i, "");
    const esMascara = /(seg|mask|label|segmentaci)/i.test(base);
    const clave = base.replace(/[_\-. ]?(seg|mask|label|segmentacion|segmentación|t1c|t1ce|t1gd|t1|img|imagen)$/i, "").toLowerCase();
    const g = mapa.get(clave) || { clave, nombre: base.replace(/[_\-. ]?(seg|mask|label|t1c|t1ce|t1gd|t1)$/i, "") };
    g[esMascara ? "mascara" : "imagen"] = f;
    mapa.set(clave, g);
  });
  const lista = [...mapa.values()];
  // día: a partir de una fecha AAAAMMDD en el nombre (relativa al primer control); si no hay, queda para completar
  const fechas = lista.map((g) => {
    const m = g.clave.match(/(\d{4})(\d{2})(\d{2})/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  });
  const conFecha = fechas.filter((f) => f !== null);
  const t0 = conFecha.length ? Math.min(...conFecha) : null;
  lista.forEach((g, i) => (g.dia = fechas[i] !== null ? Math.round((fechas[i] - t0) / 86400000) : null));
  lista.sort((a, b) => (a.dia ?? 1e9) - (b.dia ?? 1e9) || a.clave.localeCompare(b.clave));
  lista.forEach((g, i) => { if (g.dia === null) g.dia = i === 0 ? 0 : ""; });
  return lista;
}

function renderRevision(error) {
  const cont = $("#revision");
  if (!grupos.length) { cont.innerHTML = error ? `<div class="error">${esc(error)}</div>` : ""; return; }
  const completos = grupos.filter((g) => g.imagen && g.mascara);
  cont.innerHTML = `<div class="revision">
    <table class="revision-tabla">
      <tr><th>Control</th><th>Imagen</th><th>Segmentación</th><th>Día</th></tr>
      ${grupos.map((g, i) => `<tr>
        <td><div class="archivo">${esc(g.nombre)}</div></td>
        <td>${g.imagen ? '<span class="ok">✓</span>' : '<span class="falta">Falta</span>'}</td>
        <td>${g.mascara ? '<span class="ok">✓</span>' : '<span class="falta">Falta</span>'}</td>
        <td><input type="number" data-i="${i}" value="${g.dia}" ${g.imagen && g.mascara ? "" : "disabled"} aria-label="Día del control"></td>
      </tr>`).join("")}
    </table>
    <label class="campo">Identificador del paciente (opcional)<input id="nombre-paciente" placeholder="Ej.: Paciente 12"></label>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <div class="acciones">
      <span class="sub">${completos.length} ${completos.length === 1 ? "control completo" : "controles completos"}</span>
      <button class="btn" id="limpiar">Quitar</button>
      <button class="btn primario" id="analizar" ${completos.length ? "" : "disabled"}>Analizar</button>
    </div></div>`;
  cont.querySelectorAll("input[data-i]").forEach((inp) => (inp.oninput = () => (grupos[+inp.dataset.i].dia = inp.value)));
  $("#limpiar").onclick = () => { grupos = []; renderRevision(); };
  $("#analizar").onclick = analizar;
}

async function analizar() {
  const completos = grupos.filter((g) => g.imagen && g.mascara);
  if (completos.some((g) => g.dia === "" || Number.isNaN(+g.dia)))
    return renderRevision("Completá el día de cada control (días desde el primer estudio).");
  if (!servidorOk) await verificarServidor();
  if (!servidorOk) return renderRevision("El motor de análisis no está corriendo: abrí INICIAR.bat (o python servidor.py) y volvé a intentar.");
  const fd = new FormData();
  const nombre = ($("#nombre-paciente")?.value || "").trim() || "Paciente";
  fd.append("meta", JSON.stringify({ nombre, controles: completos.map((g) => ({ imagen: g.imagen.name, mascara: g.mascara.name, dia: +g.dia })) }));
  // se envía solo el nombre del archivo (sin la carpeta), así coincide con lo que se declara en "meta"
  completos.forEach((g) => { fd.append("archivos", g.imagen, g.imagen.name); fd.append("archivos", g.mascara, g.mascara.name); });
  cargando(`Analizando ${completos.length} ${completos.length === 1 ? "control" : "controles"}… puede tardar hasta un minuto.`);
  try {
    const resp = await fetch(`${API}/api/analizar`, { method: "POST", body: fd });
    const datos = await resp.json();
    cargando(null);
    if (!resp.ok) return renderRevision(datos.error || "No se pudieron procesar los archivos.");
    const id = datos.resumen.id;
    window.DATOS[id] = datos;
    grupos = []; renderRevision();
    cargarHistorial();
    abrirPaciente(id);
  } catch (e) {
    cargando(null);
    renderRevision("No se pudo conectar con el motor de análisis. ¿Está abierto INICIAR.bat?");
  }
}

function recibirArchivos(files) {
  grupos = agruparArchivos(files);
  renderRevision(grupos.length ? null : "No se encontraron archivos NIfTI (.nii o .nii.gz).");
}

/* =====================================================================
   PACIENTE
   ===================================================================== */
const D = () => window.DATOS[st.pid];
const ctrl = () => D().controles[st.k];
const lesionesPaciente = () => [...new Set(D().serie.map((s) => s.lesion))].sort((a, b) => +a.slice(1) - +b.slice(1));

function abrirPaciente(pid) {
  st.pid = pid;
  st.k = D().controles.length - 1;
  st.lesion = null;
  st.fijadas = new Set();
  st.hover = null;
  if (st.reproduciendo) reproducir();
  mostrarVista("paciente");
  const r = D().resumen;
  $("#pac-titulo").textContent = r.cargado ? r.paciente_id : `Paciente ${r.paciente_id}`;
  const partes = [r.tumor_primario && primario(r.tumor_primario), `${r.n_controles} controles`, `día ${r.dia_inicio} a ${r.dia_fin}`,
    r.fecha_carga && `cargado el ${r.fecha_carga}`];
  $("#pac-sub").textContent = partes.filter(Boolean).join(" · ");
  renderTodo();
  renderResumenPaciente();
}

function renderTodo() {
  const les = ctrl().lesiones;
  if (!les.some((l) => l.lesion === st.lesion)) st.lesion = les.length ? les[0].lesion : null;
  renderNavegador();
  renderAlertas();
  renderResumen();
  renderLineaTiempo();
  renderChips();
  render3D();
  renderPanel();
  renderEvolucion();
  renderTabla();
}

function irAControl(k) {
  st.k = Math.max(0, Math.min(D().controles.length - 1, k));
  renderTodo();
}

function renderNavegador() { /* el control actual se elige en la línea de tiempo */ }

function renderAlertas() {
  const c = ctrl(), r = c.rano, a = [];
  const nuevas = (r.lesiones_nuevas || "").split(", ").filter(Boolean);
  if (nuevas.length) a.push(`Lesión nueva en este control: <b>${nuevas.join(", ")}</b>.`);
  if (nuevas.length && conInmunoterapia())
    a.push("El paciente recibió <b>inmunoterapia</b>: RANO-BM exceptúa que una lesión nueva implique progresión. Interpretar con cautela.");
  (D().avisos || []).filter((t) => t.startsWith(`control ${c.n_estudio}:`)).forEach((t) => a.push(esc(t.replace(/^control \d+: /, "Aviso: "))));
  $("#alertas").innerHTML = a.map((t) => `<div class="alerta"><div>${t}</div></div>`).join("");
}

const conInmunoterapia = () => (D().tratamientos || []).some((t) =>
  /inmuno|\bIT\b|pd-?l?1|nivolumab|pembrolizumab|atezolizumab|durvalumab|ipilimumab/i.test(`${t.detalle || ""} ${t.tipo || ""}`));

/* Valores del paciente para basal / nadir (hasta el control anterior) / actual */
function historiaPaciente(campo) {
  const ctrls = D().controles.slice(0, st.k + 1).map((c) => c.rano[campo]);
  const actual = ctrls.at(-1), basal = ctrls[0], previos = ctrls.slice(0, -1);
  return { actual, basal, nadir: previos.length ? Math.min(...previos) : null };
}

function renderResumen() {
  const r = ctrl().rano, primero = st.k === 0;
  const d = historiaPaciente("suma_diam_mm"), v = historiaPaciente("suma_vol_cm3");
  const presentes = ctrl().lesiones.length;
  const variacion = (h) => (primero ? "Control de referencia (basal)"
    : `${pct(cambio(h.actual, h.basal))} vs. basal · ${pct(cambio(h.actual, h.nadir))} vs. nadir`);
  const tarjetas = [
    {
      etq: "Suma de diámetros", estado: null,
      valor: r.lesiones_diana ? `${fmt(d.actual)} <small>mm</small>` : `<small>Sin lesiones ≥ 10 mm</small>`,
      det: r.lesiones_diana ? "" : "Ninguna lesión llega a 10 mm.",
      regla: "Diámetro máximo axial de las lesiones diana (RANO-BM)",
    },
    {
      etq: "Volumétrico", estado: r.volumetrico,
      valor: `${fmt(v.actual, 2)} <small>cm³</small>`,
      det: `Volumen total · ${variacion(v)}`,
      regla: "Progresión: +30 % vs. nadir · Respuesta: −20 % vs. basal",
    },
    {
      etq: "Lesiones", estado: null,
      valor: `${presentes}`,
      det: presentes === 1 ? "lesión visible en este control" : "lesiones visibles en este control",
      regla: r.lesiones_nuevas ? `Nueva: ${esc(r.lesiones_nuevas)}` : "Sin lesiones nuevas",
    },
  ];
  $("#resumen").innerHTML = tarjetas.map((t) => `<div class="card">
      <div class="res-etq"><span>${t.etq}</span>${t.estado ? badge(t.estado) : ""}</div>
      <div class="res-valor">${t.valor}</div>
      <div class="res-det">${t.det}</div>
      <div class="res-regla">${t.regla}</div>
    </div>`).join("");
}

/* ---------- línea de tiempo ---------- */
function renderLineaTiempo() {
  const cont = $("#linea-tiempo");
  const W = Math.max(cont.clientWidth, 280), angosto = W < 560, izq = angosto ? 70 : 92, der = 14;
  const ctrls = D().controles;
  const d0 = Math.min(...ctrls.map((c) => c.dia)), d1 = Math.max(...ctrls.map((c) => c.dia));
  const pad = Math.max(20, (d1 - d0) * 0.04), desde = d0 - pad, hasta = d1 + pad;
  const x = (d) => izq + ((Math.min(Math.max(d, desde), hasta) - desde) / (hasta - desde)) * (W - izq - der);

  const trats = D().tratamientos.filter((t) => t.dia_inicio !== null && (t.dia_fin ?? t.dia_inicio) >= desde && t.dia_inicio <= hasta);
  const filas = ["Resonancias", "SRS", "WBRT", "Cirugía", "Sistémico"].filter((f, i) => i === 0 || trats.some((t) => tratCorto(t.tipo) === f));
  const y = (f) => 30 + filas.indexOf(f) * 28;
  const H = 30 + filas.length * 28;

  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Línea de tiempo">`;
  filas.forEach((f) => {
    s += `<text x="0" y="${y(f) + 4}" font-size="12" fill="${C.texto3}">${f}</text>`;
    s += `<line x1="${izq}" x2="${W - der}" y1="${y(f)}" y2="${y(f)}" stroke="${C.borde}"/>`;
  });
  const n = angosto ? 4 : 8;
  const paso = [30, 60, 90, 180, 365, 730, 1460].find((p) => (hasta - desde) / p <= n) || 1460;
  for (let d = Math.ceil(desde / paso) * paso; d <= hasta; d += paso)
    s += `<text x="${x(d)}" y="11" font-size="10.5" fill="${C.texto3}" text-anchor="middle">día ${d}</text>`;

  trats.forEach((t) => {
    const f = tratCorto(t.tipo), yy = y(f), x1 = x(t.dia_inicio), x2 = x(t.dia_fin ?? t.dia_inicio);
    const tit = esc(`${t.tipo}${t.detalle ? " · " + t.detalle : ""} · día ${t.dia_inicio}${t.dia_fin ? "–" + t.dia_fin : ""}`);
    const col = f === "Sistémico" ? "#a9bdd6" : C.azul;
    s += x2 - x1 > 6
      ? `<rect x="${x1}" y="${yy - 4}" width="${x2 - x1}" height="8" rx="4" fill="${col}" opacity="${f === "Sistémico" ? 0.6 : 0.85}"><title>${tit}</title></rect>`
      : `<rect x="${x1 - 4.5}" y="${yy - 4.5}" width="9" height="9" rx="2" transform="rotate(45 ${x1} ${yy})" fill="${col}"><title>${tit}</title></rect>`;
  });

  const yR = y("Resonancias");
  ctrls.forEach((c, k) => {
    const sel = k === st.k, xc = x(c.dia);
    const color = { prog: "#c2463d", resp: "#2e7d5b", est: "#4a6787", basal: "#6b7787", aviso: "#96620a" }[tipoEstado(c.rano.volumetrico)];
    s += `<g class="lt-control" data-k="${k}"><title>Control ${c.n_estudio} · día ${c.dia} · ${esc(etiqueta(c.rano.volumetrico))}</title>
      <rect x="${xc - 12}" y="${yR - 14}" width="24" height="28" fill="transparent"/>
      ${sel ? `<line x1="${xc}" x2="${xc}" y1="${yR}" y2="${H}" stroke="${C.azul}" stroke-dasharray="3 3"/>` : ""}
      <circle cx="${xc}" cy="${yR}" r="${sel ? 9 : 6.5}" fill="#fff" stroke="${sel ? C.azul : "#cfd8e3"}" stroke-width="${sel ? 2.5 : 1.5}"/>
      <circle cx="${xc}" cy="${yR}" r="${sel ? 4.5 : 3.2}" fill="${color}"/></g>`;
  });
  cont.innerHTML = s + "</svg>";
  cont.querySelectorAll(".lt-control").forEach((g) => (g.onclick = () => irAControl(+g.dataset.k)));
}

/* ---------- 3D ---------- */
/* Evolución temporal de cada lesión (colores pedidos por el equipo clínico) */
const EVO = {
  nueva: { color: "#e5484d", txt: "Nueva", sig: "Primera vez que aparece: actividad reciente" },
  aumento: { color: "#f5803e", txt: "En aumento", sig: "Progresión o expansión de una lesión previa" },
  estable: { color: "#30a46c", txt: "Estable", sig: "Sin cambios que superen los umbrales" },
  disminucion: { color: "#3b7bdb", txt: "En disminución", sig: "Respuesta parcial o remisión" },
};
function evolucion(estado) {
  const e = (estado || "").toLowerCase();
  if (e === "basal" || e === "nueva") return "nueva";
  if (e.startsWith("progres")) return "aumento";
  if (e.startsWith("respuesta")) return "disminucion";
  return "estable";
}
const evoLesion = (l) => evolucion(l.estado === "basal" || l.estado === "NUEVA" ? l.estado : l.clase_volumen);
const puntoEvo = (clave) => `<span class="evo"><i style="background:${EVO[clave].color}"></i>${EVO[clave].txt}</span>`;

function renderChips() {
  const c = ctrl(), presentes = new Map(c.lesiones.map((l) => [l.lesion, l]));
  $("#chips-lesiones").innerHTML = lesionesPaciente().map((L) => {
    const l = presentes.get(L);
    return `<button class="chip-lesion ${L === st.lesion ? "activo" : ""}" data-l="${L}" ${l ? "" : "disabled title='No visible en este control'"}>
      ${l ? `<i style="background:${EVO[evoLesion(l)].color}"></i>` : ""}${L}</button>`;
  }).join("");
  $$(".chip-lesion").forEach((b) => (b.onclick = () => seleccionarLesion(b.dataset.l)));
}

function seleccionarLesion(L) {
  st.lesion = L;
  st.hover = null;
  renderChips(); render3D(); renderPanel(); renderTabla(); renderEvolucion();
}

function malla(m, color, opacidad, meta, hover, extra = {}) {
  return {
    type: "mesh3d", x: m.x, y: m.y, z: m.z, i: m.i, j: m.j, k: m.k, color, opacity: opacidad, meta, flatshading: false,
    showlegend: false, hoverinfo: hover ? "text" : "skip", text: hover, hovertemplate: hover ? "%{text}<extra></extra>" : undefined,
    lighting: { ambient: 0.6, diffuse: 0.7, specular: 0.08, roughness: 0.7, fresnel: 0.05 }, lightposition: { x: 100, y: 200, z: 150 },
    ...extra,
  };
}

/* Texto de una lesión: el mismo para la tarjeta del mouse y para la tarjeta fija */
function fichaLesion(l, conPista) {
  const base = l.estado === "basal" || l.estado === "NUEVA";
  const evo = EVO[evoLesion(l)];
  return `<b>${l.lesion}</b>  <span style="color:${evo.color}">●</span> ${evo.txt}<br>` +
    `Volumen ${fmt(l.total_cm3, 2)} cm³${base ? "" : ` (${pct(l.cambio_vs_anterior_pct)} vs. anterior)`}<br>` +
    `Diámetro RANO-BM ${fmt(l.diam_rano_mm)} mm · necrosis ${fmt(l.necrosis_pct, 0)} %<br>` +
    `<span style="color:${C.texto3}">${esc(l.hemisferio)}, ${esc(l.region_aprox)}${conPista ? " · clic para fijar" : ""}</span>`;
}

const CAPA_CAMBIO = [["crecido", "Zona que creció"], ["reducido", "Zona que se redujo"], ["estable", "Sin cambio"]];
const colorZona = (z) => ({ crecido: EVO.aumento.color, reducido: EVO.disminucion.color, estable: C.cabeza }[z]);
const opZona = (z) => ({ crecido: 0.9, reducido: 0.75, estable: 0.4 }[z]);

function dibujar3D(trazas, anotaciones, camara) {
  const eje = { visible: false, showgrid: false, zeroline: false, showbackground: false };
  Plotly.react("vista3d", trazas, {
    uirevision: `${st.pid}-${st.modo === "cerebro" ? "cerebro" : "paciente"}`, margin: { l: 0, r: 0, t: 0, b: 0 }, paper_bgcolor: "rgba(0,0,0,0)",
    scene: { xaxis: eje, yaxis: eje, zaxis: eje, aspectmode: "data", camera: camara || { eye: { x: 0.95, y: -0.95, z: 0.55 } }, annotations: anotaciones },
    hoverlabel: { bgcolor: C.card, bordercolor: C.borde, align: "left", font: { family: "Inter, system-ui", color: C.texto, size: 12 } },
  }, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["resetCameraLastSave3d", "hoverClosest3d", "toImage"] });
}

function tarjetaFija(l, x, y, z, i) {
  return {
    x, y, z, text: fichaLesion(l, false), align: "left", showarrow: true, arrowhead: 0, arrowwidth: 1.2, arrowcolor: C.texto3,
    ax: 70, ay: -60 - 18 * i, bgcolor: C.card, bordercolor: C.borde, borderwidth: 1, borderpad: 7,
    font: { family: "Inter, system-ui", size: 11.5, color: C.texto },
  };
}

function eventos3D() {
  const div = $("#vista3d");
  if (div.removeAllListeners) ["plotly_click", "plotly_hover", "plotly_unhover"].forEach((ev) => div.removeAllListeners(ev));
  // pasar el mouse: el panel de la derecha muestra esa lesión
  div.on("plotly_hover", (e) => {
    const m = e.points?.[0]?.data.meta;
    if (m && m !== st.hover) { st.hover = m; renderPanel(); }
  });
  div.on("plotly_unhover", () => { if (st.hover) { st.hover = null; renderPanel(); } });
  // clic (sin arrastrar): selecciona la lesión y fija / suelta su tarjeta
  div.on("plotly_click", (e) => {
    const m = e.points?.[0]?.data.meta;
    if (!m) return;
    st.fijadas.has(m) ? st.fijadas.delete(m) : st.fijadas.add(m);
    seleccionarLesion(m);
  });
}

function render3D() {
  const planos = st.modo === "cerebro";
  $("#vista3d").hidden = planos;
  $("#planos").hidden = !planos;
  if (planos) { renderPlanos(); sincronizarDeslizador(); return; }
  const c = ctrl(), trazas = [malla(D().cabeza, C.cabeza, C.opCabeza, null, null)], anot = [];
  const modoCambio = st.modo === "cambio" && c.cambio;

  if (modoCambio) {
    CAPA_CAMBIO.forEach(([z, txt]) => { if (st.capas[z] && c.cambio[z]) trazas.push(malla(c.cambio[z], colorZona(z), opZona(z), null, txt)); });
  } else {
    c.lesiones.forEach((l) => {
      const sel = l.lesion === st.lesion, hover = fichaLesion(l, !st.fijadas.has(l.lesion)), col = EVO[evoLesion(l)].color;
      if (l.malla_realce) trazas.push(malla(l.malla_realce, col, sel ? 0.55 : 0.35, l.lesion, hover));
      if (l.malla_necrosis) trazas.push(malla(l.malla_necrosis, C.necrosis, sel ? 0.95 : 0.6, l.lesion, hover));
      if (sel && l.rano_p1) trazas.push({
        type: "scatter3d", mode: "lines+markers", x: [l.rano_p1[0], l.rano_p2[0]], y: [l.rano_p1[1], l.rano_p2[1]], z: [l.rano_p1[2], l.rano_p2[2]],
        line: { color: C.diametro, width: 7 }, marker: { size: 3, color: C.diametro }, showlegend: false,
        hoverinfo: "text", text: `Diámetro RANO-BM ${fmt(l.diam_rano_mm)} mm`, hovertemplate: "%{text}<extra></extra>",
      });
    });
  }
  c.lesiones.filter((l) => st.fijadas.has(l.lesion)).forEach((l, i) => anot.push(tarjetaFija(l, l.centro_x_mm, l.centro_y_mm, l.centro_z_mm, i)));
  const les = c.lesiones.filter((l) => !st.fijadas.has(l.lesion));
  if (les.length) trazas.push({
    type: "scatter3d", mode: "text", x: les.map((l) => l.centro_x_mm), y: les.map((l) => l.centro_y_mm),
    z: les.map((l) => l.centro_z_mm + Math.max(6, l.diam_3d_mm * 0.6)), text: les.map((l) => l.lesion),
    textfont: { size: 12, color: C.texto2 }, hoverinfo: "skip", showlegend: false,
  });
  dibujar3D(trazas, anot);
  Plotly.Plots.resize("vista3d");
  eventos3D();

  const ley = $("#leyenda-3d");
  if (st.modo === "cambio" && !c.cambio) {
    ley.innerHTML = `<span>Es el primer control: no hay uno anterior para comparar.</span>`;
  } else if (modoCambio) {
    const prev = D().controles[st.k - 1];
    ley.innerHTML = CAPA_CAMBIO.map(([z, txt]) => `<button class="capa ${st.capas[z] ? "activa" : ""}" data-z="${z}" aria-pressed="${st.capas[z]}">
        <i style="background:${colorZona(z)}"></i>${txt}</button>`).join("") +
      `<span class="ley-nota">Día ${prev.dia} → día ${c.dia} · tocá cada zona para mostrarla u ocultarla</span>`;
    ley.querySelectorAll(".capa").forEach((b) => (b.onclick = () => { st.capas[b.dataset.z] = !st.capas[b.dataset.z]; render3D(); }));
  } else {
    ley.innerHTML = Object.keys(EVO).map((k) => `<span title="${EVO[k].sig}"><i style="background:${EVO[k].color}"></i>${EVO[k].txt}</span>`).join("") +
      `<span><i style="background:${C.necrosis}"></i>Necrosis</span><span><i class="linea" style="background:${C.diametro}"></i>Diámetro RANO-BM</span>` +
      `<span class="ley-nota">Pasá el mouse por una lesión para ver sus datos · clic para seleccionarla y fijarlos</span>`;
  }
  sincronizarDeslizador();
}

/* ---------- vista "Ubicación en el cerebro": cortes sagital, coronal y axial ----------
   Cerebro de referencia (MNI152) con cada región pintada de un color. Las lesiones del paciente se ubican en la
   misma posición relativa que ocupan dentro de su propio cerebro. Los cortes pasan por la lesión seleccionada. */
const COLOR_REGION = {
  Frontal: "#7fb0e6", Parietal: "#86cfa1", Temporal: "#f2bd7f", Occipital: "#c3a3e6",
  Profunda: "#ee9a9a", Cerebelo: "#8fd0cf", Tronco: "#d8c59a",
};
const NOMBRE_REGION = { Frontal: "lóbulo frontal", Parietal: "lóbulo parietal", Temporal: "lóbulo temporal", Occipital: "lóbulo occipital",
  Profunda: "región profunda (ganglios basales / tálamo)", Cerebelo: "cerebelo", Tronco: "tronco encefálico" };
let VOL = null;

function volumenAtlas() {
  if (VOL || !window.ATLAS_VOL) return VOL;
  const a = window.ATLAS_VOL, bin = atob(a.datos), datos = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) datos[i] = bin.charCodeAt(i);
  const [nx, ny, nz] = a.forma, A = a.affine;
  VOL = {
    datos, nx, ny, nz, regiones: a.regiones,
    aVox: (x, y, z) => [Math.round((x - A[0][3]) / A[0][0]), Math.round((y - A[1][3]) / A[1][1]), Math.round((z - A[2][3]) / A[2][2])],
    aMm: (i, j, k) => [A[0][3] + i * A[0][0], A[1][3] + j * A[1][1], A[2][3] + k * A[2][2]],
    en: (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : datos[(i * ny + j) * nz + k]),
  };
  return VOL;
}

function hexRGB(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

/* Las 3 vistas: qué eje queda fijo y cómo se dibujan (convención radiológica: derecha del paciente a la izquierda) */
const VISTAS = [
  { id: "sagital", titulo: "Sagital", ejes: "y · z", fijo: 0, h: 1, v: 2, invH: false, izq: "P", der: "A" },
  { id: "coronal", titulo: "Coronal", ejes: "x · z", fijo: 1, h: 0, v: 2, invH: true, izq: "D", der: "I" },
  { id: "axial", titulo: "Axial", ejes: "x · y", fijo: 2, h: 0, v: 1, invH: true, izq: "D", der: "I" },
];

function renderPlanos() {
  const cont = $("#planos"), V = volumenAtlas(), c = ctrl();
  if (!V) { cont.innerHTML = `<div class="vacio">Falta el cerebro de referencia: volvé a correr python exportar_dashboard.py</div>`; return; }
  const sel = c.lesiones.find((l) => l.lesion === (st.hover || st.lesion)) || c.lesiones[0];
  const centro = sel ? [sel.mni_x, sel.mni_y, sel.mni_z] : [0, -18, 18];
  const vc = V.aVox(...centro);
  const regionesConLesion = new Set(c.lesiones.map((l) => Object.keys(NOMBRE_REGION).find((r) => NOMBRE_REGION[r] === l.region_aprox)));
  const oscuro = document.documentElement.dataset.tema === "oscuro";

  cont.innerHTML = `<div class="planos-grid">${VISTAS.map((v) => `<figure class="plano">
      <figcaption><b>${v.titulo}</b> <span>${v.ejes}</span></figcaption>
      <canvas data-v="${v.id}"></canvas></figure>`).join("")}
    <div class="plano planos-leyenda"><div class="etq">Regiones</div>${Object.keys(COLOR_REGION).map((r) => `<span class="${regionesConLesion.has(r) ? "con" : ""}">
      <i style="background:${COLOR_REGION[r]}"></i>${NOMBRE_REGION[r].split(" (")[0].replace(/^./, (x) => x.toUpperCase())}</span>`).join("")}
      <p class="criterio-regla">Color pleno: regiones con lesiones del paciente. Círculos: lesiones con el color de su evolución (tamaño según volumen).</p></div></div>`;

  const dims = [V.nx, V.ny, V.nz];
  VISTAS.forEach((v) => {
    const cv = cont.querySelector(`canvas[data-v="${v.id}"]`);
    const W = dims[v.h], H = dims[v.v], esc_ = 3;
    cv.width = W * esc_; cv.height = H * esc_;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
    const fondo = oscuro ? [18, 24, 32] : [251, 252, 254];
    for (let a = 0; a < W; a++) for (let b = 0; b < H; b++) {
      const idx = [0, 0, 0];
      idx[v.fijo] = vc[v.fijo]; idx[v.h] = v.invH ? W - 1 - a : a; idx[v.v] = H - 1 - b;
      const cod = V.en(...idx), p = (b * W + a) * 4;
      let rgb = fondo, alfa = 255;
      if (cod > 0) {
        const reg = V.regiones[Math.floor((cod - 1) / 2)];
        const base = hexRGB(COLOR_REGION[reg]), fuerte = regionesConLesion.has(reg);
        const mezcla = fuerte ? 0.95 : 0.35;   // las regiones sin lesiones quedan más suaves
        rgb = base.map((x, i) => Math.round(x * mezcla + fondo[i] * (1 - mezcla)));
      }
      img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = alfa;
    }
    // se dibuja a escala 1 en un lienzo auxiliar y se agranda (bordes suaves)
    const aux = document.createElement("canvas"); aux.width = W; aux.height = H; aux.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(aux, 0, 0, W * esc_, H * esc_);
    const aPix = (mm) => {
      const vx = V.aVox(...mm);
      return [((v.invH ? W - 1 - vx[v.h] : vx[v.h]) + 0.5) * esc_, (H - 1 - vx[v.v] + 0.5) * esc_];
    };
    // línea de referencia por la lesión seleccionada
    if (sel) {
      const [px, py] = aPix(centro);
      ctx.strokeStyle = oscuro ? "rgba(230,235,241,.35)" : "rgba(24,33,47,.25)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H * esc_); ctx.moveTo(0, py); ctx.lineTo(W * esc_, py); ctx.stroke(); ctx.setLineDash([]);
    }
    // lesiones: círculo con el color de su evolución (las que están lejos del corte, más transparentes)
    v.puntos = c.lesiones.map((l) => {
      const mm = [l.mni_x, l.mni_y, l.mni_z], [px, py] = aPix(mm);
      const r = Math.max(5, Math.cbrt(l.total_cm3) * 9), lejos = Math.abs(mm[v.fijo] - centro[v.fijo]) > 12;
      ctx.globalAlpha = lejos ? 0.45 : 1;
      ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI); ctx.fillStyle = EVO[evoLesion(l)].color; ctx.fill();
      ctx.lineWidth = l === sel ? 3 : 1.5; ctx.strokeStyle = l === sel ? (oscuro ? "#fff" : "#18212f") : "#fff"; ctx.stroke();
      ctx.globalAlpha = 1; ctx.font = "600 13px Inter, system-ui"; ctx.fillStyle = oscuro ? "#e6ebf1" : "#18212f";
      ctx.fillText(l.lesion, px + r + 4, py + 4);
      return { l, px, py, r };
    });
    ctx.font = "600 12px Inter, system-ui"; ctx.fillStyle = oscuro ? "#7d8a9a" : "#8592a3";
    ctx.fillText(v.izq, 8, H * esc_ / 2); ctx.fillText(v.der, W * esc_ - 16, H * esc_ / 2);
    ctx.fillText(v.id === "axial" ? "A" : "S", W * esc_ / 2 - 4, 16);

    // mouse: pasar por arriba muestra la lesión en el panel; clic la selecciona
    const buscar = (e) => {
      const b = cv.getBoundingClientRect(), x = ((e.clientX - b.left) / b.width) * cv.width, y = ((e.clientY - b.top) / b.height) * cv.height;
      return v.puntos.find((q) => Math.hypot(q.px - x, q.py - y) <= q.r + 6);
    };
    cv.onmousemove = (e) => {
      const q = buscar(e), L = q ? q.l.lesion : null;
      cv.style.cursor = q ? "pointer" : "default";
      cv.title = q ? `${q.l.lesion} · ${EVO[evoLesion(q.l)].txt} · ${q.l.region_aprox}` : "";
      if (L !== st.hover) { st.hover = L; renderPanel(); }
    };
    cv.onmouseleave = () => { if (st.hover) { st.hover = null; renderPanel(); } };
    cv.onclick = (e) => { const q = buscar(e); if (q) seleccionarLesion(q.l.lesion); };
  });

  $("#leyenda-3d").innerHTML = Object.keys(EVO).map((k) => `<span><i style="background:${EVO[k].color}"></i>${EVO[k].txt}</span>`).join("") +
    `<span class="ley-nota">Cerebro de referencia (MNI152). Los cortes pasan por ${sel ? sel.lesion : "el centro"}; ` +
    `las regiones con lesiones tienen color pleno. Ubicación aproximada.</span>`;
}

/* ---------- recorrido en el tiempo ----------
   Cuadros: cada control y, entre dos controles, formas intermedias calculadas por interpolación. */
function cuadros() {
  const lista = [];
  D().controles.forEach((c, k) => {
    lista.push({ k, control: true });
    (c.transicion || []).forEach((t) => lista.push({ k, control: false, t }));
  });
  return lista;
}

function sincronizarDeslizador() {
  const cs = cuadros(), sl = $("#deslizador");
  sl.max = cs.length - 1;
  const i = cs.findIndex((f) => f.control && f.k === st.k);
  if (!st.reproduciendo || +sl.value !== i) sl.value = i;
  $("#marcas").innerHTML = cs.map((f, j) => f.control
    ? `<button data-j="${j}" class="${f.k === st.k ? "activa" : ""}" style="left:${cs.length > 1 ? (100 * j) / (cs.length - 1) : 0}%">día ${D().controles[f.k].dia}</button>` : "").join("");
  $$("#marcas button").forEach((b) => (b.onclick = () => irACuadro(+b.dataset.j)));
  etiquetaRecorrido(cs[i]);
}

function etiquetaRecorrido(f) {
  const c = D().controles[f.k];
  if (f.control) { $("#recorrido-etq").innerHTML = `<b>Día ${c.dia}</b>Control ${c.n_estudio}`; return; }
  const sig = D().controles[f.k + 1];
  $("#recorrido-etq").innerHTML = `<b>≈ día ${Math.round(c.dia + f.t.alfa * (sig.dia - c.dia))}</b>Entre control ${c.n_estudio} y ${sig.n_estudio}`;
}

function irACuadro(j) {
  const cs = cuadros(), f = cs[Math.max(0, Math.min(cs.length - 1, j))];
  $("#deslizador").value = cs.indexOf(f);
  if (f.control) {
    if (f.k !== st.k) { st.k = f.k; renderTodo(); } else render3D();
    return;
  }
  // forma intermedia: el resto de la pantalla muestra el control de partida; el 3D, la forma interpolada
  if (f.k !== st.k) { st.k = f.k; renderTodo(); $("#deslizador").value = cs.indexOf(f); }
  if (st.modo === "cerebro") { etiquetaRecorrido(f); return; }
  const trazas = [malla(D().cabeza, C.cabeza, C.opCabeza, null, null)];
  if (f.t.total) trazas.push(malla(f.t.total, "#5b8fd1", 0.5, null, null));
  if (f.t.necrosis) trazas.push(malla(f.t.necrosis, C.necrosis, 0.9, null, null));
  dibujar3D(trazas, []);
  etiquetaRecorrido(f);
}

let pendiente = null;
$("#deslizador").addEventListener("input", (e) => {
  const j = +e.target.value;
  if (pendiente) cancelAnimationFrame(pendiente);
  pendiente = requestAnimationFrame(() => irACuadro(j));
});

function reproducir() {
  const sl = $("#deslizador");
  if (st.reproduciendo) { clearInterval(st.reproduciendo); st.reproduciendo = null; $("#play").textContent = "▶"; return; }
  if (+sl.value >= +sl.max) irACuadro(0);
  $("#play").textContent = "❚❚";
  st.reproduciendo = setInterval(() => {
    const j = +sl.value + 1;
    if (j > +sl.max) return reproducir();
    irACuadro(j);
  }, 260);
}
$("#play").onclick = reproducir;

/* ---------- panel de la lesión ---------- */
function historiaLesion(L) {
  const pts = D().serie.filter((s) => s.lesion === L && s.estado !== "todavía no aparece" && s.n_estudio <= ctrl().n_estudio)
    .sort((a, b) => a.n_estudio - b.n_estudio);
  const actual = pts.at(-1), basal = pts[0], previos = pts.slice(0, -1);
  const minPor = (campo) => previos.length ? previos.reduce((m, p) => (p[campo] < m[campo] ? p : m)) : null;
  return { actual, basal, nadirV: minPor("total_cm3"), nadirD: minPor("diam_rano_mm"), hayPrevios: previos.length > 0 };
}

function motivoDiametro(l, h) {
  const d = l.diam_rano_mm, b = h.basal.diam_rano_mm, n = h.nadirD?.diam_rano_mm;
  switch (l.clase_diametro) {
    case "progresión": return `Creció ${fmt(d - n)} mm (${pct(cambio(d, n))}) desde el nadir.`;
    case "respuesta parcial": return `Bajó ${pct(cambio(d, b))} desde el basal.`;
    case "respuesta completa": return "No es visible en este control.";
    default:
      return Math.max(d, n) < 10 ? `Lesión menor a 10 mm: cambió menos de 3 mm.`
        : `${pct(cambio(d, b))} vs. basal y ${pct(cambio(d, n))} vs. nadir: no alcanza ningún umbral.`;
  }
}
function motivoVolumen(l, h) {
  const v = l.total_cm3, b = h.basal.total_cm3, n = h.nadirV?.total_cm3;
  switch (l.clase_volumen) {
    case "progresión": return `Creció ${pct(cambio(v, n))} (${fmt(v - n, 2)} cm³) desde el nadir.`;
    case "respuesta parcial": return `Bajó ${pct(cambio(v, b))} desde el basal.`;
    case "respuesta completa": return "No es visible en este control.";
    default: return `${pct(cambio(v, b))} vs. basal y ${pct(cambio(v, n))} vs. nadir: no alcanza ningún umbral.`;
  }
}

function renderPanel() {
  const panel = $("#panel-lesion"), c = ctrl();
  const l = c.lesiones.find((x) => x.lesion === (st.hover || st.lesion));
  if (!l) { panel.innerHTML = `<div class="vacio">No hay lesiones visibles en este control.</div>`; return; }
  const h = historiaLesion(l.lesion);
  const esBase = !h.hayPrevios;

  const medida = (etq, val, det) => `<div class="medida"><div class="medida-etq">${etq}</div><div class="medida-val">${val}</div><div class="medida-det">${det}</div></div>`;
  const celda = (p, campo, dec, actual) => p ? `<td class="${actual ? "actual" : ""}">${fmt(p[campo], dec)}<span class="dia">día ${p.dia}</span></td>` : `<td>—</td>`;

  const comparacion = esBase ? `<p class="nota-chica">Es el primer control de esta lesión: queda como <b>referencia (basal)</b> para los siguientes.</p>` : `
    <table class="comparacion">
      <tr><th></th><th>Basal</th><th>Nadir</th><th>Actual</th></tr>
      <tr><td>Volumen (cm³)</td>${celda(h.basal, "total_cm3", 2)}${celda(h.nadirV, "total_cm3", 2)}${celda(h.actual, "total_cm3", 2, true)}</tr>
      <tr><td>Diámetro (mm)</td>${celda(h.basal, "diam_rano_mm", 1)}${celda(h.nadirD, "diam_rano_mm", 1)}${celda(h.actual, "diam_rano_mm", 1, true)}</tr>
    </table>`;

  const criterios = esBase ? "" : `
    <div>
      <div class="etq">Evaluación</div>
      <div class="criterio">
        <div class="criterio-cab"><span>Volumétrico (Ocaña-Tienda)</span>${badge(l.clase_volumen)}</div>
        <div class="criterio-por">${motivoVolumen(l, h)}</div>
      </div>
      ${l.cambio_concluyente === false ? `<p class="criterio-regla">No concluyente: con el volumen mínimo y el máximo la clasificación da distinto (${esc(l.clase_volumen_rango)}).</p>` : ""}
    </div>`;

  const ritmo = vacio(l.crec_pct_por_mes) ? "" :
    `<p class="nota-chica">Ritmo actual: <b>${pct(l.crec_pct_por_mes)} por mes</b>${l.dias_duplicar_o_mitad ? ` (${l.crec_pct_por_mes > 0 ? "duplicaría" : "se reduciría a la mitad"} en ~${fmt(l.dias_duplicar_o_mitad, 0)} días)` : ""}. Extrapolación, no predicción.</p>`;

  panel.innerHTML = `
    <div class="panel-cab">
      <div><div class="panel-titulo">Lesión ${l.lesion}${st.hover ? ' <span class="sub">· bajo el cursor</span>' : ""}</div>
        <div class="sub">${esc(l.hemisferio)} · ${esc(l.region_aprox)} (aprox.)</div></div>
    </div>
    <div class="segmentado selector-medida" role="tablist" aria-label="Medida">
      <button data-m="vol" class="${st.medida === "vol" ? "activo" : ""}">Volumen</button>
      <button data-m="diam" class="${st.medida === "diam" ? "activo" : ""}">Diámetro</button>
    </div>
    ${st.medida === "diam" ? `
    <div class="medida medida-diam">
      <div class="medida-etq">Diámetro RANO-BM</div>
      <div class="medida-val">${fmt(l.diam_rano_mm)} <small>mm</small></div>
      <div class="medida-det">${l.medible_rano ? "Lesión medible" : "No medible (&lt;10 mm, &lt;5 mm perpendicular o &lt;2 cortes)"} · contorno externo (realce + necrosis)</div>
      <div class="diam-grilla">
        <div><span>Perpendicular</span><b>${fmt(l.diam_perp_mm)} mm</b></div>
        <div><span>Solo realce</span><b>${fmt(l.diam_realce_mm)} mm</b></div>
        <div><span>Máximo 3D</span><b>${fmt(l.diam_3d_mm)} mm</b></div>
        <div><span>Corte axial</span><b>${l.corte_rano}</b></div>
      </div>
    </div>` : `
    <div class="medidas">
      ${medida("Volumen", `${fmt(l.total_cm3, 2)} <small>cm³</small>`,
        `rango ${fmt(l.vol_min_cm3, 2)}–${fmt(l.vol_max_cm3, 2)} · necrosis ${fmt(l.necrosis_pct, 0)} %`)}
      <div class="medida medida-evo">
        <div class="medida-etq">Evolución</div>
        <div class="evo-grande"><i style="background:${EVO[evoLesion(l)].color}"></i>${EVO[evoLesion(l)].txt}</div>
        <div class="medida-det">${l.cambio_concluyente === false ? "Depende del margen de error" : esc(EVO[evoLesion(l)].sig)}</div>
      </div>
    </div>`}
    ${l.volumen_confiable === false ? `<p class="nota-chica aviso-chico">Lesión muy chica: el margen de error es mayor que la lesión. Dato poco confiable.</p>` : ""}
    <div>
      <div class="etq">Ubicación</div>
      <table class="coordenadas">
        <tr><td>Coordenadas en la resonancia</td><td>x ${fmt(l.centro_x_mm, 0)} · y ${fmt(l.centro_y_mm, 0)} · z ${fmt(l.centro_z_mm, 0)} mm</td></tr>
        <tr><td>Corte axial</td><td>${l.corte_axial_centro} (centro) · ${l.corte_rano} (diámetro)</td></tr>
        ${vacio(l.mni_x) ? "" : `<tr><td>Cerebro de referencia (MNI)</td><td>x ${fmt(l.mni_x, 0)} · y ${fmt(l.mni_y, 0)} · z ${fmt(l.mni_z, 0)} mm</td></tr>`}
      </table>
      <p class="criterio-regla">x: izquierda → derecha del paciente · y: atrás → adelante · z: abajo → arriba.</p>
    </div>
    <div>
      <div class="etq">Comparación</div>
      ${comparacion}
    </div>
    ${criterios}
    <div class="corte">
      <img src="${l.corte_img}" alt="Corte axial ${l.corte_rano}">
      <div class="corte-texto">Corte axial ${l.corte_rano}<br><i style="background:${C.diametro}"></i>Diámetro<br>
        <i style="background:${C.realce}"></i>Borde · <i style="background:#c0504a"></i>Necrosis</div>
    </div>
    <div>
      <div class="etq">Diámetro</div>
      <p class="texto-simple">
        RANO-BM: <b>${fmt(l.diam_rano_mm)} mm</b> (contorno externo: realce + necrosis) · solo realce ${fmt(l.diam_realce_mm)} mm ·
        perpendicular ${fmt(l.diam_perp_mm)} mm · máximo 3D ${fmt(l.diam_3d_mm)} mm ·
        ${l.medible_rano ? "medible" : "no medible (≥10 mm, ≥5 mm perpendicular y ≥2 cortes)"}.
        ${vacio(l.indice_esfericidad) ? "" : `Índice de esfericidad ${fmt(l.indice_esfericidad, 2)}: el volumen real es el ${fmt(100 * l.indice_esfericidad, 0)} % del que supone el diámetro.`}
      </p>
    </div>
    ${ritmo}`;
  panel.querySelectorAll(".selector-medida button").forEach((b) => (b.onclick = () => { st.medida = b.dataset.m; renderPanel(); }));
}

/* ---------- gráfico ---------- */
function renderEvolucion() {
  const serie = D().serie, vol = st.metrica === "vol";
  const trazas = lesionesPaciente().map((L, i) => {
    const pts = serie.filter((s) => s.lesion === L && s.estado !== "todavía no aparece");
    const sel = L === st.lesion, col = C.serie[i % C.serie.length];
    return {
      type: "scatter", mode: "lines+markers", name: L, x: pts.map((p) => p.dia), y: pts.map((p) => (vol ? p.total_cm3 : p.diam_rano_mm)),
      error_y: vol ? { type: "data", symmetric: false, array: pts.map((p) => p.vol_max_cm3 - p.total_cm3), arrayminus: pts.map((p) => p.total_cm3 - p.vol_min_cm3), color: col, thickness: 1, width: 3 } : undefined,
      line: { color: col, width: sel ? 3.5 : 2.2, shape: "linear" }, opacity: st.lesion && !sel ? 0.45 : 1,
      marker: { size: sel ? 11 : 8, color: pts.map((p) => EVO[evolucion(p.estado)].color), line: { color: C.card, width: 2 } },
      customdata: pts.map((p) => EVO[evolucion(p.estado)].txt),
      hovertemplate: `<b>${L}</b> · día %{x}<br>${vol ? "%{y:.2f} cm³" : "%{y:.1f} mm"} · %{customdata}<extra></extra>`,
    };
  });
  const c = ctrl(), d0 = D().controles[0].dia, d1 = D().controles.at(-1).dia;
  const shapes = [{ type: "line", x0: c.dia, x1: c.dia, yref: "paper", y0: 0, y1: 1, line: { color: C.azul, width: 1.5 } }];
  const anot = [];
  D().tratamientos.forEach((t) => {
    const f = tratCorto(t.tipo);
    if (t.dia_inicio === null || f === "Sistémico" || t.dia_inicio < d0 - 60 || t.dia_inicio > d1 + 30) return;
    shapes.push({ type: "line", x0: t.dia_inicio, x1: t.dia_inicio, yref: "paper", y0: 0, y1: 1, line: { color: C.texto3, width: 1, dash: "dot" } });
    anot.push({ x: t.dia_inicio, y: 1.02, yref: "paper", text: f, showarrow: false, font: { size: 10.5, color: C.texto3 }, yanchor: "bottom" });
  });
  if (!vol) {
    shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, y0: 10, y1: 10, line: { color: C.texto3, width: 1, dash: "dash" } });
    anot.push({ xref: "paper", x: 1, y: 10, text: "10 mm · medible", showarrow: false, xanchor: "right", yanchor: "bottom", font: { size: 10.5, color: C.texto3 } });
  }
  Plotly.react("grafico-evolucion", trazas, {
    margin: { l: 56, r: 16, t: 28, b: 44 }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, system-ui, sans-serif", size: 13, color: C.texto2 },
    xaxis: { title: { text: "Día", font: { size: 13 } }, gridcolor: C.grilla, zeroline: false, linecolor: C.borde, tickfont: { size: 12 } },
    yaxis: { title: { text: vol ? "Volumen (cm³)" : "Diámetro (mm)", font: { size: 13 } }, gridcolor: C.grilla, zeroline: false, rangemode: "tozero", tickfont: { size: 12 } },
    legend: { orientation: "h", y: 1.14, x: 1, xanchor: "right", font: { size: 12.5 } }, shapes, annotations: anot, showlegend: trazas.length > 1,
    hoverlabel: { bgcolor: C.card, bordercolor: C.borde, font: { family: "Inter, system-ui", color: C.texto } },
  }, { displaylogo: false, responsive: true, displayModeBar: false });
  const div = $("#grafico-evolucion");
  div.removeAllListeners && div.removeAllListeners("plotly_click");
  div.on("plotly_click", (e) => {
    const p = e.points[0], k = D().controles.findIndex((cc) => cc.dia === p.x);
    if (k >= 0) { st.lesion = p.data.name; irAControl(k); }
  });
}

/* ---------- tabla ---------- */
function renderTabla() {
  const c = ctrl();
  if (!c.lesiones.length) { $("#tabla-lesiones").innerHTML = `<tr><td class="vacio">Sin lesiones visibles</td></tr>`; return; }
  $("#tabla-lesiones").innerHTML = `<tr><th>Lesión</th><th>Evolución</th><th class="num">Volumen</th><th class="num">vs. anterior</th><th class="num">Diámetro</th>
      <th>Volumétrico</th><th>Ubicación</th></tr>` +
    c.lesiones.map((l) => {
      const v = l.cambio_vs_anterior_pct, base = l.estado === "basal" || l.estado === "NUEVA";
      return `<tr class="clic ${l.lesion === st.lesion ? "sel" : ""}" data-l="${l.lesion}">
        <td><b>${l.lesion}</b></td><td>${puntoEvo(evoLesion(l))}</td><td class="num">${fmt(l.total_cm3, 2)} cm³</td>
        <td class="num ${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${pct(v)}</td><td class="num">${fmt(l.diam_rano_mm)} mm</td>
        <td>${base ? badge(l.estado) : badge(l.clase_volumen)}</td>
        <td>${esc(l.hemisferio.replace("hemisferio ", ""))}, ${esc(l.region_aprox)}</td></tr>`;
    }).join("");
  $$("#tabla-lesiones tr.clic").forEach((tr) => (tr.onclick = () => seleccionarLesion(tr.dataset.l)));
}

/* ---------- resumen del paciente, tratamientos y notas del médico ---------- */
function renderResumenPaciente() {
  const d = D(), r = d.resumen, ult = d.controles.at(-1);
  const trats = (d.tratamientos || []).filter((t) => t.tipo).sort((a, b) => (a.dia_inicio ?? 1e9) - (b.dia_inicio ?? 1e9));
  const dosis = (t) => vacio(t.dosis_por_fraccion_Gy) ? "—" : `${fmt(t.dosis_por_fraccion_Gy, 1)} Gy${t.fracciones && !["0", "1"].includes(String(t.fracciones).trim()) ? ` × ${esc(t.fracciones)}` : ""}`;
  const dias = (t) => vacio(t.dia_inicio) ? "sin fecha" : `día ${t.dia_inicio}${vacio(t.dia_fin) || t.dia_fin === t.dia_inicio ? "" : ` a ${t.dia_fin}`}`;
  $("#resumen-paciente").innerHTML = `
    <div class="res-tiles">
      <div class="res-tile"><span>Último control</span><b>Día ${ult.dia}</b><small>control ${ult.n_estudio} de ${d.controles.length}</small></div>
      <div class="res-tile"><span>Estado volumétrico</span><b>${badge(ult.rano.volumetrico)}</b><small>Ocaña-Tienda 2024</small></div>
      <div class="res-tile"><span>Lesiones</span><b>${ult.lesiones.length} <em>visibles</em></b><small>${r.n_lesiones} en total${r.lesiones_nuevas ? ` · ${r.lesiones_nuevas} nueva${r.lesiones_nuevas > 1 ? "s" : ""}` : ""}</small></div>
      <div class="res-tile"><span>Volumen total</span><b>${fmt(ult.rano.suma_vol_cm3, 2)} <em>cm³</em></b><small>suma de todas las lesiones</small></div>
    </div>
    <div class="res-bloque">
      <div class="etq">Tratamientos registrados</div>
      ${trats.length ? `<div class="tabla-envoltorio"><table class="tabla tabla-trat">
        <tr><th>Tratamiento</th><th>Detalle</th><th>Dosis</th><th>Fecha</th></tr>
        ${trats.map((t) => `<tr><td><b>${esc(tratCorto(t.tipo))}</b>${t.lesion_n ? ` <span class="sub">· lesión clínica ${t.lesion_n}</span>` : ""}</td>
          <td>${esc(t.detalle || t.tipo)}</td><td>${dosis(t)}</td><td>${dias(t)}</td></tr>`).join("")}
      </table></div>` : `<p class="nota-vacia">No hay tratamientos registrados para este paciente.</p>`}
    </div>
    <div class="res-bloque notas">
      <div class="etq">Notas <span id="notas-cuenta"></span></div>
      <div class="notas-caja">
        <div id="lista-notas" class="lista-notas"></div>
        <div class="notas-escribir">
          <textarea id="notas" rows="2" placeholder="Escribí una nota: impresión clínica, conducta a seguir, próximo control…"></textarea>
          <button class="btn primario" id="guardar-notas">Agregar</button>
        </div>
        <span class="sub" id="notas-estado"></span>
      </div>
    </div>
    <details class="supuestos">
      <summary>Criterios y supuestos del análisis</summary>
      <ul>
        <li><b>Basal:</b> primer control en que aparece cada lesión. No se re-basaliza al cambiar de tratamiento. <b>Nadir:</b> valor más bajo de los controles anteriores.</li>
        <li><b>Volumen:</b> lesión total (realce + necrosis), vóxeles × tamaño del vóxel. Margen de error: el borde corrido ±${0.5} mm (superficie × 0,5 mm).
          Si con el volumen mínimo y el máximo la clase cambia, se informa como no concluyente.</li>
        <li><b>Criterio volumétrico principal:</b> Ocaña-Tienda 2024 (progresión +30 % vs. nadir, +0,2 cm³ si es menor a 1 cm³; respuesta −20 % vs. basal).</li>
        <li><b>Diámetro RANO-BM:</b> cuerda más larga en el corte axial, sobre el <b>contorno externo (realce + necrosis)</b>. Es un supuesto nuestro: el documento no aclara si incluye el centro necrótico. También se informa el diámetro solo del realce.</li>
        <li><b>RANO-BM por paciente:</b> hasta 5 lesiones diana medibles elegidas en el basal y fijas; una diana que desaparece aporta 0 mm. Progresión: suma +20 % vs. nadir y al menos una lesión +5 mm, o lesión nueva. Lesiones &lt;10 mm: sin cambios salvo ±3 mm.</li>
        <li><b>Solo imagen:</b> RC y RP requieren confirmación a las 4 semanas y condiciones clínicas (corticoides, estado clínico) que no están en los datos.</li>
        <li><b>Inmunoterapia:</b> RANO-BM exceptúa que una lesión nueva sea progresión; la hoja de tratamientos no siempre distingue el tipo de sistémico.</li>
        <li><b>Ubicación:</b> aproximada. Se ubica la lesión en su posición relativa dentro de un cerebro de referencia (MNI152); no es un registro anatómico y no corrige la inclinación de la cabeza.</li>
      </ul>
    </details>`;
  cargarNotas();
  $("#guardar-notas").onclick = agregarNota;
}

/* Notas: lista de notas del médico por paciente. Con el motor encendido se guardan en historial/notas/;
   sin motor, en el navegador. */
const claveNotas = () => `notas:${st.pid}`;
function notasLocales() { try { return JSON.parse(localStorage.getItem(claveNotas())) || []; } catch { return []; } }
function guardarLocales(lista) { try { localStorage.setItem(claveNotas(), JSON.stringify(lista)); return true; } catch { return false; } }

function mostrarNotas(lista) {
  $("#notas-cuenta").textContent = lista.length ? `· ${lista.length}` : "";
  $("#lista-notas").innerHTML = lista.length ? lista.slice().reverse().map((n) => `
    <div class="nota"><div class="nota-cab"><span>${esc(n.fecha || "")}</span>
      <button class="nota-borrar" data-id="${esc(n.id)}" aria-label="Borrar nota">×</button></div>
      <div class="nota-texto">${esc(n.texto).replace(/\n/g, "<br>")}</div></div>`).join("")
    : `<p class="nota-vacia">Todavía no hay notas para este paciente.</p>`;
  $$("#lista-notas .nota-borrar").forEach((b) => (b.onclick = () => borrarNota(b.dataset.id)));
}

async function cargarNotas() {
  const clave = st.pid;
  let lista = [];
  if (servidorOk) { try { lista = await (await fetch(`${API}/api/notas/${encodeURIComponent(clave)}`)).json(); } catch { lista = []; } }
  else lista = notasLocales();
  if (clave === st.pid) mostrarNotas(Array.isArray(lista) ? lista : []);
}

async function agregarNota() {
  const texto = $("#notas").value.trim();
  if (!texto) { $("#notas").focus(); return; }
  let lista;
  if (servidorOk) {
    try {
      lista = await (await fetch(`${API}/api/notas/${encodeURIComponent(st.pid)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto }) })).json();
    } catch { $("#notas-estado").textContent = "No se pudo guardar"; return; }
  } else {
    lista = notasLocales();
    lista.push({ id: Math.random().toString(36).slice(2, 10), texto, fecha: new Date().toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) });
    if (!guardarLocales(lista)) { $("#notas-estado").textContent = "No se pudo guardar"; return; }
  }
  $("#notas").value = "";
  $("#notas-estado").textContent = "Nota agregada";
  mostrarNotas(lista);
}

async function borrarNota(id) {
  let lista;
  if (servidorOk) {
    try { lista = await (await fetch(`${API}/api/notas/${encodeURIComponent(st.pid)}/${encodeURIComponent(id)}`, { method: "DELETE" })).json(); }
    catch { return; }
  } else { lista = notasLocales().filter((n) => n.id !== id); guardarLocales(lista); }
  $("#notas-estado").textContent = "";
  mostrarNotas(lista);
}

/* ---------- eventos ---------- */
$("#ir-inicio").onclick = () => mostrarVista("cargar");
$("#tema").onclick = () => aplicarTema(document.documentElement.dataset.tema === "oscuro" ? "claro" : "oscuro");
$("#volver").onclick = () => mostrarVista("historial");

/* ---------- menú lateral: se despliega desde la izquierda ---------- */
function renderMenu() {
  const q = ($("#menu-buscar").value || "").trim().toLowerCase();
  const abierto = st.pid && !$("#vista-paciente").hidden;
  const items = itemsHistorial().filter((p) => !q ||
    [p.paciente_id, p.tumor_primario, etiqueta(p.vol_ultimo), p.fecha_carga].join(" ").toLowerCase().includes(q));
  $("#menu-lista").innerHTML = items.length ? items.map((p) => `
    <button class="menu-item ${abierto && p.clave === st.pid ? "actual" : ""}" data-clave="${esc(p.clave)}" data-origen="${p.origen}">
      <span><b>${esc(p.paciente_id)}</b><small>${p.origen === "ejemplo" ? esc(primario(p.tumor_primario)) + " · ejemplo" : "Cargado el " + esc(p.fecha_carga)}</small></span>
      ${badge(p.vol_ultimo)}</button>`).join("") : `<div class="menu-vacio">Sin resultados</div>`;
  $$("#menu-lista .menu-item").forEach((b) => (b.onclick = () => {
    cerrarMenu();
    b.dataset.origen === "ejemplo" ? abrirEjemplo(b.dataset.clave) : abrirCargado(b.dataset.clave);
  }));
  const vista = ["cargar", "historial"].find((v) => !$(`#vista-${v}`).hidden);
  $$("#lateral .lat-nav button").forEach((b) => b.classList.toggle("activa", b.dataset.vista === vista));
}
function abrirMenu() {
  document.body.classList.add("menu-abierto");
  $("#abrir-menu").setAttribute("aria-expanded", "true");
  $("#menu-buscar").value = "";
  renderMenu();
}
function cerrarMenu() {
  document.body.classList.remove("menu-abierto");
  $("#abrir-menu").setAttribute("aria-expanded", "false");
}
$("#abrir-menu").onclick = () => (document.body.classList.contains("menu-abierto") ? cerrarMenu() : abrirMenu());
$("#cerrar-menu").onclick = cerrarMenu;
$("#fondo-menu").onclick = cerrarMenu;
$("#menu-buscar").oninput = renderMenu;
$$("#lateral .lat-nav button").forEach((b) => (b.onclick = () => mostrarVista(b.dataset.vista)));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarMenu(); });
$("#buscar").oninput = renderHistorial;
$$("#filtro-origen button").forEach((b) => (b.onclick = () => {
  filtroOrigen = b.dataset.origen;
  $$("#filtro-origen button").forEach((x) => x.classList.toggle("activo", x === b));
  renderHistorial();
}));
$$("#modo-3d button").forEach((b) => (b.onclick = () => {
  st.modo = b.dataset.modo;
  $$("#modo-3d button").forEach((x) => x.classList.toggle("activo", x === b));
  render3D();
}));
$$("#metrica button").forEach((b) => (b.onclick = () => {
  st.metrica = b.dataset.metrica;
  $$("#metrica button").forEach((x) => x.classList.toggle("activo", x === b));
  renderEvolucion();
}));

const dz = $("#dropzone");
$("#input-archivos").onchange = (e) => recibirArchivos(e.target.files);
$("#input-carpeta").onchange = (e) => recibirArchivos(e.target.files);
$("#elegir-carpeta").onclick = () => $("#input-carpeta").click();
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("encima"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("encima"); }));
// al soltar también se aceptan carpetas (se recorren con todo su contenido)
async function leerEntrada(entrada) {
  if (entrada.isFile) return [await new Promise((ok, mal) => entrada.file(ok, mal))];
  const lector = entrada.createReader(), hijos = [];
  for (let lote; (lote = await new Promise((ok, mal) => lector.readEntries(ok, mal))).length;) hijos.push(...lote);
  return (await Promise.all(hijos.map(leerEntrada))).flat();
}
dz.addEventListener("drop", async (e) => {
  const entradas = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entradas.length) return recibirArchivos(e.dataTransfer.files);
  recibirArchivos((await Promise.all(entradas.map(leerEntrada))).flat());
});
document.addEventListener("keydown", (e) => {
  if ($("#vista-paciente").hidden || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") irAControl(st.k - 1);
  if (e.key === "ArrowRight") irAControl(st.k + 1);
});
let tResize;
window.addEventListener("resize", () => { clearTimeout(tResize); tResize = setTimeout(() => { if (!$("#vista-paciente").hidden) renderLineaTiempo(); }, 150); });

let temaInicial = "claro";
try { temaInicial = localStorage.getItem("tema") || (matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro"); } catch { /* claro */ }
aplicarTema(temaInicial);
mostrarVista("cargar");
verificarServidor();
// enlaces directos: index.html#historial · #p=040183 (opcional: &modo=cambio)
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has("historial")) mostrarVista("historial");
if (hash.get("modo") === "cambio") $$("#modo-3d button")[1].click();
if (hash.get("p")) abrirEjemplo(hash.get("p"));
