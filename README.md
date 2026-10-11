# Graph3D: seguimiento de metástasis cerebrales (BioChallenge ITBA)

Herramienta para evaluar la evolución de metástasis cerebrales entre resonancias de control, a partir de la T1 con contraste y su segmentación (1 = realce, 2 = necrosis).

## Qué hace
- **Mide cada lesión en 3D:** volumen total, realce y necrosis (cm³), con margen de error (borde ±0,5 mm).
- **Sigue cada lesión en el tiempo** (L1, L2…) y detecta lesiones nuevas.
- **Diámetro RANO-BM** automático (corte axial, contorno externo), perpendicular, solo realce y máximo 3D.
- **Evolución por lesión** con el criterio volumétrico de Ocaña-Tienda 2024: nueva, en aumento, estable o en disminución. Comparación con el basal y el nadir, y aviso de "no concluyente" cuando la clase depende del margen de error.
- **Vista 3D interactiva:** lesiones, mapa de la zona que creció o se redujo, y recorrido en el tiempo con formas intermedias.
- **Ubicación aproximada** en un cerebro de referencia (MNI152), en cortes sagital, coronal y axial.
- **Resumen del paciente** con tratamientos y notas del médico.

## Cómo usarlo
1. Instalar las dependencias:
   ```
   pip install numpy pandas nibabel scipy scikit-image plotly openpyxl matplotlib flask nilearn
   ```
2. Poner el dataset (`dataset.xlsx` + `imagenes/`) en una carpeta y apuntar `BASE` a ella en `lesion_3d.py`.
3. Generar los casos de ejemplo (unos 5 minutos): `python exportar_dashboard.py`
4. Abrir la herramienta: doble clic en `INICIAR.bat` (o `python servidor.py`) → http://localhost:8000

Desde la pantalla **Cargar estudios** se pueden analizar resonancias nuevas (imagen + segmentación de cada control, corregistradas).

## Archivos
- `lesion_3d.py`: motor de cálculo (separación y seguimiento de lesiones, volumen, diámetro, clasificación). Incluye una validación con lesiones artificiales de medida conocida.
- `atlas.py`: cerebro de referencia y regiones para la ubicación aproximada.
- `exportar_dashboard.py`: prepara los datos de la interfaz (superficies 3D, transiciones, cortes).
- `servidor.py`: servidor local (carga de estudios, historial y notas).
- `dashboard/`: la interfaz web.

El dataset, los resultados, el historial y las notas no se suben al repositorio (son datos médicos).

Herramienta de apoyo: no reemplaza el criterio médico ni establece un diagnóstico.
