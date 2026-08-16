# 腾讯云 Lighthouse 部署（systemd）

> 本项目服务器（lhins-9kq77x9k，北京）实际部署在 **`/root/TianwenStarway`**，
> venv 在 `/root/TianwenStarway/venv`（不在 src/backend 下）。
> 由于 `/root` 权限为 700、www-data 无法进入，systemd 服务以 **root** 运行（与之前 nohup 裸进程一致）。
> 以下命令路径均按服务器实际情况书写。

## 首次部署

```bash
# 1. 克隆代码
git clone <repo-url> /root/TianwenStarway

# 2. 创建虚拟环境并安装依赖
cd /root/TianwenStarway/src/backend
python3 -m venv /root/TianwenStarway/venv
/root/TianwenStarway/venv/bin/pip install -r requirements.txt

# 3. 录入密钥（不要提交到 git）
cp .env.example .env
vim /root/TianwenStarway/src/backend/.env

# 4. 安装 systemd 服务
sudo cp /root/TianwenStarway/deployment/tianwen.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tianwen
```

## 日常运维

```bash
sudo systemctl status tianwen      # 查看状态
sudo systemctl restart tianwen     # 更新代码后重启
journalctl -u tianwen -f           # 看实时日志
```

## 从 nohup 迁移（已完成 2026-08-16）

旧裸进程（PID 796089）已 kill，现由 systemd 托管（PID 805635）。迁移步骤：

```bash
# 1. 停掉现有裸进程
pkill -f "uvicorn main:app"

# 2. 安装并启动 systemd 服务
sudo cp /root/TianwenStarway/deployment/tianwen.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tianwen

# 3. 验证
curl http://127.0.0.1:8080/health   # 期望 200
systemctl is-enabled tianwen         # 期望 enabled
```

## 数据目录写权限

服务以 root 运行，`data/sessions/`（会话 JSON 落盘）root 可写，无需额外 chown。
若将来改用 www-data 运行，需执行：

```bash
sudo chown -R www-data:www-data /root/TianwenStarway/src/backend/data
```
