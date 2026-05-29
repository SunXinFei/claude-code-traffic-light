#!/bin/bash
set -e

echo "=== Claude Code Traffic Light 构建脚本 ==="

# 检查虚拟环境
if [ ! -d "venv" ]; then
    echo "创建虚拟环境..."
    python3 -m venv venv
fi

source venv/bin/activate

# 安装依赖
echo "安装依赖..."
pip install --upgrade pip
pip install -r requirements.txt

# 清理旧构建
echo "清理旧构建..."
rm -rf build dist *.spec

# 使用 PyInstaller 打包
echo "打包中..."
pyinstaller \
    --name "ClaudeTrafficLight" \
    --windowed \
    --noconfirm \
    --clean \
    --icon "traffic_light.icns" \
    --add-data "traffic_light.py:." \
    traffic_light.py

echo "=== 构建完成 ==="
echo "应用位置: dist/ClaudeTrafficLight.app"
