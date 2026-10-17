#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo '请使用 sudo bash 运行本脚本'; exit 1; fi
target_user="${1:-${SUDO_USER:-}}"
if [ -z "$target_user" ]; then echo "请指定目标 Linux 用户"; exit 1; fi
id "$target_user" >/dev/null
systemctl enable --now ssh
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
loginctl enable-linger "$target_user"
mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nIdleAction=ignore\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\n' > /etc/systemd/logind.conf.d/70-rack-console.conf
# Do not restart logind: preserve the current desktop and SSH sessions.
echo '已配置：开机 SSH、防休眠、用户服务常驻。logind 设置在下次重启后生效。'
echo '未修改网络地址、驱动、sudo 权限或 SSH 密码认证。'
