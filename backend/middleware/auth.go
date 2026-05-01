package middleware

import (
	"flatnasgo-backend/config"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func parseToken(c *gin.Context) (*jwt.Token, error) {
	tokenString := c.GetHeader("Authorization")
	if tokenString == "" {
		tokenString = c.Query("token")
	} else {
		tokenString = strings.TrimPrefix(tokenString, "Bearer ")
	}

	if tokenString == "" {
		return nil, nil
	}

	return jwt.Parse(
		tokenString,
		func(token *jwt.Token) (interface{}, error) {
			return []byte(config.GetSecretKeyString()), nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
}

func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		token, err := parseToken(c)

		if err != nil || token == nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}

		if claims, ok := token.Claims.(jwt.MapClaims); ok {
			c.Set("username", claims["username"])
		}
		c.Next()
	}
}

func OptionalAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		token, err := parseToken(c)

		if err == nil && token != nil && token.Valid {
			if claims, ok := token.Claims.(jwt.MapClaims); ok {
				c.Set("username", claims["username"])
			}
		}
		c.Next()
	}
}
