package handlers

import (
	"strings"
	"time"

	"flatnasgo-backend/config"

	"github.com/golang-jwt/jwt/v5"
	socketio "github.com/googollee/go-socket.io"
)

const socketUserRoomPrefix = "user:"

func SocketUserRoom(username string) string {
	username = strings.TrimSpace(username)
	if username == "" {
		return ""
	}
	return socketUserRoomPrefix + username
}

func socketConnUsername(s socketio.Conn) string {
	if s == nil {
		return ""
	}
	if username, ok := s.Context().(string); ok {
		return strings.TrimSpace(username)
	}
	return ""
}

func bindSocketUserRoom(s socketio.Conn, username string) bool {
	room := SocketUserRoom(username)
	if room == "" {
		return false
	}
	if socketConnUsername(s) != username {
		s.SetContext(username)
	}
	hasRoom := false
	for _, existing := range s.Rooms() {
		if existing == room {
			hasRoom = true
			break
		}
	}
	if !hasRoom {
		s.Join(room)
	}
	return true
}

func AuthorizeSocketConn(s socketio.Conn, token string) (string, bool) {
	username, ok := validateSocketToken(token)
	if !ok {
		return "", false
	}
	if !bindSocketUserRoom(s, username) {
		return "", false
	}
	return username, true
}

type MemoUpdatePayload struct {
	Token    string      `json:"token"`
	WidgetId string      `json:"widgetId"`
	Content  interface{} `json:"content"`
}

type TodoUpdatePayload struct {
	Token    string      `json:"token"`
	WidgetId string      `json:"widgetId"`
	Content  interface{} `json:"content"`
}

func BindMemoHandlers(server *socketio.Server) {
	server.OnEvent("/", "memo:update", func(s socketio.Conn, msg interface{}) {
		token, widgetId, content, ok := parseMemoPayload(msg)
		if !ok {
			return
		}
		username, ok := AuthorizeSocketConn(s, token)
		if !ok {
			return
		}
		server.BroadcastToRoom("/", SocketUserRoom(username), "memo:updated", map[string]interface{}{
			"widgetId": widgetId,
			"content":  content,
			"username": username,
		})
	})
}

func BindTodoHandlers(server *socketio.Server) {
	server.OnEvent("/", "todo:update", func(s socketio.Conn, msg interface{}) {
		token, widgetId, content, ok := parseTodoPayload(msg)
		if !ok {
			return
		}
		username, ok := AuthorizeSocketConn(s, token)
		if !ok {
			return
		}
		server.BroadcastToRoom("/", SocketUserRoom(username), "todo:updated", map[string]interface{}{
			"widgetId": widgetId,
			"content":  content,
			"username": username,
		})
	})
}

type NetworkModePayload struct {
	Token string `json:"token"`
	Mode  string `json:"mode"`
}

type NetworkHeartbeatPayload struct {
	Token string `json:"token"`
}

func BindNetworkHandlers(server *socketio.Server) {
	server.OnEvent("/", "network:mode", func(s socketio.Conn, msg interface{}) {
		token, mode, ok := parseNetworkModePayload(msg)
		if !ok {
			return
		}
		username, ok := AuthorizeSocketConn(s, token)
		if !ok {
			return
		}
		if !isValidNetworkMode(mode) {
			return
		}
		server.BroadcastToRoom("/", SocketUserRoom(username), "network:mode", map[string]interface{}{
			"mode":     mode,
			"username": username,
		})
	})
	server.OnEvent("/", "network:heartbeat", func(s socketio.Conn, msg interface{}) {
		token, ok := parseTokenPayload(msg)
		if !ok {
			return
		}
		if _, ok := AuthorizeSocketConn(s, token); !ok {
			return
		}
		s.Emit("network:heartbeat", map[string]interface{}{
			"ts": time.Now().UnixMilli(),
		})
	})
}

func parseMemoPayload(msg interface{}) (string, string, interface{}, bool) {
	switch v := msg.(type) {
	case MemoUpdatePayload:
		if v.WidgetId == "" || v.Content == nil {
			return "", "", nil, false
		}
		return v.Token, v.WidgetId, v.Content, true
	case *MemoUpdatePayload:
		if v == nil || v.WidgetId == "" || v.Content == nil {
			return "", "", nil, false
		}
		return v.Token, v.WidgetId, v.Content, true
	case map[string]interface{}:
		token, _ := v["token"].(string)
		widgetId, _ := v["widgetId"].(string)
		content := v["content"]
		if widgetId == "" || content == nil {
			return "", "", nil, false
		}
		return token, widgetId, content, true
	default:
		return "", "", nil, false
	}
}

func parseTodoPayload(msg interface{}) (string, string, interface{}, bool) {
	switch v := msg.(type) {
	case TodoUpdatePayload:
		if v.WidgetId == "" || v.Content == nil {
			return "", "", nil, false
		}
		return v.Token, v.WidgetId, v.Content, true
	case *TodoUpdatePayload:
		if v == nil || v.WidgetId == "" || v.Content == nil {
			return "", "", nil, false
		}
		return v.Token, v.WidgetId, v.Content, true
	case map[string]interface{}:
		token, _ := v["token"].(string)
		widgetId, _ := v["widgetId"].(string)
		content := v["content"]
		if widgetId == "" || content == nil {
			return "", "", nil, false
		}
		return token, widgetId, content, true
	default:
		return "", "", nil, false
	}
}

func parseNetworkModePayload(msg interface{}) (string, string, bool) {
	switch v := msg.(type) {
	case NetworkModePayload:
		if v.Mode == "" {
			return "", "", false
		}
		return v.Token, v.Mode, true
	case *NetworkModePayload:
		if v == nil || v.Mode == "" {
			return "", "", false
		}
		return v.Token, v.Mode, true
	case map[string]interface{}:
		token, _ := v["token"].(string)
		mode, _ := v["mode"].(string)
		if mode == "" {
			return "", "", false
		}
		return token, mode, true
	default:
		return "", "", false
	}
}

func parseTokenPayload(msg interface{}) (string, bool) {
	switch v := msg.(type) {
	case NetworkHeartbeatPayload:
		if v.Token == "" {
			return "", false
		}
		return v.Token, true
	case *NetworkHeartbeatPayload:
		if v == nil || v.Token == "" {
			return "", false
		}
		return v.Token, true
	case map[string]interface{}:
		token, _ := v["token"].(string)
		if token == "" {
			return "", false
		}
		return token, true
	default:
		return "", false
	}
}

func isValidNetworkMode(mode string) bool {
	switch mode {
	case "auto", "lan", "wan", "latency":
		return true
	default:
		return false
	}
}

func validateSocketToken(tokenStr string) (string, bool) {
	if tokenStr == "" {
		return "", false
	}
	tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")
	tok, err := jwt.Parse(
		tokenStr,
		func(token *jwt.Token) (interface{}, error) {
			return []byte(config.GetSecretKeyString()), nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
	if err != nil || tok == nil || !tok.Valid {
		return "", false
	}
	if claims, ok := tok.Claims.(jwt.MapClaims); ok {
		if username, ok := claims["username"].(string); ok && username != "" {
			return username, true
		}
	}
	return "", false
}
