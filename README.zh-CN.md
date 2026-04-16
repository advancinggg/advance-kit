<p align="center">
  <img src="docs/assets/banner.png" alt="Advance" width="640">
</p>

<p align="center">
  <strong>为 Claude Code 打造的严谨开发工作流。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/advancinggg/advance-kit/releases"><img src="https://img.shields.io/github/v/release/advancinggg/advance-kit?include_prereleases&style=for-the-badge" alt="Latest release"></a>
  <a href="https://github.com/advancinggg/advance-kit/stargazers"><img src="https://img.shields.io/github/stars/advancinggg/advance-kit?style=for-the-badge" alt="GitHub stars"></a>
  <a href="https://x.com/Advancinggg"><img src="https://img.shields.io/badge/follow-%40Advancinggg-000000?style=for-the-badge&logo=x&logoColor=white" alt="在 X 上关注 @Advancinggg"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin%20marketplace-7c3aed?style=for-the-badge" alt="Claude Code 插件市场">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b> · <a href="README.es.md">Español</a>
</p>

---

## 概览

**advance-kit** 是 Advance Studio 打造的 [Claude Code](https://github.com/anthropics/claude-code)
插件市场，汇集三个生产级插件，把 Claude Code 从"能用的助手"升级为"有纪律的工程协作者"：
规格驱动的计划、跨模型双审计、阶段化文件访问控制，以及原生 macOS 审批状态条。

## 插件列表

### `dev`——强制开发工作流

对每个开发任务强制执行完整闭环：**plan → docs → implement → audit → test → summary**。
通过 `PreToolUse` hook 按阶段控制文件访问权限，主 agent 无法跨阶段或静默修改当前步骤之外的文件。

- **双模型审查**——每个审查点都会并行运行 Claude subagent（隔离上下文）与 Codex exec
  （agent 自主探索），再跨模型合并结论。
- **独立评估器架构**——plan / audit / test / adversarial 每一轮都启动全新评估器，
  零实现上下文，以结构化收敛指标（`substantive_count`、`pass_rate`）作为客观判定依据。
- **规格驱动模块拆分**——内置 `/spec` skill 把 PRD 转换成架构文档和自包含的 MODULE 规范，
  直接交付给 AI agent 实现。
- **跨模块回归门禁**——当任务修改 `ARCHITECTURE.md §6.1` 中声明的 contract 时，
  工作流会反查下游模块并基于其历史验证 AC 账本运行 Regression Check。

**Skills：**
- `/dev [任务描述]` —— 运行完整的强制工作流
- `/dev status | resume | abort | doctor` —— 查看、恢复或重置进行中的工作流
- `/spec [PRD 路径]` —— 从 PRD 生成架构文档和 MECE 模块规范

**Agents：**
- `claude-auditor` —— 每个审查点使用的隔离上下文审查者

**Commands：**
- `/dev:setup` —— 安装可选依赖（Codex CLI），启用双模型审查

### `claude-best-practice`——工作方法指引

后台加载（不是用户触发）的指引 skill，教会 Claude Code 在真实代码库里工作的核心纪律：
explore-plan-code 顺序、验证优先、上下文管理、prompt 精细化、航向修正、会话策略等。
作为参考材料自动加载，而非通过 slash 命令调用。

### `code-companion`——面向代码 agent 的 macOS 灵动岛

原生 macOS 悬浮状态条，聚合 Claude Code、Codex、Gemini CLI 的待审批和活跃会话，
点击通知即可直接跳回对应终端，并附带丰富的上下文说明等待的内容。

## 安装

```bash
# 1. 添加 marketplace（只需一次）
claude plugin marketplace add advancinggg/advance-kit

# 2. 安装需要的插件
claude plugin install dev@advance-kit
claude plugin install claude-best-practice@advance-kit
claude plugin install code-companion@advance-kit

# 3.（可选）安装双模型审查所需的依赖
/dev:setup
```

## 更新

```bash
claude plugin update dev
claude plugin update claude-best-practice
claude plugin update code-companion
```

## 可选依赖

`dev` 插件支持双模型审查（Claude + Codex）。如果没有 Codex，会自动降级为单模型审查，
并在审查结论中标注为 `single-model`。

启用双模型审查：

1. 安装 [Codex CLI](https://github.com/openai/codex)。
2. 运行 `/dev:setup` 拉取匹配的 Codex 插件。
3. 用 `/dev doctor` 验证环境。

## 可选：statusline

`dev` 插件自带一个两行状态栏（上下文用量、5 小时 / 7 天限额、模型名、token 统计）。
Claude Code 的 `statusLine` 只能从用户 settings 加载，插件无法自己声明，所以需要手动接线：

```bash
# 1. 把脚本放到一个稳定路径
mkdir -p ~/.claude/bin
curl -fsSL https://raw.githubusercontent.com/advancinggg/advance-kit/main/plugins/dev/bin/statusline.sh \
  -o ~/.claude/bin/statusline.sh
chmod +x ~/.claude/bin/statusline.sh
```

然后在 `~/.claude/settings.json` 里加上：

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/bin/statusline.sh",
    "padding": 1
  }
}
```

## 项目状态

| 插件 | 版本 | 状态 |
|---|---|---|
| `dev` | `2.0.1` | 稳定版——包含 `dev` / `spec` skill 和可选的 statusline |
| `claude-best-practice` | `1.0.0` | 稳定版 |
| `code-companion` | `1.0.0` | 稳定版（仅 macOS） |

## 联系方式

- **X / Twitter**：[@Advancinggg](https://x.com/Advancinggg)
- **邮箱**：[admin@advance.studio](mailto:admin@advance.studio)

欢迎通过 [GitHub Issues](https://github.com/advancinggg/advance-kit/issues)
提交 bug 反馈或功能建议。

## 许可证

[MIT](LICENSE) © Advance Studio
