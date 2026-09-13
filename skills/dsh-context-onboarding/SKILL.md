---
name: dsh-context-onboarding
description: 已停用（2026-09-13）。背景不由 Codex 整理：扫描电脑、第一次见面、登记来源都是 DSH 按框架自己做的事。需要建立或刷新背景时，按 dsh-dialogue 派一个任务给 DSH。
---

# 已停用：背景由 DSH 自己建

这个 Skill 原来让 Codex 读个人规则文件、写 `BRIEF.md`、生成个人 Skill、`node CLIENT onboard` 登记来源。框架版（`Desktop\DSH-Study\FRAMEWORK.md`）之后这些都不再由 Codex 做：

- 扫描电脑按 `protocols/DISCOVERY.md`，第一次见面按 `protocols/CONVERSATION.md`，都是 DSH 在收到框架开场后自己做的；Codex 只把用户的原话派过去（见 `dsh-dialogue` Skill 第 2 步）。
- 不要写或改 `connection/context/BRIEF.md`，不要生成个人 Skill，不要跑 `onboard`。
- 用户明确要"重新扫一遍"或"补充某个来源"时，写成任务派给 DSH：告诉它真实路径，让它自己读、自己登记。

原文备份在 `Desktop\DSH-Study\connection\archive\codex-skill-v0.3\dsh-context-onboarding.SKILL.md`。
