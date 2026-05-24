package ws

import (
	"context"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WSManager 管理所有 WebSocket 连接
type WSManager struct {
	clients map[string]*Client
	mu      sync.RWMutex
}

// Client 表示一个 WebSocket 连接
type Client struct {
	conn       *websocket.Conn
	sessionID  string
	remoteAddr string
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex // 保护 conn.Write 并发调用

	authorized bool
	username   string
}

// NewManager 创建 WebSocket 管理器
func NewManager() *WSManager {
	return &WSManager{
		clients: make(map[string]*Client),
	}
}

// Register 注册客户端
func (m *WSManager) Register(client *Client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients[client.sessionID] = client
}

// Unregister 注销客户端
func (m *WSManager) Unregister(client *Client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.clients[client.sessionID]; ok {
		client.cancel()
		delete(m.clients, client.sessionID)
	}
}

// Broadcast 向所有已授权客户端广播消息（排除指定 sessionID）
// 每个客户端在独立 goroutine 中写入，带 2 秒超时，防止慢客户端阻塞整个广播
func (m *WSManager) Broadcast(message []byte, excludeSessionID string) {
	m.mu.RLock()
	clients := make([]*Client, 0, len(m.clients))
	for id, c := range m.clients {
		if id == excludeSessionID {
			continue
		}
		if c.authorized {
			clients = append(clients, c)
		}
	}
	m.mu.RUnlock()

	for _, c := range clients {
		go func(client *Client) {
			client.mu.Lock()
			defer client.mu.Unlock()
			if client.ctx.Err() != nil {
				return
			}
			_ = client.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			err := client.conn.WriteMessage(websocket.TextMessage, message)
			if err != nil {
				go m.Unregister(client)
			}
		}(c)
	}
}

// SendTo 向指定客户端发送消息
func (m *WSManager) SendTo(sessionID string, message []byte) {
	m.mu.RLock()
	client, ok := m.clients[sessionID]
	m.mu.RUnlock()
	if !ok || !client.authorized {
		return
	}

	go func(c *Client) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.ctx.Err() != nil {
			return
		}
		_ = c.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = c.conn.WriteMessage(websocket.TextMessage, message)
	}(client)
}

// BroadcastToUser 向指定用户名的所有已授权客户端广播消息
// 同一用户可能有多端连接（LAN/WAN/多标签页），全部接收以保证多端同步
func (m *WSManager) BroadcastToUser(username string, message []byte, excludeSessionID string) {
	if username == "" {
		return
	}
	m.mu.RLock()
	clients := make([]*Client, 0)
	for id, c := range m.clients {
		if id == excludeSessionID {
			continue
		}
		if c.authorized && c.username == username {
			clients = append(clients, c)
		}
	}
	m.mu.RUnlock()

	for _, c := range clients {
		go func(client *Client) {
			client.mu.Lock()
			defer client.mu.Unlock()
			if client.ctx.Err() != nil {
				return
			}
			_ = client.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			err := client.conn.WriteMessage(websocket.TextMessage, message)
			if err != nil {
				go m.Unregister(client)
			}
		}(c)
	}
}

// Count 返回当前连接数
func (m *WSManager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.clients)
}
