# BioChallenge ITBA: seguimiento de metástasis cerebrales

Herramienta para planificar el tratamiento de metástasis cerebrales a partir de las resonancias de seguimiento segmentadas.

## Parte 1: motor de cálculo (`lesion_3d.py`)
- Separa cada lesión en 3D y la sigue en el tiempo (L1, L2…), y detecta lesiones nuevas.
- Volumen total, de realce y de necrosis (cm³), con rango de incertidumbre.
- Ubicación: coordenadas en mm, corte, hemisferio y región aproximada.
- Diámetro RANO-BM (axial, contorno externo), perpendicular y diámetro máximo 3D.
- Clasificación RANO-BM y volumétrica (Ocaña-Tienda 2024, Huang 2025), con alerta cuando no coinciden.
- Mapa de cambio entre controles (cm³ crecidos/reducidos y dirección) y estimaciones de crecimiento.
- Validación con lesiones artificiales de medida conocida.

## Cómo correrlo
```
pip install numpy pandas nibabel scipy scikit-image plotly openpyxl
```
1. Poner el dataset (`dataset.xlsx` + `imagenes/`) en una carpeta y apuntar `BASE` a ella (celda 1).
2. Correr `python lesion_3d.py`, o celda por celda en VS Code.
3. Las tablas quedan en `DATASET/resultados/`.

El dataset no se incluye en el repositorio.
