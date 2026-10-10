# %% [markdown]
# # Metástasis cerebrales: motor de cálculo + vista 3D
# Cada bloque que empieza con "# %%" es una celda: en VS Code aparece
# "Run Cell" arriba de cada una (o Shift + Enter). También corre entero con `python lesion_3d.py`.
#
# PARTE 1 (celdas 1 a 5): calcula todo y guarda tablas en DATASET/resultados/
#   - separa y sigue cada lesión en el tiempo (L1, L2, ...; detecta lesiones nuevas)
#   - volumen total / realce / necrosis en cm³, con rango de incertidumbre
#   - ubicación (coordenadas en mm, corte, hemisferio y región aproximada)
#   - diámetro RANO-BM (axial) + perpendicular + diámetro máximo 3D
#   - clasificación RANO-BM (diámetros) y volumétrica (Ocaña-Tienda 2024 y Huang 2025)
#   - mapa de cambio entre controles (cm³ crecidos / reducidos y hacia dónde)
# PARTE 2 (celdas 6 y 7): vista 3D y evolución de un paciente.

# %% 1. Configuración y carga del Excel
import numpy as np
import pandas as pd
import nibabel as nib
import plotly.graph_objects as go
import plotly.express as px
from pathlib import Path
from scipy import ndimage
from scipy.spatial import ConvexHull, QhullError
from skimage import measure, filters

# >>> CAMBIEN ESTO si mueven la carpeta: donde están dataset.xlsx y la carpeta imagenes/
BASE = Path(r"C:\Users\Asus\Downloads\DATASET")
SALIDA = BASE / "resultados"
PACIENTE = "040183"   # con el 0 adelante, como texto
N_ESTUDIO = 1         # qué control mostrar en 3D (1 = el primero)

UNION_MM = 5.0        # una mancha a menos de 5 mm de donde hubo una lesión es esa misma lesión
                      # (con 5 mm la cantidad de lesiones coincide con la historia clínica en los 10 pacientes)
pd.set_option("display.width", 220)
pd.set_option("display.max_columns", 40)

xls = pd.read_excel(BASE / "dataset.xlsx", sheet_name=None, dtype={"paciente_id": str})
pacientes = xls["pacientes"]
estudios = xls["estudios"]
tratamientos = xls["tratamientos"]

VEC26 = np.ones((3, 3, 3), bool)                   # vecinos en 3D, incluidas diagonales
VEC6 = ndimage.generate_binary_structure(3, 1)     # vecinos por cara (para el borde)


# %% 2. Funciones de cálculo
def a_mm(vertices, affine):
    """Pasa coordenadas de vóxel a mm en el espacio del paciente (RAS: x→der, y→ant, z→sup)."""
    return np.asarray(vertices, float) @ affine[:3, :3].T + affine[:3, 3]


def abrir(ruta):
    """Abre un NIfTI y lo lleva a orientación RAS (el eje 3 queda siempre axial)."""
    img = nib.load(BASE / ruta)
    if nib.aff2axcodes(img.affine) != ("R", "A", "S"):
        img = nib.as_closest_canonical(img)
    return img


def cargar(fila):
    """Devuelve la T1, la máscara (0/1/2), el affine (vóxel -> mm RAS) y el tamaño del vóxel."""
    img, seg = abrir(fila.archivo_imagen), abrir(fila.archivo_mascara)
    t1 = img.get_fdata(dtype=np.float32)
    mascara = np.rint(seg.get_fdata()).astype(np.uint8)
    return t1, mascara, seg.affine, np.array(seg.header.get_zooms()[:3], dtype=float)


def distancia_maxima(pts):
    """Mayor distancia entre dos puntos (se busca sobre el contorno convexo, es exacta)."""
    if len(pts) > 3:
        try:
            pts = pts[ConvexHull(pts).vertices]
        except QhullError:
            pass  # puntos alineados: se usan todos
    d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=-1)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    return d[i, j], pts[i], pts[j]


def diametro_rano(comp, zooms):
    """Diámetro RANO-BM: en cada corte axial, la cuerda más larga del contorno externo
    (en mm reales, con precisión de subvóxel); se queda el corte donde es máxima.
    Devuelve diámetro, perpendicular, corte, extremos (en índices de vóxel) y cortes con lesión."""
    mejor = dict(d=0.0, perp=0.0, z=None, p1=None, p2=None)
    cortes = 0
    for z in range(comp.shape[2]):
        sl = comp[:, :, z]
        if not sl.any():
            continue
        cortes += 1
        sl = ndimage.binary_fill_holes(sl)  # contorno externo: incluye el centro necrótico
        contornos = measure.find_contours(np.pad(sl, 1).astype(np.float32), 0.5)
        pts = (np.vstack(contornos) - 1) * zooms[:2]  # índices -> mm en el plano
        d, a, b = distancia_maxima(pts)
        if d > mejor["d"]:
            eje = (b - a) / d
            perp = pts @ np.array([-eje[1], eje[0]])
            mejor = dict(d=d, perp=perp.max() - perp.min(), z=z, p1=a / zooms[:2], p2=b / zooms[:2])
    mejor["cortes"] = cortes
    return mejor


def forma_3d(comp, zooms):
    """Diámetro máximo 3D (mm) y superficie (mm²) a partir de la superficie de la lesión."""
    if comp.sum() < 2:
        return float(np.max(zooms)), float(2 * (zooms[0] * zooms[1] + zooms[0] * zooms[2] + zooms[1] * zooms[2]))
    vert, caras, _, _ = measure.marching_cubes(np.pad(comp, 1).astype(np.float32), 0.5, spacing=tuple(zooms))
    return distancia_maxima(vert)[0], measure.mesh_surface_area(vert, caras)


def referencia_cabeza(t1, affine, zooms, resolucion_mm=3.0):
    """Contorno de la cabeza (umbral de Otsu) para ubicar las lesiones: centro y caja en mm."""
    paso = np.maximum(1, np.round(resolucion_mm / zooms)).astype(int)
    chica = ndimage.gaussian_filter(t1[::paso[0], ::paso[1], ::paso[2]], 1)
    cabeza = chica > filters.threshold_otsu(chica)
    etiquetas, n = ndimage.label(cabeza)
    if n > 1:
        tamanios = ndimage.sum(cabeza, etiquetas, range(1, n + 1))
        cabeza = etiquetas == (np.argmax(tamanios) + 1)
    cabeza = ndimage.binary_fill_holes(cabeza)
    pts = a_mm(np.argwhere(cabeza) * paso, affine)
    return dict(centro=pts.mean(axis=0), minimo=pts.min(axis=0), maximo=pts.max(axis=0), mascara=cabeza, paso=paso)


def ubicar(c_mm, ref, margen_mm=8):
    """Hemisferio y región aproximada a partir de la posición relativa dentro de la cabeza.
    Es una estimación geométrica, no un atlas anatómico."""
    dx = c_mm[0] - ref["centro"][0]
    lado = "línea media" if abs(dx) < margen_mm else ("hemisferio derecho" if dx > 0 else "hemisferio izquierdo")
    rel = (c_mm - ref["minimo"]) / (ref["maximo"] - ref["minimo"])  # 0..1: x izq→der, y post→ant, z inf→sup
    lateral = abs(rel[0] - 0.5) > 0.25
    if rel[2] < 0.35 and rel[1] < 0.45:
        region = "fosa posterior (posible cerebelo)"
    elif rel[1] > 0.6:
        region = "frontal"
    elif rel[1] < 0.3:
        region = "occipital"
    elif rel[2] < 0.5 and lateral:
        region = "temporal"
    else:
        region = "parietal"
    return lado, region


def direccion(v_mm, minimo_mm=1.0):
    """Traduce un desplazamiento en mm a palabras (ej. 'anterior y superior')."""
    nombres = (("derecha", "izquierda"), ("anterior", "posterior"), ("superior", "inferior"))
    partes = [nombres[i][0 if v_mm[i] > 0 else 1] for i in np.argsort(-np.abs(v_mm)) if abs(v_mm[i]) >= minimo_mm]
    return " y ".join(partes[:2]) if partes else "sin dirección dominante"


def clase_volumen(v, basal, nadir, prog=0.30, resp=0.20, extra_cm3=0.2):
    """Ocaña-Tienda 2024: progresión ≥ +30 % vs nadir (+0,2 cm³ si el nadir es < 1 cm³);
    respuesta parcial ≥ −20 % vs basal; desaparición = respuesta completa."""
    if v == 0:
        return "respuesta completa"
    if nadir > 0 and v >= nadir * (1 + prog) and (nadir >= 1 or v - nadir >= extra_cm3):
        return "progresión"
    if nadir == 0 and v > 0:
        return "progresión"  # reaparece después de haber desaparecido
    if v <= basal * (1 - resp):
        return "respuesta parcial"
    return "estable"


def clase_huang(v, basal, nadir):
    """Huang 2025 (traducción esférica de RECIST): +73 % vs nadir / −65 % vs basal."""
    if v == 0:
        return "respuesta completa"
    if v >= nadir * 1.73:
        return "progresión"
    if v <= basal * 0.35:
        return "respuesta parcial"
    return "estable"


def clase_diametro(d, basal, nadir):
    """Regla RANO-BM aplicada a una sola lesión: +20 % y ≥5 mm vs nadir / −30 % vs basal.
    Lesiones < 10 mm: sin cambios salvo que cambien ≥ 3 mm."""
    if d == 0:
        return "respuesta completa"
    if max(d, nadir) < 10 and abs(d - nadir) < 3 and abs(d - basal) < 3:
        return "estable"
    if d >= nadir * 1.2 and d - nadir >= 5:
        return "progresión"
    if d <= basal * 0.7:
        return "respuesta parcial"
    return "estable"


# %% 3. Motor: procesar un paciente completo
def identificar_lesiones(mascaras, zooms):
    """Da a cada lesión un número (L1, L2, ...) que se mantiene en todos los controles.
    Como las RM están corregistradas, una lesión ocupa el mismo lugar en todos los estudios.
    Control por control, cada mancha 3D:
      - si está donde (o a menos de UNION_MM de donde) ya hubo una lesión, es esa lesión;
      - si no está cerca de ninguna, es una lesión NUEVA;
      - si toca a dos lesiones conocidas (crecieron y se juntaron), sus vóxeles se reparten
        según a cuál estaban más cerca, así no se pierden lesiones."""
    historia = np.zeros(mascaras[0].shape, np.int32)  # en cada vóxel, la última lesión vista ahí
    ids_por_control, n = [], 0
    for m in mascaras:
        manchas, k = ndimage.label(m > 0, structure=VEC26)
        ids = np.zeros_like(historia)
        if historia.any():
            dist, idx = ndimage.distance_transform_edt(historia == 0, sampling=zooms, return_indices=True)
            cercana = historia[tuple(idx)]
        tamanios = ndimage.sum(m > 0, manchas, range(1, k + 1))
        for j in np.argsort(-tamanios) + 1:  # de mayor a menor: en el primer control L1 es la más grande
            sel = manchas == j
            candidatas = np.unique(cercana[sel & (dist <= UNION_MM)]) if historia.any() else []
            if len(candidatas) == 0:
                n += 1
                ids[sel] = n
            elif len(candidatas) == 1:
                ids[sel] = candidatas[0]
            else:
                ids[sel] = cercana[sel]
        historia[ids > 0] = ids[ids > 0]
        ids_por_control.append(ids)
    return ids_por_control, n


def procesar_paciente(pid, verbose=True):
    est = estudios[estudios.paciente_id == pid].sort_values("n_estudio").reset_index(drop=True)
    avisos = []

    # Paso 0: cargar, verificar tamaño de vóxel y recortar a la zona con lesiones
    mascaras, zooms, affine = [], None, None
    for f in est.itertuples():
        seg = abrir(f.archivo_mascara)
        z = np.array(seg.header.get_zooms()[:3], float)
        excel = np.array([f.spacing_x_mm, f.spacing_y_mm, f.spacing_z_mm])
        if np.abs(z - excel).max() > 0.01:
            avisos.append(f"control {f.n_estudio}: vóxel del NIfTI {np.round(z, 4)} ≠ Excel {excel}")
        if zooms is not None and (np.abs(z - zooms).max() > 1e-3 or seg.shape != mascaras[0].shape):
            avisos.append(f"control {f.n_estudio}: grilla distinta al control 1")
        zooms = z if zooms is None else zooms
        affine = seg.affine if affine is None else affine
        m = np.rint(seg.get_fdata()).astype(np.uint8)
        if not set(np.unique(m)) <= {0, 1, 2}:
            avisos.append(f"control {f.n_estudio}: etiquetas inesperadas {np.unique(m)}")
        mascaras.append(m)
    vv_cm3 = np.prod(zooms) / 1000  # cm³ por vóxel

    t1_1 = abrir(est.archivo_imagen[0]).get_fdata(dtype=np.float32)
    ref = referencia_cabeza(t1_1, affine, zooms)
    del t1_1

    hay = np.zeros(mascaras[0].shape, bool)
    for m in mascaras:
        hay |= m > 0
    if not hay.any():
        avisos.append("sin lesiones segmentadas")
        return dict(pid=pid, tabla=pd.DataFrame(), rano=pd.DataFrame(), avisos=avisos)
    margen = (np.ceil(UNION_MM / zooms) + 3).astype(int)
    caja = ndimage.find_objects(hay.astype(np.uint8))[0]
    caja = tuple(slice(max(s.start - k, 0), min(s.stop + k, n)) for s, k, n in zip(caja, margen, hay.shape))
    offset = np.array([s.start for s in caja])
    mascaras = [m[caja] for m in mascaras]

    # Pasos 1 y 2: separar las lesiones y seguirlas en el tiempo
    ids, n_les = identificar_lesiones(mascaras, zooms)

    # Pasos 3 a 5: medir cada lesión en cada control
    filas = []
    for k, f in enumerate(est.itertuples()):
        m = mascaras[k]
        for L in range(1, n_les + 1):
            comp = ids[k] == L
            fila = dict(paciente_id=pid, n_estudio=f.n_estudio, dia=f.dia, lesion=f"L{L}")
            n = int(comp.sum())
            if n == 0:
                fila.update(total_cm3=0.0, realce_cm3=0.0, necrosis_cm3=0.0, vol_min_cm3=0.0, vol_max_cm3=0.0,
                            diam_rano_mm=0.0, diam_perp_mm=0.0, diam_3d_mm=0.0)
                filas.append(fila)
                continue
            sub = ndimage.find_objects(comp.astype(np.uint8))[0]
            sub = tuple(slice(max(s.start - 1, 0), min(s.stop + 1, N)) for s, N in zip(sub, comp.shape))
            c, et = comp[sub], m[sub]
            borde_in = n - ndimage.binary_erosion(c, VEC6).sum()
            borde_out = ndimage.binary_dilation(np.pad(c, 1), VEC6).sum() - n
            d = diametro_rano(c, zooms)
            d3, area = forma_3d(c, zooms)
            o = offset + np.array([s.start for s in sub])
            centro_vox = np.argwhere(c).mean(axis=0) + o
            centro = a_mm(centro_vox, affine)
            lado, region = ubicar(centro, ref)
            v = n * vv_cm3
            fila.update(
                total_cm3=v,
                realce_cm3=(c & (et == 1)).sum() * vv_cm3,
                necrosis_cm3=(c & (et == 2)).sum() * vv_cm3,
                vol_min_cm3=(n - 0.5 * borde_in) * vv_cm3,   # ± media capa de vóxeles de borde
                vol_max_cm3=(n + 0.5 * borde_out) * vv_cm3,
                diam_rano_mm=d["d"], diam_perp_mm=d["perp"], diam_3d_mm=d3,
                cortes_axiales=d["cortes"], corte_rano=int(d["z"] + o[2]),
                medible_rano=bool(d["d"] >= 10 and d["perp"] >= 5 and d["cortes"] >= 2 and d["d"] >= 2 * zooms[2]),
                esfericidad=float(np.pi ** (1 / 3) * (6 * v * 1000) ** (2 / 3) / area),
                vol_esfera_diam_cm3=np.pi * d["d"] ** 3 / 6 / 1000,
                centro_x_mm=centro[0], centro_y_mm=centro[1], centro_z_mm=centro[2],
                corte_axial_centro=int(round(centro_vox[2])),
                hemisferio=lado, region_aprox=region,
                # extremos del diámetro RANO en mm (para dibujar la línea en el 3D)
                rano_p1=tuple(np.round(a_mm(np.r_[d["p1"] + o[:2], d["z"] + o[2]], affine), 2)),
                rano_p2=tuple(np.round(a_mm(np.r_[d["p2"] + o[:2], d["z"] + o[2]], affine), 2)),
            )
            fila["necrosis_pct"] = 100 * fila["necrosis_cm3"] / v
            fila["error_diam_vs_vol_pct"] = 100 * (fila["vol_esfera_diam_cm3"] - v) / v
            # Paso 7: mapa de cambio contra el control anterior
            if k > 0:
                antes = ids[k - 1] == L
                crecido, reducido = comp & ~antes, antes & ~comp
                fila["crecido_cm3"] = crecido.sum() * vv_cm3
                fila["reducido_cm3"] = reducido.sum() * vv_cm3
                fila["estable_cm3"] = (comp & antes).sum() * vv_cm3
                if crecido.sum() and antes.any():
                    desp = a_mm(np.argwhere(crecido).mean(0), affine) - a_mm(np.argwhere(antes).mean(0), affine)
                    fila["crece_hacia"] = direccion(desp)
            filas.append(fila)
    tabla = pd.DataFrame(filas)

    # la ubicación de cada lesión se informa una sola vez: la del control donde fue más grande
    for L, g in tabla[tabla.total_cm3 > 0].groupby("lesion"):
        mayor = g.loc[g.total_cm3.idxmax()]
        tabla.loc[tabla.lesion == L, ["hemisferio", "region_aprox"]] = [mayor.hemisferio, mayor.region_aprox]

    # Paso 6: clasificación por lesión (basal = primera vez que aparece; nadir = mínimo previo)
    for L, g in tabla.groupby("lesion"):
        g = g.sort_values("n_estudio")
        presentes = g[g.total_cm3 > 0]
        primera = presentes.n_estudio.min()
        for pos, (idx, r) in enumerate(g.iterrows()):
            if r.n_estudio < primera:
                tabla.loc[idx, "estado"] = "todavía no aparece"
                continue
            if r.n_estudio == primera:
                tabla.loc[idx, "estado"] = "basal" if primera == est.n_estudio.min() else "NUEVA"
                continue
            prev = g[(g.n_estudio >= primera) & (g.n_estudio < r.n_estudio)]
            b = g[g.n_estudio == primera].iloc[0]
            ant = prev.iloc[-1]
            v, vb, vn = r.total_cm3, b.total_cm3, prev.total_cm3.min()
            tabla.loc[idx, "cambio_vs_anterior_pct"] = 100 * (v - ant.total_cm3) / ant.total_cm3 if ant.total_cm3 else np.nan
            tabla.loc[idx, "cambio_vs_basal_pct"] = 100 * (v - vb) / vb
            tabla.loc[idx, "cambio_vs_nadir_pct"] = 100 * (v - vn) / vn if vn else np.nan
            tabla.loc[idx, "clase_volumen"] = cv = clase_volumen(v, vb, vn)
            tabla.loc[idx, "clase_volumen_huang"] = clase_huang(v, vb, vn) if vn else cv
            tabla.loc[idx, "clase_diametro"] = cd = clase_diametro(r.diam_rano_mm, b.diam_rano_mm, prev.diam_rano_mm.min())
            tabla.loc[idx, "desacuerdo"] = cv != cd
            # ¿el cambio supera el margen de error de la medición?
            tabla.loc[idx, "cambio_concluyente"] = bool(
                r.vol_min_cm3 > ant.vol_max_cm3 or r.vol_max_cm3 < ant.vol_min_cm3)
            # estimación: velocidad de crecimiento y tiempo de duplicación (o de reducción a la mitad)
            dt = r.dia - ant.dia
            if v > 0 and ant.total_cm3 > 0 and dt > 0:
                kk = np.log(v / ant.total_cm3) / dt
                tabla.loc[idx, "crec_pct_por_mes"] = 100 * (np.exp(30.44 * kk) - 1)
                tabla.loc[idx, "dias_duplicar_o_mitad"] = np.log(2) / abs(kk) if kk else np.inf
            tabla.loc[idx, "estado"] = cv

    rano = rano_paciente(tabla, est)
    if verbose:
        n_clin = pacientes.loc[pacientes.paciente_id == pid, "n_lesiones"]
        print(f"Paciente {pid}: {len(est)} controles, {n_les} lesiones detectadas"
              f" (Excel dice {int(n_clin.iloc[0]) if len(n_clin) else '?'}), vóxel {zooms} mm")
        for a in avisos:
            print("  AVISO:", a)
    return dict(pid=pid, tabla=tabla, rano=rano, avisos=avisos, ids=ids, mascaras=mascaras,
                offset=offset, affine=affine, zooms=zooms, ref=ref, estudios=est)


def rano_paciente(tabla, est):
    """RANO-BM a nivel paciente (solo la parte de imagen): hasta 5 lesiones diana medibles
    en el primer control, suma de diámetros vs basal / nadir; lesión nueva = progresión.
    Al lado, la misma lógica con la suma de volúmenes (Ocaña-Tienda y Huang)."""
    primero = est.n_estudio.min()
    base = tabla[(tabla.n_estudio == primero) & (tabla.total_cm3 > 0)]
    dianas = base[base.medible_rano.eq(True)].nlargest(5, "diam_rano_mm").lesion.tolist()
    lesiones_basales = base.lesion.tolist()
    filas = []
    for k, f in enumerate(est.itertuples()):
        t = tabla[tabla.n_estudio == f.n_estudio]
        nuevas = t[t.estado == "NUEVA"].lesion.tolist()
        suma_d = t[t.lesion.isin(dianas)].diam_rano_mm.sum()
        suma_v = t.total_cm3.sum()
        fila = dict(paciente_id=f.paciente_id, n_estudio=f.n_estudio, dia=f.dia, lesiones_diana=", ".join(dianas),
                    suma_diam_mm=suma_d, suma_vol_cm3=suma_v, lesiones_presentes=int((t.total_cm3 > 0).sum()),
                    lesiones_nuevas=", ".join(nuevas))
        if k == 0:
            fila.update(rano_bm="basal", volumetrico="basal", volumetrico_huang="basal")
        else:
            prev = [r for r in filas]
            d_b, d_n = filas[0]["suma_diam_mm"], min(r["suma_diam_mm"] for r in prev)
            v_b, v_n = filas[0]["suma_vol_cm3"], min(r["suma_vol_cm3"] for r in prev)
            if not dianas:
                rb = "sin lesiones medibles"
            elif suma_d == 0:
                rb = "respuesta completa"
            else:
                # ≥20 % vs nadir y al menos una diana creció ≥5 mm respecto de su propio mínimo
                previas = tabla[(tabla.n_estudio < f.n_estudio) & tabla.lesion.isin(dianas)]
                crece5 = any(t[t.lesion == L].diam_rano_mm.iloc[0] - previas[previas.lesion == L].diam_rano_mm.min() >= 5
                             for L in dianas)
                if d_n > 0 and suma_d >= 1.2 * d_n and crece5:
                    rb = "progresión"
                elif suma_d <= 0.7 * d_b:
                    rb = "respuesta parcial"
                else:
                    rb = "estable"
            # suma de volúmenes de las lesiones presentes desde el inicio
            v_basales = t[t.lesion.isin(lesiones_basales)].total_cm3.sum()
            vb_hist = [tabla[(tabla.n_estudio == r["n_estudio"]) & tabla.lesion.isin(lesiones_basales)].total_cm3.sum()
                       for r in prev]
            vol = clase_volumen(v_basales, vb_hist[0], min(vb_hist))
            hua = clase_huang(v_basales, vb_hist[0], min(vb_hist)) if min(vb_hist) else vol
            if nuevas:
                rb, vol, hua = (f"progresión (lesión nueva {', '.join(nuevas)})",) * 3
            fila.update(rano_bm=rb, volumetrico=vol, volumetrico_huang=hua,
                        cambio_diam_vs_basal_pct=100 * (suma_d - d_b) / d_b if d_b else np.nan,
                        cambio_vol_vs_basal_pct=100 * (suma_v - v_b) / v_b if v_b else np.nan)
            fila["desacuerdo"] = rb.split(" (")[0] != vol.split(" (")[0]
        filas.append(fila)
    return pd.DataFrame(filas)


# %% 4. Validación con lesiones artificiales de medida conocida
def validar():
    """Crea esferas y elipsoides con vóxeles no cúbicos (como el dataset) y compara con la fórmula."""
    print("VALIDACIÓN (lesiones artificiales en 10 posiciones al azar dentro de la grilla; promedio y peor caso)")
    rng = np.random.default_rng(0)
    for zooms in ([0.5, 0.5, 1.3], [0.43, 0.43, 2.0], [0.98, 0.98, 1.0]):
        zooms = np.array(zooms)
        for r_mm in (3, 6, 15):
            for semi in ((r_mm, r_mm, r_mm), (2 * r_mm, r_mm, r_mm)):  # esfera y elipsoide alargado
                semi = np.array(semi, float)
                n = np.ceil(semi / zooms).astype(int) + 3
                ev, ed = [], []
                for _ in range(10):
                    desv = rng.uniform(-0.5, 0.5, 3) * zooms  # la lesión no cae justo sobre un vóxel
                    g = np.meshgrid(*[np.arange(-k, k + 1) * z - o for k, z, o in zip(n, zooms, desv)], indexing="ij")
                    comp = sum((gi / s) ** 2 for gi, s in zip(g, semi)) <= 1
                    v_real = 4 / 3 * np.pi * semi.prod() / 1000
                    ev.append(100 * (comp.sum() * zooms.prod() / 1000 / v_real - 1))
                    ed.append(diametro_rano(comp, zooms)["d"] - 2 * semi.max())
                ev, ed = np.array(ev), np.array(ed)
                tipo = "esfera   " if semi[0] == semi[1] else "elipsoide"
                print(f"  vóxel {zooms} {tipo} diámetro real {2 * semi.max():4.0f} mm | error volumen "
                      f"{ev.mean():+5.1f} % (peor {ev[np.argmax(abs(ev))]:+5.1f} %) | error diámetro "
                      f"{ed.mean():+5.2f} mm (peor {ed[np.argmax(abs(ed))]:+5.2f} mm)")


validar()


# %% 5. Procesar TODOS los pacientes y guardar las tablas
SALIDA.mkdir(exist_ok=True)
resultados = {}
for pid in pacientes.paciente_id:
    resultados[pid] = procesar_paciente(pid)

lesiones_df = pd.concat([r["tabla"] for r in resultados.values()], ignore_index=True)
rano_df = pd.concat([r["rano"] for r in resultados.values()], ignore_index=True)
lesiones_df.to_csv(SALIDA / "lesiones_por_control.csv", index=False, encoding="utf-8-sig")
rano_df.to_csv(SALIDA / "rano_por_paciente.csv", index=False, encoding="utf-8-sig")
print(f"\nGuardado en {SALIDA}")

cols = ["paciente_id", "n_estudio", "dia", "lesion", "total_cm3", "necrosis_pct", "diam_rano_mm", "diam_3d_mm",
        "hemisferio", "region_aprox", "estado", "clase_diametro", "desacuerdo", "cambio_concluyente"]
print(lesiones_df[lesiones_df.total_cm3 > 0][cols].round(2).to_string(index=False))
print(rano_df[["paciente_id", "n_estudio", "dia", "suma_diam_mm", "suma_vol_cm3", "rano_bm", "volumetrico",
               "desacuerdo"]].round(2).to_string(index=False))


# %% 6. Vista 3D de un control (lesiones con su número, realce/necrosis y la línea del diámetro RANO)
def malla(binaria, affine, zooms, offset=(0, 0, 0), suavizado_mm=0.6):
    """Superficie 3D de una región binaria. El suavizado es solo visual:
    volúmenes y diámetros se calculan siempre sobre la máscara original."""
    if not binaria.any():
        return None
    caja = ndimage.find_objects(binaria.astype(np.uint8))[0]
    caja = tuple(slice(max(s.start - 3, 0), s.stop + 3) for s in caja)
    sub = np.pad(binaria[caja].astype(np.float32), 1)
    suave = ndimage.gaussian_filter(sub, sigma=suavizado_mm / zooms) if suavizado_mm else sub
    if suave.max() < 0.5:
        suave = sub
    vert, caras, _, _ = measure.marching_cubes(suave, level=0.5)
    vert += np.array([s.start for s in caja]) - 1 + np.asarray(offset)
    return a_mm(vert, affine), caras


def mesh3d(m, color, opacidad, nombre, texto=None):
    v, f = m
    return go.Mesh3d(x=v[:, 0], y=v[:, 1], z=v[:, 2], i=f[:, 0], j=f[:, 1], k=f[:, 2],
                     color=color, opacity=opacidad, name=nombre, showlegend=True,
                     hovertext=texto, hoverinfo="text" if texto else "skip", flatshading=False)


def vista_3d(pid, n_estudio):
    r = resultados[pid]
    k = int(np.flatnonzero(r["estudios"].n_estudio.values == n_estudio)[0])
    m, ids, ref = r["mascaras"][k], r["ids"], r["ref"]
    fig = go.Figure()
    vc, fc, _, _ = measure.marching_cubes(np.pad(ref["mascara"], 1).astype(np.float32), 0.5)
    fig.add_trace(mesh3d((a_mm((vc - 1) * ref["paso"], r["affine"]), fc), "lightgray", 0.08, "Cabeza (aprox.)"))
    t = r["tabla"][(r["tabla"].n_estudio == n_estudio) & (r["tabla"].total_cm3 > 0)]
    for _, les in t.iterrows():
        comp = ids[k] == int(les.lesion[1:])
        texto = (f"{les.lesion} · {les.estado}<br>Volumen: {les.total_cm3:.2f} cm³ "
                 f"({les.vol_min_cm3:.2f}–{les.vol_max_cm3:.2f})<br>Necrosis: {les.necrosis_pct:.0f} %"
                 f"<br>Diámetro RANO-BM: {les.diam_rano_mm:.1f} mm · 3D: {les.diam_3d_mm:.1f} mm"
                 f"<br>{les.hemisferio}, {les.region_aprox}")
        for etiqueta, color, op, nombre in ((1, "limegreen", 0.45, "realce"), (2, "crimson", 1.0, "necrosis")):
            mm = malla(comp & (m == etiqueta), r["affine"], r["zooms"], r["offset"])
            if mm:
                fig.add_trace(mesh3d(mm, color, op, f"{les.lesion} · {nombre}", texto))
        p = np.array([les.rano_p1, les.rano_p2])
        fig.add_trace(go.Scatter3d(x=p[:, 0], y=p[:, 1], z=p[:, 2], mode="lines+markers",
                                   line=dict(color="gold", width=6), marker=dict(size=3, color="gold"),
                                   name=f"{les.lesion} · diámetro RANO {les.diam_rano_mm:.1f} mm"))
    dia = r["estudios"].dia[k]
    fig.update_layout(title=f"Paciente {pid} · control {n_estudio} · día {dia}",
                      scene=dict(aspectmode="data", xaxis_title="x (mm) → derecha",
                                 yaxis_title="y (mm) → anterior", zaxis_title="z (mm) → superior"),
                      height=750, margin=dict(l=0, r=0, t=40, b=0))
    return fig


vista_3d(PACIENTE, N_ESTUDIO).show()


# %% 7. Evolución del volumen por lesión con los tratamientos
def grafico_evolucion(pid):
    t = resultados[pid]["tabla"]
    fig = px.line(t, x="dia", y="total_cm3", color="lesion", markers=True,
                  error_y=t.vol_max_cm3 - t.total_cm3, error_y_minus=t.total_cm3 - t.vol_min_cm3,
                  labels={"total_cm3": "Volumen total (cm³)", "dia": "Día", "lesion": "Lesión"},
                  title=f"Paciente {pid} · volumen por lesión")
    for tr in tratamientos[tratamientos.paciente_id == pid].itertuples():
        if pd.notna(tr.dia_inicio) and tr.dia_inicio >= t.dia.min() - 30 and "sistémico" not in str(tr.tipo):
            fig.add_vline(x=tr.dia_inicio, line_dash="dot", line_color="gray",
                          annotation_text=str(tr.tipo).split("(")[-1].rstrip(")"), annotation_position="top")
    return fig


grafico_evolucion(PACIENTE).show()
