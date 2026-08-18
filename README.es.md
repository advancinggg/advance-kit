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

- **Revisión con doble evaluador** — cada punto de auditoría ejecuta dos evaluadores
  independientes y fusiona sus hallazgos. El backend se detecta automáticamente en
  tiempo de ejecución (3.10.0+): bajo Claude Code / harnesses compatibles, un
  subagente de Claude (contexto aislado) *y* una pasada de `codex exec` (exploración
  agente, entre modelos); bajo Grok Build, dos evaluadores nativos paralelos vía
  `spawn_subagent` (auditor estándar + contraexaminador reforzado) — sin necesidad
  del CLI de Codex.
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
- `/dev status | board | resume | abort | doctor` — inspeccionar (incluye `board`, panel snapshot de solo lectura, 2.9.0+), retomar o reiniciar un flujo en curso
- `/dev worktree-new | worktree-list | worktree-finish | worktree-remove` — gestionar worktrees paralelos para tareas /dev concurrentes (2.8.0+)
- `/spec [ruta/al/PRD.md]` — genera arquitectura y especificaciones MECE de módulos a partir de un PRD

**Agentes:**
- `claude-auditor` — revisor de contexto aislado usado en cada punto de auditoría

**Comandos:**
- `/dev:setup` — instala las dependencias opcionales (Codex CLI) para el backend de
  revisión claude+codex (innecesario bajo Grok Build, que usa subagentes nativos)

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

El plugin `dev` ejecuta la revisión con doble evaluador según el backend detectado
en tiempo de ejecución:

- **Claude Code / harnesses compatibles (`claude+codex`)**: subagente de Claude +
  Codex exec. Sin Codex, degrada automáticamente a revisión con un solo evaluador y
  lo anota en las conclusiones de la auditoría.
- **Grok Build (`grok-dual`)**: dos evaluadores nativos paralelos vía
  `spawn_subagent` — sin dependencias extra; no hay nada que instalar.

Para habilitar la revisión entre modelos bajo el backend `claude+codex`:

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
| `dev` | `3.10.0` | Estable — flujo /dev + /spec + /prd con revisión de doble evaluador (backend claude+codex o grok-dual), progreso MODULE por AC, ADR system, /dev paralelo por worktree, panel snapshot de solo lectura `/dev board`, capa de aceptación de sistema, visibilidad de deriva de versión de plantilla. Incluye skills `dev` / `spec` / `prd` + statusline opcional. **Más reciente:** 3.10.0 añade un backend de revisión para Grok Build — /dev detecta el runtime automáticamente (state v7 `review_backend`) y ejecuta cada punto de revisión (plan / doc-audit / diff / test / adversarial) como dos evaluadores nativos paralelos vía `spawn_subagent` (auditor estándar + contraexaminador reforzado), sin CLI de Codex; el backend claude+codex no cambia. **Anterior:** 3.9.0 reparación del enforcement PreToolUse (forma `hookSpecificOutput`) + endurecimiento del bucle, 3.8.0 compuerta mecánica de paridad de ledger en salida de DOCS, 3.7.0 paridad §1.5↔§3.4 (§1.5 autoritativo + compuertas fail-closed). |
| `claude-best-practice` | `1.0.0` | Estable |
| `code-companion` | `1.0.0` | Estable (solo macOS) |
| `telegram-channels-pro` | `0.1.3` | v0.1 completo (solo macOS) — 8 módulos: daemon-core + telegram-client + mcp-server-proxy + admin-auth + observability + mcp-tools (5 herramientas MCP) + routing (LRU + control de admin + comandos slash) + deployment (CLI launchd + socket de control + ROLLBACK.md). |

## Contacto

- **X / Twitter**: [@Advancinggg](https://x.com/Advancinggg)
- **Correo**: [admin@advance.studio](mailto:admin@advance.studio)

Los reportes de errores y las solicitudes de funcionalidades son bienvenidos vía
[GitHub Issues](https://github.com/advancinggg/advance-kit/issues).

## Licencia

[MIT](LICENSE) © Advance Studio
