# selectel-ops

Скилл для работы с облаком Selectel из Claude Code: модель доступа и роли сервисных пользователей,
токены нужного scope, проекты, флейворы, образы, типы дисков, DNS v2, диагностика ошибок API и
проверенные особенности стыка Selectel с Pulumi (`terraform-provider-selectel`) и Ansible
(`clouds.yaml`, dynamic inventory `openstack.cloud`).

В комплекте `scripts/selectel.py` — диагностика доступа одной командой. Скрипт только читает:
ни создания, ни удаления ресурсов.

## Требования

- Python 3.8 или новее. Сторонние пакеты не нужны; `PyYAML` — только для чтения `clouds.yaml`
  (`pip install pyyaml`), без него креды задаются переменными `SELECTEL_ACCOUNT`, `SELECTEL_USERNAME`,
  `SELECTEL_PASSWORD`.
- По желанию `openstack` CLI (`pip install python-openstackclient`) — так удобнее смотреть флейворы,
  образы и типы дисков.
- Сервисный пользователь Selectel с ролью `member` на аккаунт.

## Установка

```text
/plugin marketplace add YarikMix/agent-utils
/plugin install selectel-ops@yarikmix-plugins
```

## Проверка доступа

```bash
python3 ~/.claude/plugins/marketplaces/yarikmix-plugins/plugins/selectel-ops/skills/selectel-ops/scripts/selectel.py --cloud <имя-облака-из-clouds.yaml> check
```

После установки путь можно уточнить через `ls ~/.claude/plugins/marketplaces/`.

Четыре `[OK]` (без `project_id` в `clouds.yaml` — два `[OK]` и два `[SKIP]`) и `ИТОГ: OK` —
можно работать. Расшифровка `[FAIL]` — в `SKILL.md`, раздел
«Когда что-то не получается».

## Чего скилл не делает

Не пишет в облако (создание и удаление — через Pulumi или руками в панели), не автоматизирует
панель через браузер, не покрывает S3, Managed Kubernetes, DBaaS и биллинг.

## Installation

Requires Python 3.8+. Optional: `pyyaml` (to read `clouds.yaml`) and `python-openstackclient`.

```text
/plugin marketplace add YarikMix/agent-utils
/plugin install selectel-ops@yarikmix-plugins
```

Then run `python3 ~/.claude/plugins/marketplaces/yarikmix-plugins/plugins/selectel-ops/skills/selectel-ops/scripts/selectel.py --cloud <name> check` to verify access. The skill is read-only.
