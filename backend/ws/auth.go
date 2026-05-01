package ws

import (
	"flatnasgo-backend/config"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// validateJWT 验证 JWT token，返回 username
func validateJWT(tokenStr string) (string, bool) {
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
