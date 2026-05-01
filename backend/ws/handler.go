package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/google/uuid"
)

const (
	// authTimeout 握手鉴权超时
	authTimeout = 3 * time.Second
	// readTimeout 单次读取超时（防止假死）
	readTimeout = 60 * time.Second
	// Phase 6.3: 应用层心跳保活
	pingInterval   = 10 * time.Second
	pongTimeout    = 20 * time.Second
	maxMissedPongs = 2
)

// WSHandler Gin Handler for WebSocket 升级
func WSHandler(manager *WSManager) gin.HandlerFunc {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	return func(c *gin.Context) {
		// 升级连接（不验证 token，鉴权在 readPump 中完成）
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("ws: upgrade failed: %v", err)
			return
		}

		ctx, cancel := context.WithCancel(context.Background())
		client := &Client{
			conn:       conn,
			sessionID:  uuid.New().String(),
			remoteAddr: c.ClientIP(),
			ctx:        ctx,
			cancel:     cancel,
			authorized: false,
		}

		manager.Register(client)
		log.Printf("ws: connected %s (total: %d)", client.sessionID, manager.Count())

		// Phase 6.3: 启动应用层 Ping/Pong 保活
		go startPingPong(client)

		go readPump(client, manager)
	}
}

// readPump 循环读取 WebSocket 消息
func readPump(client *Client, manager *WSManager) {
	defer func() {
		manager.Unregister(client)
		_ = client.conn.Close()
		log.Printf("ws: disconnected %s (total: %d)", client.sessionID, manager.Count())
	}()

	// 设置 auth 超时
	authCtx, authCancel := context.WithTimeout(client.ctx, authTimeout)
	defer authCancel()

	authDone := make(chan struct{})
	go func() {
		for {
			select {
			case <-authCtx.Done():
				// auth 超时，断开连接
				log.Printf("ws: auth timeout for %s (remote: %s), closing", client.sessionID, client.remoteAddr)
				return
			default:
			}

			_ = client.conn.SetReadDeadline(time.Now().Add(readTimeout))
			typ, msg, err := client.conn.ReadMessage()
			if err != nil {
				log.Printf("ws: read error during auth %s: %v", client.sessionID, err)
				return
			}

			if typ != websocket.TextMessage {
				// 忽略非文本帧（如 binary、ping、pong）
				continue
			}

			var wsMsg WSMessage
			if err := json.Unmarshal(msg, &wsMsg); err != nil {
				// 解析失败，静默丢弃
				continue
			}

			if wsMsg.Type == "auth" {
				var authPayload AuthPayload
				if err := json.Unmarshal(wsMsg.Payload, &authPayload); err != nil {
					continue
				}

				// 验证 token
				username, ok := validateJWT(authPayload.Token)
				if !ok {
					log.Printf("ws: auth failed for %s (remote: %s) - invalid or expired token", client.sessionID, client.remoteAddr)
					return
				}

				client.mu.Lock()
				client.authorized = true
				client.username = username
				client.mu.Unlock()

				// 回复 auth_success
				ackMsg, _ := json.Marshal(map[string]interface{}{
					"type": "auth_success",
					"payload": map[string]string{
						"sessionID": client.sessionID,
						"username":  username,
					},
				})
				client.mu.Lock()
				_ = client.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				_ = client.conn.WriteMessage(websocket.TextMessage, ackMsg)
				client.mu.Unlock()

				log.Printf("ws: authorized %s as %s (remote: %s)", client.sessionID, username, client.remoteAddr)
				close(authDone)
				return
			}
			// 非 auth 帧，静默丢弃（等待 auth 完成）
		}
	}()

	// 等待 auth 完成或超时
	select {
	case <-authDone:
		// auth 成功，进入正常消息处理循环
	case <-authCtx.Done():
		// 超时已在上面的 goroutine 中处理
		return
	}

	// 正常消息处理循环
	for {
		select {
		case <-client.ctx.Done():
			return
		default:
		}

		_ = client.conn.SetReadDeadline(time.Now().Add(readTimeout))
		typ, msg, err := client.conn.ReadMessage()

		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return
			}
			log.Printf("ws: read error %s: %v", client.sessionID, err)
			return
		}

		if typ != websocket.TextMessage {
			continue
		}

		// 检查是否已授权
		client.mu.Lock()
		authorized := client.authorized
		client.mu.Unlock()
		if !authorized {
			continue
		}

		var wsMsg WSMessage
		if err := json.Unmarshal(msg, &wsMsg); err != nil {
			log.Printf("ws: json parse error %s: %v", client.sessionID, err)
			continue
		}

		// 分发消息
		handleMessage(client, manager, wsMsg)
	}
}

// handleMessage 分发 WebSocket 消息到对应处理器
func handleMessage(client *Client, manager *WSManager, msg WSMessage) {
	switch msg.Type {
	case "memo_update":
		handleMemoUpdate(client, manager, msg.Payload)
	case "todo_update":
		handleTodoUpdate(client, manager, msg.Payload)
	case "network_mode":
		handleNetworkMode(client, manager, msg.Payload)
	case "network_heartbeat":
		handleNetworkHeartbeat(client, manager, msg.Payload)
	case "ping":
		// 心跳 ping，无需回复
	default:
		log.Printf("ws: unknown message type: %s", msg.Type)
	}
}

// startPingPong Phase 6.3: 应用层心跳保活（替代 TCP Keepalive）
// 每 10 秒发送应用层 ping 消息，依靠 readPump 的 readTimeout 检测假死。
//
// nhooyr.io/websocket 在协议层自动处理 Ping/Pong，但协议层 Ping 无法检测
// 隧道拥塞（TCP OPEN 但数据发不出）。使用应用层 JSON ping 消息，结合
// readPump 的 readTimeout，可以在隧道假死时及时断开。
func startPingPong(client *Client) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			pingMsg, _ := json.Marshal(map[string]interface{}{
				"type":    "ping",
				"payload": map[string]int64{"ts": time.Now().UnixMilli()},
			})
			client.mu.Lock()
			_ = client.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			err := client.conn.WriteMessage(websocket.TextMessage, pingMsg)
			client.mu.Unlock()
			if err != nil {
				log.Printf("ws: ping write error %s: %v", client.sessionID, err)
				_ = client.conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "ping failed"),
					time.Now().Add(time.Second),
				)
				_ = client.conn.Close()
				return
			}
		case <-client.ctx.Done():
			return
		}
	}
}
