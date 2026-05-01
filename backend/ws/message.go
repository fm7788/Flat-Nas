package ws

import "encoding/json"

// WSMessage 统一 WebSocket 消息格式
type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// AuthPayload 握手鉴权消息
type AuthPayload struct {
	Token string `json:"token"`
}

// MemoUpdatePayload 备忘录更新
type MemoUpdatePayload struct {
	Token   string      `json:"token"`
	WidgetID string     `json:"widgetId"`
	Content interface{} `json:"content"`
}

// TodoUpdatePayload 待办更新
type TodoUpdatePayload struct {
	Token   string      `json:"token"`
	WidgetID string     `json:"widgetId"`
	Content interface{} `json:"content"`
}

// NetworkModePayload 网络模式切换
type NetworkModePayload struct {
	Token string `json:"token"`
	Mode  string `json:"mode"`
}

// NetworkHeartbeatPayload 网络心跳
type NetworkHeartbeatPayload struct {
	Token string `json:"token"`
}

// DataUpdatedPayload 数据更新广播
type DataUpdatedPayload struct {
	Username string `json:"username"`
	Version  int64  `json:"version"`
}
