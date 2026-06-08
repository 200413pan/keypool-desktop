#!/bin/bash

# API密钥池代理服务启动脚本

echo "========================================"
echo "  API密钥池代理服务"
echo "========================================"
echo ""

# 检查Node.js是否安装
if ! command -v node &> /dev/null; then
    echo "错误: 未安装Node.js，请先安装Node.js"
    echo "下载地址: https://nodejs.org/"
    exit 1
fi

# 检查配置文件是否存在
if [ ! -f "api_keys.json" ]; then
    echo "警告: 配置文件 api_keys.json 不存在"
    echo "正在创建示例配置文件..."
    cat > api_keys.json << 'EOF'
{
  "api_keys": [
    {
      "name": "账户1",
      "key": "your-api-key-1-here",
      "daily_quota": 1000,
      "used_today": 0,
      "last_reset": null,
      "enabled": true
    },
    {
      "name": "账户2",
      "key": "your-api-key-2-here",
      "daily_quota": 1000,
      "used_today": 0,
      "last_reset": null,
      "enabled": true
    }
  ]
}
EOF
    echo "已创建 api_keys.json，请编辑文件添加你的API密钥"
    echo ""
fi

echo "启动代理服务..."
echo "服务地址: http://127.0.0.1:8080"
echo "聊天接口: http://127.0.0.1:8080/v1/chat/completions"
echo "状态接口: http://127.0.0.1:8080/status"
echo "健康检查: http://127.0.0.1:8080/health"
echo ""
echo "按 Ctrl+C 停止服务"
echo "========================================"
echo ""

node api-key-pool-proxy-enhanced.js
