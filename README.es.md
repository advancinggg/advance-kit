<p align="center">
  <img src="docs/assets/banner.png" alt="Advance" width="640">
</p>

<p align="center">
  <strong>Flujos de desarrollo rigurosos para Claude Code.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="Licencia MIT"></a>
  <a href="https://github.com/advancinggg/advance-kit/releases"><img src="https://img.shields.io/github/v/release/advancinggg/advance-kit?include_prereleases&style=for-the-badge" alt="Última versión"></a>
  <a href="https://github.com/advancinggg/advance-kit/stargazers"><img src="https://img.shields.io/github/stars/advancinggg/advance-kit?style=for-the-badge" alt="Estrellas en GitHub"></a>
  <a href="https://x.com/Advancinggg"><img src="https://img.shields.io/badge/seguir-%40Advancinggg-000000?style=for-the-badge&logo=x&logoColor=white" alt="Seguir a @Advancinggg en X"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-marketplace%20de%20plugins-7c3aed?style=for-the-badge" alt="Marketplace de plugins de Claude Code">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>Español</b>
</p>

---

## Resumen

**advance-kit** es un marketplace de plugins para
[Claude Code](https://github.com/anthropics/claude-code) creado por Advance Studio.
Agrupa tres plugins listos para producción que convierten a Claude Code, de un
asistente servicial, en un colaborador de ingeniería disciplinado: planificación
dirigida por especificaciones, auditoría cruzada con doble modelo, control de acceso
a archivos por fases y una superficie nativa de aprobaciones en macOS.

## Plugins

### `dev` — Flujo de desarrollo forzado

Obliga a que toda tarea de desarrollo recorra el ciclo completo
**plan → docs → implement → audit → test → summary**. Un hook `PreToolUse` regula el
acceso a archivos por fase, de modo que el agente principal no pueda saltarse pasos
ni mutar en silencio archivos fuera del paso actual.

- **Revisión con doble modelo** — cada punto de auditoría ejecuta un subagente de
  Claude (contexto aislado) *y* una pasada de `codex exec` (exploración agente), y
  luego fusiona los hallazgos de ambos modelos.
- **Arquitectura de evaluadores independientes** — las fases plan / audit / test /
  adversarial lanzan evaluadores nuevos en cada ronda, con cero contexto de
  implementación, y usan métricas de convergencia estructuradas
  (`substantive_count`, `pass_rate`) como criterio objetivo de decisión.
- **Descomposición de módulos dirigida por especificación** — la skill `/spec`
  incluida transforma un PRD en un documento de arquitectura y especificaciones
  MODULE autocontenidas, listas para entregar a un agente de IA para su
  implementación.
- **Compuertas de regresión entre módulos** — cuando una tarea toca un contrato
  declarado en `ARCHITECTURE.md §6.1`, el flujo realiza una búsqueda inversa de los
  módulos dependientes y ejecuta el Regression Check sobre su libro histórico de
  criterios de aceptación verificados.

**Skills:**
- `/dev [descripción de la tarea]` — ejecuta el flujo forzado completo
- `/dev status | resume | abort | doctor` — inspeccionar, retomar o reiniciar un flujo en curso
- `/spec [ruta/al/PRD.md]` — genera arquitectura y especificaciones MECE de módulos a partir de un PRD

**Agentes:**
- `claude-auditor` — revisor de contexto aislado usado en cada punto de auditoría

**Comandos:**
- `/dev:setup` — instala las dependencias opcionales (Codex CLI) para la revisión
  con doble modelo

### `claude-best-practice` — Contexto de buenas prácticas

Skill de fondo (no invocada por el usuario) que enseña a Claude Code la disciplina
esencial para trabajar dentro de un repositorio real: secuencia
explore-plan-code, desarrollo con verificación primero, gestión del contexto,
acotado de prompts, corrección de rumbo y estrategia de sesión. Se carga como
material de referencia y no como comando slash.

### `code-companion` — Dynamic Island de macOS para agentes de código

Un indicador flotante nativo de macOS que concentra las aprobaciones pendientes y
las sesiones activas de Claude Code, Codex y Gemini CLI. Haz clic en una
notificación para saltar directamente al terminal de origen, con contexto completo
sobre lo que está esperando tu aprobación.

## Instalación

```bash
# 1. Añadir el marketplace (una sola vez)
claude plugin marketplace add advancinggg/advance-kit

# 2. Instalar los plugins que necesites
claude plugin install dev@advance-kit
claude plugin install claude-best-practice@advance-kit
claude plugin install code-companion@advance-kit

# 3. (Opcional) Instalar dependencias para la revisión con doble modelo
/dev:setup
```

## Actualización

```bash
claude plugin update dev
claude plugin update claude-best-practice
claude plugin update code-companion
```

## Dependencias opcionales

El plugin `dev` admite revisión con doble modelo (Claude + Codex). Sin Codex,
degrada automáticamente a revisión con un solo modelo y anota las conclusiones de la
auditoría como `single-model`.

Para habilitar la revisión con doble modelo:

1. Instala el [Codex CLI](https://github.com/openai/codex).
2. Ejecuta `/dev:setup` para instalar el plugin de Codex correspondiente.
3. Verifícalo con `/dev doctor`.

## Opcional: statusline

El plugin `dev` incluye una statusline de dos líneas (uso del contexto, límites de
5 horas y 7 días, nombre del modelo, conteo de tokens). Claude Code solo carga
`statusLine` desde la configuración del usuario — los plugins no pueden declararla —
así que conéctala manualmente:

```bash
# 1. Copia el script a una ruta estable
mkdir -p ~/.claude/bin
curl -fsSL https://raw.githubusercontent.com/advancinggg/advance-kit/main/plugins/dev/bin/statusline.sh \
  -o ~/.claude/bin/statusline.sh
chmod +x ~/.claude/bin/statusline.sh
```

Luego añade a `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/bin/statusline.sh",
    "padding": 1
  }
}
```

## Estado del proyecto

| Plugin | Versión | Estado |
|---|---|---|
| `dev` | `2.3.0` | Estable — fórmula de progreso basada en AC; numeración de secciones /dev ↔ /spec alineada. Añade nueva skill **`/prd`** para generación iterativa de PRD (diálogo guiado one-question-per-turn + evaluador de cobertura de 4 dimensiones — adaptado del skill de brainstorming de Jesse Obra). La plantilla MODULE gana §1.1 "Serves PRD topics" (mapeo inverso), §2.13 Operations (runbook) y §2.14 Observability (esquema de logs/métricas/trazas). Incluye skills `dev` / `spec` / `prd` y statusline opcional. |
| `claude-best-practice` | `1.0.0` | Estable |
| `code-companion` | `1.0.0` | Estable (solo macOS) |

## Contacto

- **X / Twitter**: [@Advancinggg](https://x.com/Advancinggg)
- **Correo**: [admin@advance.studio](mailto:admin@advance.studio)

Los reportes de errores y las solicitudes de funcionalidades son bienvenidos vía
[GitHub Issues](https://github.com/advancinggg/advance-kit/issues).

## Licencia

[MIT](LICENSE) © Advance Studio
