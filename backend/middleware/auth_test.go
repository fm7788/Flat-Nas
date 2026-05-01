package middleware

import (
	"net/http/httptest"
	"testing"

	"flatnasgo-backend/config"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func TestParseTokenRejectsUnexpectedAlg(t *testing.T) {
	gin.SetMode(gin.TestMode)
	config.SecretKey = []byte("test-secret")

	token := jwt.NewWithClaims(jwt.SigningMethodHS512, jwt.MapClaims{
		"username": "admin",
	})
	signed, err := token.SignedString([]byte(config.GetSecretKeyString()))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+signed)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	parsed, err := parseToken(c)
	if err != nil {
		return
	}
	if parsed != nil && parsed.Valid {
		t.Fatalf("expected invalid token, got valid token")
	}
}

func TestParseTokenAcceptsHS256(t *testing.T) {
	gin.SetMode(gin.TestMode)
	config.SecretKey = []byte("test-secret")

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"username": "admin",
	})
	signed, err := token.SignedString([]byte(config.GetSecretKeyString()))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+signed)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req

	parsed, err := parseToken(c)
	if err != nil || parsed == nil || !parsed.Valid {
		t.Fatalf("expected valid token, got err=%v", err)
	}
}
